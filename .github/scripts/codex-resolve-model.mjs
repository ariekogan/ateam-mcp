#!/usr/bin/env node
/**
 * Resolve the review model + reasoning effort for the Codex architecture review,
 * loudly and reproducibly. NEVER silently downgrades to a weaker model.
 *
 * Priority (unless OPENAI_REVIEW_MODEL is set explicitly):
 *   1. gpt-5.5-pro        (default for ADAS — accuracy over latency/cost)
 *   2. gpt-5.5            (latest flagship reasoning)
 *   3. latest Codex model (any available id matching OPENAI_REVIEW_CODEX_REGEX)
 *   4. FAIL with an explicit error — do NOT fall back to gpt-4o or anything weaker.
 *
 * To upgrade the model later, change ONLY the `OPENAI_REVIEW_MODEL` repo variable
 * (or edit DEFAULT_PRIORITY below). No workflow code change required.
 *
 * Env:
 *   OPENAI_API_KEY                 (required) used to query /v1/models
 *   OPENAI_REVIEW_MODEL            (optional) explicit model; if set, it wins
 *   OPENAI_REVIEW_CODEX_REGEX      (optional) regex for the codex tier (default "codex")
 *   OPENAI_REVIEW_MODEL_SKIP_VERIFY(optional) "1" to trust OPENAI_REVIEW_MODEL without
 *                                   checking /v1/models (use if the models endpoint
 *                                   under-reports availability). Never enables gpt-4o.
 *   OPENAI_REASONING_EFFORT        (optional) default "high" (use highest practical)
 *   OPENAI_BASE_URL                (optional) default https://api.openai.com/v1
 *   Logging context: GITHUB_REPOSITORY, PR_NUMBER, REVIEW_MODE, AGENT_VERSION, CODEX_VERSION
 *   GITHUB_OUTPUT, GITHUB_STEP_SUMMARY (set by Actions)
 */
import fs from 'node:fs';

const {
  OPENAI_API_KEY,
  OPENAI_REVIEW_MODEL = '',
  OPENAI_REVIEW_CODEX_REGEX = 'codex',
  OPENAI_REVIEW_MODEL_SKIP_VERIFY = '',
  OPENAI_REASONING_EFFORT = 'high',
  OPENAI_BASE_URL = 'https://api.openai.com/v1',
  GITHUB_REPOSITORY = '(unknown repo)',
  PR_NUMBER = '(none)',
  REVIEW_MODE = 'codex-architecture-review',
  AGENT_VERSION = '(unset)',
  CODEX_VERSION = '(action default)',
  GITHUB_OUTPUT,
  GITHUB_STEP_SUMMARY,
} = process.env;

// Preferred models, best first. Never include gpt-4o or any non-reasoning model.
//
// COST NOTE: gpt-5.5-pro is many times the price of gpt-5.5 and re-explores the
// repo on EVERY run — running it as the default drained ~$80 in minutes. So the
// default tier is now gpt-5.5, and pro is used only for ESCALATED reviews
// (REVIEW_TIER=deep — high-risk paths, or a re-run after a cheap pass found
// blocking issues). Override either with the OPENAI_REVIEW_MODEL repo variable.
const DEFAULT_PRIORITY = ['gpt-5.5', 'gpt-5.5-pro'];
const DEEP_PRIORITY = ['gpt-5.5-pro', 'gpt-5.5'];
// Models we must never auto-select, even if present.
const FORBIDDEN = [/^gpt-4o/i, /^gpt-4-/i, /^gpt-3/i, /^chatgpt-4o/i];

function fail(msg) {
  console.error(`::error title=Codex review model resolution failed::${msg}`);
  process.exit(1);
}
function out(k, v) {
  if (GITHUB_OUTPUT) fs.appendFileSync(GITHUB_OUTPUT, `${k}=${v}\n`);
}
const forbidden = (id) => FORBIDDEN.some((re) => re.test(id));

async function listModels() {
  const res = await fetch(`${OPENAI_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
  });
  if (!res.ok) {
    throw new Error(`GET /models -> ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
  }
  const data = await res.json();
  return new Set((data.data || []).map((m) => m.id));
}

async function main() {
  if (!OPENAI_API_KEY) fail('OPENAI_API_KEY is not set.');

  let model = '';
  let resolvedFrom = '';

  const skipVerify = /^(1|true|yes)$/i.test(OPENAI_REVIEW_MODEL_SKIP_VERIFY);

  if (OPENAI_REVIEW_MODEL) {
    if (forbidden(OPENAI_REVIEW_MODEL)) {
      fail(`OPENAI_REVIEW_MODEL="${OPENAI_REVIEW_MODEL}" is a forbidden weak model for architecture review.`);
    }
    if (skipVerify) {
      model = OPENAI_REVIEW_MODEL;
      resolvedFrom = 'OPENAI_REVIEW_MODEL (verification skipped)';
    } else {
      let available;
      try { available = await listModels(); }
      catch (e) { fail(`Could not verify model availability: ${e.message}. Set OPENAI_REVIEW_MODEL_SKIP_VERIFY=1 to bypass if you are sure the model exists.`); }
      if (!available.has(OPENAI_REVIEW_MODEL)) {
        fail(`Configured OPENAI_REVIEW_MODEL="${OPENAI_REVIEW_MODEL}" is NOT available to this API key. Refusing to downgrade. Pick an available model or set OPENAI_REVIEW_MODEL_SKIP_VERIFY=1.`);
      }
      model = OPENAI_REVIEW_MODEL;
      resolvedFrom = 'OPENAI_REVIEW_MODEL (verified)';
    }
  } else {
    let available;
    try { available = await listModels(); }
    catch (e) { fail(`Could not query available models to resolve the default review model: ${e.message}`); }

    // REVIEW_TIER=deep escalates to the pro model; anything else uses the cheap default.
    const deep = /^(deep|pro|escalate)$/i.test(process.env.REVIEW_TIER || '');
    const priority = deep ? DEEP_PRIORITY : DEFAULT_PRIORITY;
    for (const cand of priority) {
      if (available.has(cand) && !forbidden(cand)) { model = cand; resolvedFrom = `${deep ? 'DEEP' : 'default'} priority (${cand})`; break; }
    }
    if (!model) {
      // Codex tier: newest id matching the codex regex (lexical max as a proxy for "latest").
      const re = new RegExp(OPENAI_REVIEW_CODEX_REGEX, 'i');
      const codexModels = [...available].filter((id) => re.test(id) && !forbidden(id)).sort();
      if (codexModels.length) { model = codexModels[codexModels.length - 1]; resolvedFrom = `codex tier (${model})`; }
    }
    if (!model) {
      fail(`None of the preferred review models are available (${DEFAULT_PRIORITY.join(', ')}, or /${OPENAI_REVIEW_CODEX_REGEX}/). Refusing to fall back to a weaker model such as gpt-4o. Set OPENAI_REVIEW_MODEL to an available strong reasoning model.`);
    }
  }

  // Effort: default 'medium' (cost). Escalated (deep) reviews use 'high'.
  // OPENAI_REASONING_EFFORT overrides both.
  const deepTier = /^(deep|pro|escalate)$/i.test(process.env.REVIEW_TIER || '');
  const effort = OPENAI_REASONING_EFFORT || (deepTier ? 'high' : 'medium');

  // Reproducibility banner — logged at the start of every review.
  const banner = [
    '════════ ADAS Codex Architecture Review ════════',
    `agent_version : ${AGENT_VERSION}`,
    `review_mode   : ${REVIEW_MODE}`,
    `repository    : ${GITHUB_REPOSITORY}`,
    `pr_number     : ${PR_NUMBER}`,
    `model         : ${model}`,
    `resolved_from : ${resolvedFrom}`,
    `reasoning     : ${effort}`,
    `codex_version : ${CODEX_VERSION}`,
    '═══════════════════════════════════════════════',
  ].join('\n');
  console.log(banner);
  if (GITHUB_STEP_SUMMARY) fs.appendFileSync(GITHUB_STEP_SUMMARY, '```\n' + banner + '\n```\n');

  out('model', model);
  out('effort', effort);
  out('resolved_from', resolvedFrom);
}

main().catch((e) => fail(e.stack || e.message));

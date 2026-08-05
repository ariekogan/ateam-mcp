#!/usr/bin/env node
/**
 * Report what one review slice cost.
 *
 *   node .github/scripts/capture-spend.mjs <scan-dir> [verdict.json]
 *
 * Both agents report usage, but they report it NESTED: a run-level
 * `total_cost_usd` alongside a `usage` object that breaks the same money down per
 * turn. Recursively summing every cost-like key therefore counts the total AND its
 * own breakdown — the first version of this did exactly that and inflated the
 * figure it existed to make trustworthy.
 *
 * So: per file, take the SHALLOWEST depth at which any cost key appears and sum
 * only that depth, never descending past it. Across files, take the MAX rather
 * than the sum — one agent runs per slice, so several files describing it are
 * several views of the same money, not more money.
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2] || process.env.RUNNER_TEMP || '/tmp';
const VERDICT = process.argv[3] || 'codex-review-output.json';

const USD = /^(total_)?cost(_usd)?$|^total_cost_usd$|^costUSD$/i;
// The agents do NOT emit a single `tokens` field. Claude reports
// input_tokens/output_tokens (+ cache_creation/cache_read variants) inside a
// `usage` object; Codex reports total_token_usage / prompt_tokens / completion_
// tokens. Matching only /^(total_)?tokens?(_used)?$/ therefore reported nothing
// for the shapes that actually occur — the field existed and was always empty.
// Match ANY key ending in `token`/`tokens` rather than enumerating qualifiers:
// the enumeration missed `cache_read_input_tokens`, which carries two of them.
const TOK = /(^|_)tokens?$/i;
// A run total, when present, must win over its own component parts.
const TOK_TOTAL = /^(total_tokens?|total_token_usage|tokens_used)$/i;

// Shallowest depth carrying a match, summed at that depth only.
function shallowest(root, re) {
  let queue = [root];
  while (queue.length) {
    const next = [];
    let sum = null;
    for (const node of queue) {
      if (!node || typeof node !== 'object') continue;
      for (const [k, v] of Object.entries(node)) {
        if (re.test(k) && typeof v === 'number') sum = (sum || 0) + v;
        // A matching key whose value is an OBJECT (`usage: {...}`, `cost: {...}`)
        // is a container, not a figure. Short-circuiting descent there dropped
        // every nested shape — the common case for both agents.
        else if (v && typeof v === 'object') next.push(v);
      }
    }
    if (sum !== null) return sum;   // a real number at this depth — do not descend
    queue = next;
  }
  return null;
}

// Prefer an explicit run total; fall back to summing the components.
const tokensOf = (json) => {
  const total = shallowest(json, TOK_TOTAL);
  return total !== null ? total : shallowest(json, TOK);
};

let usd = null, tokens = null;
let files = [];
try {
  files = fs.readdirSync(DIR).filter((f) => /\.json$/.test(f)).map((f) => path.join(DIR, f));
} catch { /* nothing to scan */ }

for (const f of files) {
  let json;
  try { json = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
  const u = shallowest(json, USD);
  const t = tokensOf(json);
  if (u !== null) usd = usd === null ? u : Math.max(usd, u);
  if (t !== null) tokens = tokens === null ? t : Math.max(tokens, t);
}

const parts = [];
if (usd !== null) parts.push('$' + usd.toFixed(4));
if (tokens !== null) parts.push(tokens.toLocaleString() + ' tokens');
const text = parts.length ? parts.join(' · ') : 'usage not reported';
console.log('slice cost: ' + text);

try {
  const v = JSON.parse(fs.readFileSync(VERDICT, 'utf8'));
  v._cost = { usd, tokens, text };
  fs.writeFileSync(VERDICT, JSON.stringify(v, null, 2));
} catch { /* no verdict to stamp — the caller reports that separately */ }

if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n**slice cost:** ${text}\n`);
}

#!/usr/bin/env node
/**
 * Pick ONLY the review-rule files relevant to the changed paths.
 *
 *   node .github/scripts/codex-select-rules.mjs <from> <to>
 *
 * Why: we were handing the agent ~1,100 lines of rules + CLAUDE.md + the
 * architecture map on EVERY review. At pro tier that context is re-reasoned each
 * turn, so a docs/CI slice cost ~$20. Rules that cannot apply to the diff are pure
 * burn — e.g. VOICE_REALTIME on a change that never touches apps/voice.
 * ARCHITECTURE_BOUNDARIES is always included: it is the short scoped summary.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const [FROM, TO] = process.argv.slice(2);
const files = execFileSync('git', ['diff', '--name-only', `${FROM}..${TO}`], { encoding: 'utf8' })
  .split('\n').filter(Boolean);

const has = (re) => files.some((f) => re.test(f));
const RULES = [
  ['ARCHITECTURE_BOUNDARIES.md', () => true],
  ['ADAS_ARCHITECTURE.md',   () => has(/^(apps|connectors|packages)\//)],
  ['SECURITY.md',            () => has(/^(apps\/backend\/(security|middleware|storage|routes)|connectors|apps\/[^/]+\/src\/(server|http|auth))/) || has(/auth|token|secret|tenant/i)],
  ['CONCURRENCY_AND_STATE.md', () => has(/^apps\/backend\/(worker|storage|ai|utils)\//) || has(/^apps\/(acs|trigger-runner)\//)],
  ['COST_ACCOUNTING.md',     () => has(/^apps\/backend\/ai\//) || has(/usage|pricing|token|llm/i)],
  ['VOICE_REALTIME.md',      () => has(/^apps\/voice\//)],
];

const picked = RULES.filter(([, want]) => want()).map(([f]) => f)
  .filter((f) => fs.existsSync(`.github/review-rules/${f}`));
console.log(picked.map((f) => `.github/review-rules/${f}`).join('\n'));

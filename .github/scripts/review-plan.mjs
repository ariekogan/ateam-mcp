#!/usr/bin/env node
/**
 * What would a review actually DO — across every CORE repo — before a penny is spent.
 *
 *   node .github/scripts/review-plan.mjs            # all repos, claude pricing
 *   node .github/scripts/review-plan.mjs codex      # codex slice size
 *   node .github/scripts/review-plan.mjs --repo ariekogan/ateam-mcp
 *
 * Asking "please review" used to be an act of faith: no way to see how many repos
 * were involved, how much had piled up since the last checkpoint, how many slices
 * that would become, or roughly what it would cost — until the bill. This prints
 * that table up front.
 *
 * It reads GitHub directly (compare API + the `codex-reviewed` tag), so it needs no
 * local clone of any repo and is safe to run any time — it spends nothing.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const REVIEWER = args.find((a) => a === 'codex' || a === 'claude') || 'claude';
const only = args.includes('--repo') ? args[args.indexOf('--repo') + 1] : null;

// Slice size mirrors codex-review-since.sh: Claude explores per-turn and has a hard
// turn cap, so it needs smaller slices than Codex.
const CHUNK = REVIEWER === 'claude' ? 250 : 400;
// Observed averages over ~15 real slices in ai-dev-assistant. A slice that triage
// judges risk-free costs nothing, which is why the estimate is a range, not a figure.
const USD_PER_SLICE = REVIEWER === 'claude' ? 3.5 : 2.5;

const gh = (a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

let REG;
for (const p of ['.github/review-repos.json', '._aip/.github/review-repos.json']) {
  try { REG = JSON.parse(fs.readFileSync(p, 'utf8')); break; } catch {}
}
if (!REG) { console.error('❌ .github/review-repos.json not found'); process.exit(1); }

const MARKER = 'codex-reviewed';

async function plan(entry) {
  const { repo } = entry;
  const row = { repo, what: entry.what, commits: 0, insertions: 0, slices: 0, note: '' };

  let head, branch = entry.branch;
  try {
    // The branch is PINNED in review-repos.json. Deriving it ("dev if it exists")
    // picked ateam-mcp's abandoned dev — 94 behind main, 0 ahead — so a review
    // there would have covered nothing while looking like it covered everything.
    if (!branch) branch = gh(['api', `repos/${repo}`, '--jq', '.default_branch']).trim();
    row.branch = branch;
    head = gh(['api', `repos/${repo}/commits/${branch}`, '--jq', '.sha']).trim();
  } catch (e) {
    row.note = 'repo/branch unreachable';
    return row;
  }

  let base;
  try {
    base = gh(['api', `repos/${repo}/git/ref/tags/${MARKER}`, '--jq', '.object.sha']).trim();
  } catch {
    row.note = 'NEVER REVIEWED — set a marker first';
    return row;
  }

  if (base === head) { row.note = 'up to date'; return row; }

  try {
    // One compare call gives commits AND per-file additions — no clone needed.
    const cmp = JSON.parse(gh(['api', `repos/${repo}/compare/${base}...${head}`,
      '--jq', '{commits: (.commits|length), additions: ([.files[]?.additions] | add // 0), status: .status}']));
    if (cmp.status === 'diverged' || cmp.status === 'behind') {
      row.note = `marker ${cmp.status} — would refuse (reversed diff)`;
      return row;
    }
    row.commits = cmp.commits;
    row.insertions = cmp.additions;
    row.slices = Math.max(1, Math.ceil(cmp.additions / CHUNK));
  } catch (e) {
    // A range too large for one compare call still deserves an honest answer.
    row.note = 'compare failed (range too large?)';
  }
  return row;
}

const rows = [];
for (const e of REG.repos) {
  if (only && e.repo !== only) continue;
  rows.push(await plan(e));
}

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const W = Math.max(...rows.map((r) => r.repo.length), 6);

console.log(`\nReview plan — reviewer: ${REVIEWER}  (slice ≈ ${CHUNK} insertions)\n`);
console.log(`  ${pad('REPO', W)}  ${pad('BRANCH', 7)} ${lpad('COMMITS', 7)} ${lpad('INSERT', 7)} ${lpad('SLICES', 6)}  NOTE`);
console.log(`  ${'─'.repeat(W)}  ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(6)}  ${'─'.repeat(34)}`);

let totalSlices = 0, totalCommits = 0, anyWork = false;
for (const r of rows) {
  totalSlices += r.slices; totalCommits += r.commits;
  if (r.slices) anyWork = true;
  console.log(`  ${pad(r.repo, W)}  ${pad(r.branch || '?', 7)} ${lpad(r.commits || '-', 7)} ${lpad(r.insertions || '-', 7)} ${lpad(r.slices || '-', 6)}  ${r.note}`);
}
console.log(`  ${'─'.repeat(W)}  ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(6)}`);
console.log(`  ${pad('TOTAL', W)}  ${pad('', 7)} ${lpad(totalCommits, 7)} ${lpad('', 7)} ${lpad(totalSlices, 6)}`);

if (anyWork) {
  const lo = (totalSlices * USD_PER_SLICE * 0.6).toFixed(0);
  const hi = (totalSlices * USD_PER_SLICE * 1.3).toFixed(0);
  console.log(`\n  Rough cost: $${lo}–$${hi} (~$${USD_PER_SLICE}/slice observed; docs-only slices are skipped by triage at $0)`);
  console.log(`  The marker is banked after each slice — a failure costs only the slice it died on.\n`);
} else {
  console.log('\n  Nothing to review.\n');
}

// Anything needing a decision before spending, said plainly.
const never = rows.filter((r) => r.note.startsWith('NEVER'));
if (never.length) console.log(`  ⚠️  ${never.length} repo(s) have no marker — their first review would cover ALL history. Set one:\n      .github/scripts/codex-review-since.sh --from <sha>\n`);
const bad = rows.filter((r) => /diverged|behind|unreachable|failed/.test(r.note));
if (bad.length) console.log(`  ⚠️  ${bad.map((r) => r.repo).join(', ')} need attention before a review will run.\n`);

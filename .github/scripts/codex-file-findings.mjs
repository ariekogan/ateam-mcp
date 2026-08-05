#!/usr/bin/env node
/**
 * File Codex review findings as GitHub issues, ONE PER AREA — automatically, from
 * the workflow, with no agent in the loop.
 *
 *   node .github/scripts/codex-file-findings.mjs <verdict.json> [--range a..b] [--dry]
 *
 * Why this exists: routing findings into the right chat session can only be done by
 * an assistant (it is an MCP call). That made dispatch depend on someone being
 * around — findings could silently go nowhere. GitHub issues are the durable,
 * agent-independent channel: any session asks
 *     gh issue list --label area:voice --state open
 * and sees exactly what it owns.
 *
 * RELIABILITY REQUIREMENTS (deliberate):
 *  - IDEMPOTENT: a stable fingerprint per finding (area+file+line+title). Re-running
 *    the same review never creates duplicates; already-filed findings are skipped.
 *  - APPEND, don't lose: if an area issue is already open, new findings are added as
 *    a comment rather than silently dropped.
 *  - FAIL LOUD: any GitHub API failure exits non-zero with the reason. Silently
 *    "filing nothing" is the failure mode this whole thing exists to prevent.
 *  - NEVER blocks the review: the caller decides whether to fail the job.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const FILE = args.find((a) => !a.startsWith('--'));
const DRY = args.includes('--dry');
const rangeIdx = args.indexOf('--range');
const RANGE = rangeIdx >= 0 ? args[rangeIdx + 1] : '';
if (!FILE) { console.error('usage: codex-file-findings.mjs <verdict.json> [--range a..b] [--dry]'); process.exit(1); }

const gh = (a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const REPO = process.env.GITHUB_REPOSITORY
  || JSON.parse(gh(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;

// ---- area map (same source of truth the session dispatcher uses) -------------
let MAP;
for (const p of ['.github/review-areas.json', '._aip/.github/review-areas.json']) {
  try { MAP = JSON.parse(fs.readFileSync(p, 'utf8')); break; } catch {}
}
if (!MAP) { console.error('❌ review-areas.json not found — cannot route findings'); process.exit(1); }
const areaFor = (file) => {
  if (!file) return MAP.fallback_area;
  for (const a of MAP.areas) if (a.patterns.some((p) => file.includes(p))) return a.area;
  return MAP.fallback_area;
};

// ---- read the verdict -------------------------------------------------------
let v;
try { v = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
catch (e) { console.error(`❌ cannot read verdict ${FILE}: ${e.message}`); process.exit(1); }
if (v.incomplete) { console.log('verdict is INCOMPLETE — nothing to file'); process.exit(0); }

// A finding is ONE task-list item, and a task-list item is ONE line-anchored block.
// Any raw newline inside evidence/impact/title therefore started a new markdown
// line that is not part of the bullet — which put the `id:` marker under a
// DIFFERENT bullet, so `codex-finding.sh done` ticked the wrong checkbox. Collapse
// newlines to spaces; the text is unchanged, only its line structure.
const flat = (x) => String(x ?? '').replace(/\r?\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();

// LOW-severity non-blocking findings are NOT filed. They still appear in the review
// artifact and the run summary — they are just not tracked as work, because tracking
// them produced a backlog nobody would ever drain: 54 of 98 open findings were `low`,
// and the pipeline added more every review than anyone removed. A tracker that
// everyone learns to ignore protects nothing. Blocking findings are filed whatever
// their severity — "blocking" is the reviewer saying it must not ship.
// Set FILE_LOW_FINDINGS=1 to file them anyway.
const FILE_LOW = process.env.FILE_LOW_FINDINGS === '1';
const isLow = (f) => /^low$/i.test(String(f.severity || ''));

const blocking = (v.blocking_findings || []).map((f) => ({ ...f, blocking: true }));
const nonBlocking = (v.non_blocking_findings || []).map((f) => ({ ...f, blocking: false }));
const droppedLow = FILE_LOW ? [] : nonBlocking.filter(isLow);
const all = [...blocking, ...(FILE_LOW ? nonBlocking : nonBlocking.filter((f) => !isLow(f)))];

// Never silent: a dropped finding that nobody is told about is the same as a lost one.
if (droppedLow.length) {
  console.log(`not filed (low severity, non-blocking — see the review artifact): ${droppedLow.length}`);
  for (const f of droppedLow) console.log(`  · ${f.file}${f.line ? ':' + f.line : ''} — ${flat(f.title)}`);
}
if (!all.length) { console.log('no findings to file'); process.exit(0); }

// Stable per-finding fingerprint → idempotency across re-runs.
//
// AREA IS DELIBERATELY NOT PART OF IT. It used to be, and that made the id a
// function of the routing rather than of the defect: the same finding filed once
// as `unassigned` and again — after the area map improved — as `core-engine` got
// two different ids in two different issues, so a `skip`/`done` recorded on one
// never marked the other and the finding kept resurfacing (reported 2026-08-03,
// agentBudget.js:98 living in both #49 and #51). A finding is the same finding
// wherever it is filed.
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
const fp = (f) => sha(`${f.file}|${f.line}|${flat(f.title)}`);
// Ids minted before the change above still sit in open issues. Recognise them so
// the first run after this fix does not re-file everything under fresh ids.
const legacyFps = (f) => MAP.areas.map((a) => sha(`${a.area}|${f.file}|${f.line}|${flat(f.title)}`))
  .concat(sha(`${MAP.fallback_area}|${f.file}|${f.line}|${flat(f.title)}`));

const byArea = new Map();
for (const f of all) {
  const a = areaFor(f.file);
  if (!byArea.has(a)) byArea.set(a, []);
  byArea.get(a).push(f);
}

// Rendered as a GitHub task-list item so each finding has its OWN status: a
// session ticks the box for the one it fixed. Closing the whole issue would mark
// every finding done when only one was.
const render = (f) => `- [ ] ${f.blocking ? '🔴 **BLOCKING**' : '🟡 non-blocking'} · \`${flat(f.severity) || 'n/a'}\` · \`${flat(f.file)}${f.line ? ':' + f.line : ''}\`
  **${flat(f.title)}**
  ${flat(f.impact) ? `_Impact:_ ${flat(f.impact)}` : ''}
  ${flat(f.evidence) ? `_Evidence:_ ${flat(f.evidence)}` : ''}
  ${flat(f.required_change) ? `_Fix:_ ${flat(f.required_change)}` : ''}
  <sub>id: \`${fp(f)}\`</sub>`;

// A finding already filed ANYWHERE must not be filed again. Scanning only the
// current area's issue was the second half of the duplicate bug: routing decides
// which issue a finding lands in, so a re-route silently created a twin.
const idsIn = (text) => (text || '').match(/id: `([0-9a-f]{10})`/g)?.map((m) => m.slice(5, 15)) || [];
const KNOWN = new Set();
try {
  const issues = JSON.parse(gh(['issue', 'list', '--repo', REPO, '--state', 'open',
    '--json', 'number,body,labels', '--limit', '200']))
    .filter((i) => (i.labels || []).some((l) => l.name.startsWith('area:')));
  for (const i of issues) {
    idsIn(i.body).forEach((x) => KNOWN.add(x));
    const cs = JSON.parse(gh(['issue', 'view', String(i.number), '--repo', REPO, '--json', 'comments']));
    for (const c of cs.comments || []) idsIn(c.body).forEach((x) => KNOWN.add(x));
  }
  console.log(`known findings across ${issues.length} open area issue(s): ${KNOWN.size}`);
} catch (e) {
  // Fail loud: filing on a partial known-set is how duplicates get created.
  console.error(`\u274c cannot read existing findings — refusing to file (would duplicate): ${String(e.message).split('\n')[0]}`);
  process.exit(1);
}
const isKnown = (f) => KNOWN.has(fp(f)) || legacyFps(f).some((x) => KNOWN.has(x));

let filed = 0, appended = 0, skipped = 0, failures = 0;

for (const [area, list] of byArea) {
  const label = `area:${area}`;
  const meta = MAP.areas.find((x) => x.area === area);
  try {
    // label must exist for the per-area query to work
    try { gh(['label', 'create', label, '--repo', REPO, '--color', 'BFD4F2',
      '--description', `Codex review findings — ${meta?.description || area}`]); } catch {}

    // Existing OPEN issue for this area (one rolling issue per area).
    const open = JSON.parse(gh(['issue', 'list', '--repo', REPO, '--label', label,
      '--state', 'open', '--json', 'number,body', '--limit', '1']));
    const existing = open[0];

    // Dedup WITHIN this batch too. KNOWN was a snapshot taken before filing, so two
    // slices reporting the same defect in one run both passed the check and were
    // filed twice with identical ids — and an identical id means ticking one box
    // cannot distinguish them.
    const fresh = [];
    for (const f of list) {
      if (isKnown(f)) continue;
      KNOWN.add(fp(f));        // claim it immediately, before anything is written
      fresh.push(f);
    }
    skipped += list.length - fresh.length;
    if (!fresh.length) { console.log(`  ${area}: nothing new (${list.length} already filed)`); continue; }

    const bodyLines = fresh.map(render).join('\n\n');
    const header = `Codex architecture review${RANGE ? ` of \`${RANGE}\`` : ''} found ${fresh.length} item(s) in **${area}** — ${meta?.description || ''}`;

    if (DRY) { console.log(`  [dry] ${area}: would file ${fresh.length}`); continue; }

    if (existing) {
      gh(['issue', 'comment', String(existing.number), '--repo', REPO,
        '--body', `${header}\n\n${bodyLines}`]);
      console.log(`  ${area}: appended ${fresh.length} to #${existing.number}`);
      appended += fresh.length;
    } else {
      const blocking = fresh.filter((f) => f.blocking).length;
      const title = `Codex findings — ${area} (${fresh.length} item${fresh.length > 1 ? 's' : ''}${blocking ? `, ${blocking} blocking` : ''})`;
      const url = gh(['issue', 'create', '--repo', REPO, '--label', label,
        '--title', title,
        '--body', `${header}\n\n${bodyLines}\n\n---\n<sub>Filed automatically by the Codex review. Close when handled; a later review will open a fresh issue if new findings appear in this area.</sub>`]).trim();
      console.log(`  ${area}: ${url}`);
      filed += fresh.length;
    }
  } catch (e) {
    // Fail loud — a finding that reaches nobody is the exact failure this prevents.
    console.error(`❌ ${area}: could not file findings — ${String(e.message).split('\n')[0]}`);
    failures++;
  }
}

console.log(`filed=${filed} appended=${appended} already-known=${skipped} failures=${failures}`);
if (failures) process.exit(1);

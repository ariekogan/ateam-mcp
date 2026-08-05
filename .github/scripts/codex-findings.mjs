#!/usr/bin/env node
/**
 * Collect a Codex review's findings from a PR and GROUP THEM BY AREA, so each
 * group can be dispatched to the chat session that owns that area.
 *
 *   node .github/scripts/codex-findings.mjs <pr> [--repo owner/name] [--json]
 *   node .github/scripts/codex-findings.mjs --file /tmp/codex-last-findings.json [--json]
 *
 * The --file mode reads a Codex verdict artifact directly. The no-PR range review
 * produces exactly that, and there is no PR to scrape — without this the whole
 * area-dispatch story is unreachable for the normal review flow (review finding).
 *
 * Why: Arie works in several long-lived sessions (CORE, VOICE, MobileApp, …).
 * A review that dumps everything in one place is unusable — he'd never know which
 * session should act. Areas come from FILE PATHS (stable); the session match is
 * resolved live at dispatch time (session names get renamed/deleted), which is
 * done by the assistant, not here.
 *
 * Output (default: human table; --json: machine-readable) —
 *   [{ area, description, session_hints, findings: [{file,line,blocking,title,body,url}] }]
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const PR = args.find((a) => /^\d+$/.test(a));
const JSON_OUT = args.includes('--json');
const repoIdx = args.indexOf('--repo');
const fileIdx = args.indexOf('--file');
const FILE = fileIdx >= 0 ? args[fileIdx + 1] : null;
if (!PR && !FILE) {
  console.error('usage: codex-findings.mjs <pr> [--repo owner/name] [--json]\n       codex-findings.mjs --file <verdict.json> [--json]');
  process.exit(1);
}

const gh = (a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const REPO = FILE ? null : (repoIdx >= 0 ? args[repoIdx + 1]
  : JSON.parse(gh(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner);

// area map — prefer repo copy, fall back to the pinned tools checkout
let MAP;
for (const p of ['.github/review-areas.json', '._aip/.github/review-areas.json']) {
  try { MAP = JSON.parse(fs.readFileSync(p, 'utf8')); break; } catch {}
}
if (!MAP) { console.error('review-areas.json not found'); process.exit(1); }

const areaFor = (file) => {
  if (!file) return MAP.fallback_area;
  for (const a of MAP.areas) if (a.patterns.some((p) => file.includes(p))) return a.area;
  return MAP.fallback_area;
};

function findingsFromFile(path) {
  const v = JSON.parse(fs.readFileSync(path, 'utf8'));
  const mk = (f, blocking) => ({
    file: f.file || '', line: f.line || 0, blocking,
    title: f.title || '', category: f.category || '',
    body: [f.impact && `Impact: ${f.impact}`, f.evidence && `Evidence: ${f.evidence}`,
           f.required_change && `Fix: ${f.required_change}`].filter(Boolean).join('\n\n'),
    url: '',
  });
  return [
    ...(v.blocking_findings || []).map((f) => mk(f, true)),
    ...(v.non_blocking_findings || []).map((f) => mk(f, false)),
  ];
}

// 1. inline review comments (the precise findings)
const comments = FILE ? [] : JSON.parse(gh(['api', '--paginate', `repos/${REPO}/pulls/${PR}/comments`]));
// 2. the review bodies (findings that had no exact changed line)
const reviews = FILE ? [] : JSON.parse(gh(['api', '--paginate', `repos/${REPO}/pulls/${PR}/reviews`]))
  .filter((r) => r.user?.login === 'github-actions[bot]');

const findings = FILE ? findingsFromFile(FILE) : [];
for (const c of comments) {
  if (c.user?.login !== 'github-actions[bot]') continue;
  const body = c.body || '';
  findings.push({
    file: c.path,
    line: c.line ?? c.original_line ?? 0,
    blocking: /BLOCKING/i.test(body),
    title: (body.match(/—\s*(.+)/) || [, body.slice(0, 80)])[1].split('\n')[0].trim(),
    body: body.trim(),
    url: c.html_url,
  });
}

// Findings listed in the review body (not tied to a changed line) — keep them as
// area "unassigned" unless a `path/to/file` is mentioned, so nothing is lost.
const last = reviews[reviews.length - 1];
if (last?.body) {
  for (const line of last.body.split('\n')) {
    const m = line.match(/^\s*-\s*(?:🔴|🟡)?\s*\*\*(?:BLOCKING|non-blocking)?\*\*?\s*·?\s*(.+)/i);
    if (!m) continue;
    const fileM = line.match(/([\w./-]+\.(?:js|mjs|ts|tsx|jsx|json|yml|yaml|md|py))/);
    findings.push({
      file: fileM ? fileM[1] : '',
      line: 0,
      blocking: /BLOCKING/i.test(line),
      title: m[1].replace(/\*\*/g, '').slice(0, 120),
      body: line.trim(),
      url: last.html_url,
    });
  }
}

// group
const byArea = new Map();
for (const f of findings) {
  const a = areaFor(f.file);
  if (!byArea.has(a)) byArea.set(a, []);
  byArea.get(a).push(f);
}
const meta = (a) => MAP.areas.find((x) => x.area === a) || { description: 'unmatched — needs triage', session_hints: [] };
const grouped = [...byArea.entries()]
  .map(([area, fs_]) => ({ area, description: meta(area).description, session_hints: meta(area).session_hints, findings: fs_ }))
  .sort((x, y) => y.findings.filter(f => f.blocking).length - x.findings.filter(f => f.blocking).length);

if (JSON_OUT) { console.log(JSON.stringify(grouped, null, 2)); process.exit(0); }

const SRC = FILE ? FILE : `${REPO}#${PR}`;
if (!grouped.length) { console.log(`No findings in ${SRC}.`); process.exit(0); }
console.log(`Findings from ${SRC}, grouped by area:\n`);
for (const g of grouped) {
  const b = g.findings.filter((f) => f.blocking).length;
  console.log(`■ ${g.area}  (${g.findings.length} finding(s), ${b} blocking) — ${g.description}`);
  if (g.session_hints.length) console.log(`    session hints: ${g.session_hints.join(', ')}`);
  for (const f of g.findings) {
    console.log(`    ${f.blocking ? '🔴' : '🟡'} ${f.file}${f.line ? ':' + f.line : ''} — ${f.title}`);
  }
  console.log('');
}

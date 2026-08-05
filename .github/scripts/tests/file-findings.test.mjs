/**
 * Tests for the finding filer.
 *
 * It exists because this script failed in the worst possible way: a TDZ
 * ReferenceError thrown whenever ANY low-severity finding was present meant that
 * every finding — blocking ones included — was silently never filed. The script
 * had been changed twice, each change tested in isolation, and the combination
 * was never run. These tests run the real binary end to end in --dry mode.
 *
 *   node --test .github/scripts/tests/file-findings.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = '.github/scripts/codex-file-findings.mjs';

const finding = (o) => ({
  file: 'apps/backend/x.js', line: 1, title: 't', severity: 'medium',
  impact: 'i', evidence: 'e', required_change: 'r', ...o,
});

function run(verdict, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-'));
  const f = path.join(dir, 'v.json');
  fs.writeFileSync(f, JSON.stringify(verdict));
  try {
    return execFileSync('node', [SCRIPT, f, '--dry'],
      { encoding: 'utf8', env: { ...process.env, ...env } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a low finding present does not stop the others being filed', () => {
  // The exact shape that used to throw before anything was filed.
  const out = run({
    blocking_findings: [finding({ file: 'apps/backend/a.js', title: 'blocking one', severity: 'high' })],
    non_blocking_findings: [finding({ file: 'apps/backend/b.js', line: 2, title: 'low one', severity: 'low' })],
  });
  assert.match(out, /would file 1/);
  assert.match(out, /not filed \(low severity/);
});

test('a dropped low finding is named, never silently discarded', () => {
  const out = run({
    blocking_findings: [],
    non_blocking_findings: [finding({ file: 'apps/backend/q.js', line: 7, title: 'quiet', severity: 'low' })],
  });
  assert.match(out, /apps\/backend\/q\.js:7 — quiet/);
});

test('a BLOCKING finding is filed even when its severity is low', () => {
  const out = run({
    blocking_findings: [finding({ title: 'blocking but low', severity: 'low' })],
    non_blocking_findings: [],
  });
  assert.match(out, /would file 1/);
});

test('FILE_LOW_FINDINGS=1 restores the old behaviour', () => {
  const out = run({
    blocking_findings: [],
    non_blocking_findings: [finding({ title: 'low', severity: 'low' })],
  }, { FILE_LOW_FINDINGS: '1' });
  assert.match(out, /would file 1/);
});

test('the same finding twice in one batch is filed once', () => {
  const dup = finding({ file: 'apps/backend/d.js', line: 3, title: 'twin' });
  const out = run({ blocking_findings: [dup], non_blocking_findings: [{ ...dup }] });
  assert.match(out, /would file 1/);
});

test('a finding whose text contains newlines still files', () => {
  const out = run({
    blocking_findings: [finding({ title: 'multi\nline', evidence: 'ev\n- [ ] fake bullet' })],
    non_blocking_findings: [],
  });
  assert.match(out, /would file 1/);
});

test('an incomplete verdict files nothing and does not fail', () => {
  const out = run({ incomplete: true, reason: 'timed out' });
  assert.match(out, /INCOMPLETE/);
});

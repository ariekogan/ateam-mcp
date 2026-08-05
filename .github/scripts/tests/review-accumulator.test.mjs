/**
 * Tests for resume-vs-fresh detection.
 *
 * Two wrong versions shipped before these existed, and the second LOOKED right:
 * "the last banked slice's `to` equals this run's baseline" is true on a resume —
 * but equally true after a run that finished, because it banks the marker at its
 * final slice and the next review starts from exactly there. Getting it wrong
 * means a new review silently inherits the previous one's findings and spend.
 *
 *   node --test .github/scripts/tests/review-accumulator.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = '.github/scripts/review-accumulator.mjs';

function withFile(state, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-'));
  const f = path.join(dir, 'acc.json');
  if (state !== null) fs.writeFileSync(f, JSON.stringify(state));
  try { return fn(f); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const mode = (f, from) =>
  execFileSync('node', [SCRIPT, 'mode', from, f], { encoding: 'utf8' }).trim();

const DIED = { slices: [{ from: 'aaa', to: 'bbb' }, { from: 'bbb', to: 'ccc' }] };
const FINISHED = { ...DIED, complete: true };

test('a run that DIED and is picked up at its last banked slice is a resume', () => {
  withFile(DIED, (f) => assert.equal(mode(f, 'ccc'), 'resume'));
});

test('a run that FINISHED is never a resume, even from the very same sha', () => {
  // The case the previous fix got wrong: identical shas, opposite answer.
  withFile(FINISHED, (f) => assert.equal(mode(f, 'ccc'), 'fresh'));
});

test('an unrelated baseline is fresh', () => {
  withFile(DIED, (f) => assert.equal(mode(f, 'zzz'), 'fresh'));
});

test('no accumulator at all is fresh', () => {
  withFile(null, (f) => assert.equal(mode(f, 'ccc'), 'fresh'));
});

test('an empty slice list is fresh', () => {
  withFile({ slices: [] }, (f) => assert.equal(mode(f, 'ccc'), 'fresh'));
});

test('corrupt JSON is fresh, not a crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-'));
  const f = path.join(dir, 'acc.json');
  fs.writeFileSync(f, '{not json');
  try { assert.equal(mode(f, 'ccc'), 'fresh'); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('complete stamps the run so the next review starts fresh', () => {
  withFile(DIED, (f) => {
    assert.equal(mode(f, 'ccc'), 'resume');
    execFileSync('node', [SCRIPT, 'complete', f]);
    assert.equal(mode(f, 'ccc'), 'fresh');
    assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).slices.length, 2, 'findings kept for dispatch');
  });
});

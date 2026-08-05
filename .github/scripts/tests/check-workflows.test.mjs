/**
 * Tests for the duplicate-mapping-key checker that gates every push.
 *
 * It earned them the hard way: it shipped with no tests, and the first review that
 * saw it found a FALSE POSITIVE — a block scalar introduced by a sequence item
 * (`- |`) had its literal text read as mapping keys, so valid YAML was rejected
 * with a claim ("GitHub rejects this with HTTP 422") that was simply untrue.
 * A gate that lies is worse than no gate.
 *
 *   node --test .github/scripts/tests/check-workflows.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = '.github/scripts/check-workflows.mjs';

function check(yaml) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfcheck-'));
  const file = path.join(dir, 'w.yml');
  fs.writeFileSync(file, yaml);
  try {
    const out = execFileSync('node', [SCRIPT, file], { encoding: 'utf8' });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('rejects the real failure: two env: keys on one step', () => {
  const r = check(`jobs:
  j:
    steps:
      - name: s
        env:
          A: 1
        env:
          B: 2
        run: echo hi
`);
  assert.equal(r.ok, false);
  assert.match(r.out, /duplicate key 'env'/);
});

test('accepts a block scalar introduced by a sequence item (- |)', () => {
  const r = check(`x:
  - |
    run: not-a-key
    run: also-not-a-key
`);
  assert.equal(r.ok, true, r.out);
});

test('accepts repeated keys in DIFFERENT list items', () => {
  const r = check(`jobs:
  j:
    steps:
      - name: one
        run: echo 1
      - name: two
        run: echo 2
`);
  assert.equal(r.ok, true, r.out);
});

test('accepts the same key name at different nesting levels', () => {
  const r = check(`env:
  A: 1
jobs:
  j:
    env:
      A: 2
`);
  assert.equal(r.ok, true, r.out);
});

test('ignores text inside a keyed block scalar', () => {
  const r = check(`jobs:
  j:
    steps:
      - run: |
          env: one
          env: two
`);
  assert.equal(r.ok, true, r.out);
});

test('every workflow in this repo passes', () => {
  const out = execFileSync('node', [SCRIPT], { encoding: 'utf8' });
  assert.match(out, /ok\s+\.github\/workflows\//);
});

/**
 * Tests for the per-slice spend report.
 *
 * The number this prints is the one that gets read and believed, and it has been
 * wrong twice: first it summed a run total together with its own per-turn
 * breakdown (roughly double), then the token field silently reported nothing
 * because it matched a key shape neither agent emits. Both are pinned here.
 *
 *   node --test .github/scripts/tests/capture-spend.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = '.github/scripts/capture-spend.mjs';

function spend(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-'));
  for (const [name, obj] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(obj));
  }
  const out = execFileSync('node', [SCRIPT, dir, '/dev/null'], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return out.trim();
}

test('a run total is not added to its own breakdown', () => {
  const out = spend({ 'a.json': {
    total_cost_usd: 6.5882,
    usage: { cost_usd: 4.0, turns: [{ cost_usd: 2.5882 }] },
  } });
  assert.match(out, /\$6\.5882/);
});

test('with no run total, the components are summed', () => {
  const out = spend({ 'a.json': { usage: { turns: [{ cost_usd: 1.5 }, { cost_usd: 2.25 }] } } });
  assert.match(out, /\$3\.7500/);
});

test('two files describing one run report the max, not the sum', () => {
  const out = spend({ 'a.json': { total_cost_usd: 6.0 }, 'b.json': { total_cost_usd: 6.0 } });
  assert.match(out, /\$6\.0000/);
});

test("Claude's real usage shape reports tokens", () => {
  // `usage` is a CONTAINER whose key matches nothing; the numbers are one level in.
  const out = spend({ 'a.json': {
    total_cost_usd: 1.23,
    usage: { input_tokens: 1000, output_tokens: 250, cache_read_input_tokens: 50 },
  } });
  assert.match(out, /1,300 tokens/);   // 1000 + 250 + 50
});

test("Codex's total_token_usage wins over its components", () => {
  const out = spend({ 'a.json': {
    total_token_usage: 5000,
    usage: { prompt_tokens: 4000, completion_tokens: 1000 },
  } });
  assert.match(out, /5,000 tokens/);
});

test('a cost key holding an object does not stop the descent', () => {
  const out = spend({ 'a.json': { cost: { total_cost_usd: 2.5 } } });
  assert.match(out, /\$2\.5000/);
});

test('nothing reported says so rather than showing $0', () => {
  const out = spend({ 'a.json': { hello: 'world' } });
  assert.match(out, /usage not reported/);
});

// B10 — THE DEPLOY STATUS MUST DESCRIBE WHAT ACTUALLY HAPPENED.
//
// `_status` asserted "✅ Deployed to Core + pushed to main" unconditionally:
// when the push FAILED, when it was SKIPPED (GitHub disabled, or
// push_to_github not opted in — the endpoint returns skipped:true for both),
// and when no push was attempted at all.
//
// Its only variable was `widget_health`. So whether the code reached GitHub
// could not change the sentence claiming the code reached GitHub — the one
// thing the sentence was about was the one thing it did not consult.
//
// And the error was unreachable anyway: the response spread filtered it out
// with `!github_result.error`, leaving a failed push visible only inside
// `phases`, which nothing reads. The agent was told it had shipped.
//
// Run: node test/deploy-status-truth.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../src/tools.js', import.meta.url), 'utf8');

// Isolate the build_and_run return so neighbouring tools cannot satisfy a match.
const BLOCK = SRC.slice(
  SRC.indexOf('// The GitHub outcome is reported WHATEVER it was'),
  SRC.indexOf("_next: 'Create a checkpoint"),
);

test('the block under test is still where we think it is', () => {
  assert.ok(BLOCK.length > 300, 'the build_and_run return moved — re-anchor this test');
});

test('a FAILED push is reported, not filtered out of the response', () => {
  assert.match(BLOCK, /\.\.\.\(github_result && \{ github: github_result \}\)/,
    'the response still drops github_result when it carries an error');
  assert.doesNotMatch(BLOCK, /!github_result\.error && !github_result\.skipped && \{ github/,
    'the error-filtering spread is back');
});

test('a failed push changes the status line', () => {
  assert.match(BLOCK, /github_result\?\.error \? `⚠️ GitHub push FAILED/);
});

test('a SKIPPED push is not reported as a push', () => {
  // skipped:true is returned both when GitHub is disabled and when
  // push_to_github was not opted in. Both used to read as success.
  assert.match(BLOCK, /github_result\?\.skipped \?/);
  assert.match(BLOCK, /skipped[\s\S]{0,120}Core and GitHub now differ/);
});

test('NO push attempted is distinguished from a successful one', () => {
  assert.match(BLOCK, /no GitHub push attempted/);
});

test('"pushed to main" is now conditional on a push having happened', () => {
  // The exact regression: the phrase must not be reachable without github_result.
  const claim = BLOCK.indexOf("'+ pushed to main'");
  assert.ok(claim > 0, 'the success phrase vanished — re-anchor');
  const guard = BLOCK.slice(0, claim);
  assert.match(guard, /github_result \?/, '"pushed to main" is no longer guarded by github_result');
});

test('widget_health no longer gates the push claim', () => {
  // It may still ADD a warning, but it must not be what decides whether the
  // deploy claims to have pushed.
  assert.doesNotMatch(BLOCK, /_status: widget_health/,
    'the push claim is keyed off widget health again');
  assert.match(BLOCK, /widget_health && !widget_health\.ok/, 'the widget warning was lost entirely');
});

test('MUTATION GUARD: no unconditional success string remains', () => {
  // A single literal containing both halves would re-introduce the bug wholesale.
  assert.doesNotMatch(
    SRC,
    /'✅ Deployed to Core \+ pushed to main\.'/,
    'an unconditional "Deployed to Core + pushed to main" literal is back',
  );
});

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
  assert.match(BLOCK, /GitHub push skipped/);
});

test('a skip after a PULL does not claim a divergence that does not exist', () => {
  // This test used to pin `skipped … Core and GitHub now differ` as a single
  // sentence — and that sentence is FALSE on the one path it most often fires:
  // when the deploy PULLED from GitHub, the push-back is skipped precisely
  // because Core was built from that content. They agree exactly. Telling the
  // caller they "now differ" sends them to reconcile a repo that is correct.
  //
  // The test was defending the lie. It now requires the two cases to be
  // distinguished, and requires the pull case to name the divergence that IS
  // real: unpromoted work on dev is not in a deploy of main.
  assert.match(BLOCK, /from github/i, 'the pull case is not distinguished from a real divergence');
  assert.match(BLOCK, /Core matches the branch it was built from/);
  assert.match(BLOCK, /ateam_github_promote\(solution_id\)/,
    'the skip-after-pull case does not name the action that would include the missing work');
  // The genuine divergence case must still say so.
  assert.match(BLOCK, /Core and GitHub now differ/);
});

test('NO push attempted is distinguished from a successful one', () => {
  assert.match(BLOCK, /no GitHub push attempted/);
});

test('the success phrase is conditional on a push having happened', () => {
  // The exact regression: the phrase must not be reachable without
  // github_result. Anchored on `pushed to` rather than the old literal
  // "pushed to main" — that literal was itself wrong, since the push has
  // resolved to `dev` since 6e4470e and the envelope now reports the branch
  // the push actually reported.
  const claim = BLOCK.indexOf('`+ pushed to ${github_result.branch');
  assert.ok(claim > 0, 'the success phrase vanished — re-anchor');
  const guard = BLOCK.slice(0, claim);
  assert.match(guard, /github_result \?/, 'the success phrase is no longer guarded by github_result');
});

test('the status names the branch the push REPORTED, not a hardcoded one', () => {
  assert.doesNotMatch(BLOCK, /'\+ pushed to main'/,
    'build_and_run claims "pushed to main" again — the push resolves to dev');
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

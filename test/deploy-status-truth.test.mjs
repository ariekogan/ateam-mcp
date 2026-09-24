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
// ── WHY THIS FILE IS NOW BEHAVIOURAL ──
// It used to regex a slice of src/tools.js from one comment to the string
// "_next: 'Create a checkpoint". 0c8424a deleted that string, indexOf returned
// -1, and the slice silently became "everything to EOF" — every assertion
// below then searched half of tools.js (137KB) instead of the 2KB block it
// claimed to isolate, and its canary (`BLOCK.length > 300`) could not notice.
// The branch half of the envelope is now ONE exported function,
// describeDeployBranches, and these tests CALL it. The handler tests at the
// bottom drive the real ateam_build_and_run against a local stand-in server.
//
// Run: node --test test/deploy-status-truth.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { setSessionCredentials } from '../src/api.js';
import { BRANCH_WORKFLOW } from '../src/branchWorkflow.js';
import * as TOOLS from '../src/tools.js';

const SRC = readFileSync(new URL('../src/tools.js', import.meta.url), 'utf8');
const describeDeployBranches = TOOLS.describeDeployBranches;
const say = (o) => describeDeployBranches({ pulledFromRepo: false, githubResult: undefined, githubConnected: true, widgetHealth: null, ...o });

test('the envelope is decided by ONE exported function', () => {
  assert.equal(typeof describeDeployBranches, 'function', 'describeDeployBranches is not exported from src/tools.js');
});

test('a FAILED push changes the status line', () => {
  const e = say({ githubResult: { error: 'boom' } });
  assert.match(e._status, /⚠️ GitHub push FAILED: boom/);
  assert.doesNotMatch(e._status, /pushed to/);
});

test('a SKIPPED push is not reported as a push', () => {
  // skipped:true is returned both when GitHub is disabled and when
  // push_to_github was not opted in. Both used to read as success.
  const e = say({ githubResult: { skipped: true, reason: 'GitHub push requires explicit push_to_github: true.' } });
  assert.match(e._status, /GitHub push skipped/);
  assert.match(e._status, /Core and GitHub now differ/, 'a genuine divergence no longer says so');
  assert.doesNotMatch(e._status, /pushed to/);
});

test('a skip after a PULL does not claim a divergence that does not exist', () => {
  // When the deploy PULLED from GitHub, the push-back is skipped precisely
  // because Core was built from that content. They agree exactly. The
  // divergence that IS real: unpromoted work on dev is not in a deploy of main.
  const e = say({ pulledFromRepo: true, githubResult: { skipped: true, reason: 'Deployed from GitHub — push-back skipped.' } });
  assert.match(e._status, /Core matches the branch it was built from/);
  assert.doesNotMatch(e._status, /now differ/);
  assert.match(e._status, /ateam_github_promote\(solution_id\)/,
    'the skip-after-pull case does not name the action that would include the missing work');
});

test('NO push attempted is distinguished from a successful one', () => {
  assert.match(say({ githubResult: undefined })._status, /no GitHub push attempted/);
});

test('the status names the branch the push REPORTED, not a hardcoded one', () => {
  assert.match(say({ githubResult: { ok: true, branch: 'dev' } })._status, /\+ pushed to dev/);
  assert.match(say({ githubResult: { ok: true, branch: 'main' } })._status, /\+ pushed to main/);
  assert.equal(say({ githubResult: { ok: true, branch: 'dev' } }).pushed_to_branch, 'dev');
});

test('widget_health adds a warning but does not decide the push claim', () => {
  const warned = say({ githubResult: { ok: true, branch: 'dev' }, widgetHealth: { ok: false, issues: [1, 2] } });
  assert.match(warned._status, /\+ pushed to dev/);
  assert.match(warned._status, /2 widget\(s\) not rendering/);
  assert.doesNotMatch(say({ githubResult: { error: 'x' }, widgetHealth: { ok: true } })._status, /pushed to/);
});

test('MUTATION GUARD: no unconditional success string remains', () => {
  assert.doesNotMatch(SRC, /'✅ Deployed to Core \+ pushed to main\.'/,
    'an unconditional "Deployed to Core + pushed to main" literal is back');
});

// ── 99870e99cb: a tenant with NO REPO has no branches ──────────────────────
// deployed_from_branch:'main' and a _next about unpromoted work on `dev` were
// emitted unconditionally, so a repo-less tenant was told to promote a branch
// that does not exist — while BRANCH_WORKFLOW.no_git_at_all, in the same
// response family, says the opposite.
test('no repo: no branch story at all', () => {
  const e = say({ githubConnected: false, githubResult: { skipped: true, reason: 'GitHub integration disabled' } });
  assert.equal(e.deployed_from_branch, undefined, 'a repo-less tenant was told what branch it deployed');
  assert.doesNotMatch(e._next, /still on `?dev|ateam_github_promote/, `told to promote with no repo: ${e._next}`);
  assert.ok(e._next.includes(BRANCH_WORKFLOW.no_git_at_all), 'the no-git wording is not rendered from the owner');
  assert.doesNotMatch(e._status, /now differ/, 'claims Core and a GitHub that does not exist "differ"');
});

test('deployed_from_branch is claimed only when the deploy was BUILT from the repo', () => {
  assert.equal(say({ pulledFromRepo: true, githubResult: { skipped: true, reason: 'Deployed from GitHub' } }).deployed_from_branch,
    BRANCH_WORKFLOW.deploy_branch);
  // Inline payload: Core runs what the caller passed, whatever the repo holds.
  assert.equal(say({ githubResult: { ok: true, branch: 'dev' } }).deployed_from_branch, undefined);
});

test('an UNKNOWN connection (probe failed) is not treated as "no repo"', () => {
  const e = say({ githubConnected: null, githubResult: { error: 'socket hang up' } });
  assert.match(e._next, /ateam_github_promote/, 'an unconfirmed repo was reported as absent');
});

// ── The real handler, end to end ────────────────────────────────────────────
const SID = 'sess-deploy-status-truth';
let routes = {};
let hits = [];
const server = createServer((req, res) => {
  const key = `${req.method} ${req.url.split('?')[0]}`;
  hits.push(key);
  const reply = routes[key];
  res.writeHead(reply?.status || (reply ? 200 : 404), { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(reply ? reply.body : { error: 'no route' }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
setSessionCredentials(SID, { apiKey: 'adas_tenanta_00000000000000000000000000000000', apiUrl: `http://127.0.0.1:${server.address().port}`, explicit: true });
test.after(() => server.close());

const BASE = {
  'POST /validate/solution': { body: { valid: true, errors: [], warnings: [] } },
  'POST /deploy/solution': { body: { ok: true, import: { skills: ['k'], connectors: 0 } } },
  'GET /deploy/solutions/sol/health': { body: { ok: true } },
  'GET /deploy/solutions/sol/definition': { body: { solution: {} } },
  'GET /deploy/solutions/sol/ui-plugins': { body: { plugins: [] } },
};
async function buildAndRun(extra) {
  routes = { ...BASE, ...extra };
  hits = [];
  const r = await TOOLS.handleToolCall('ateam_build_and_run',
    { solution: { id: 'sol', name: 'Sol' }, skills: [{ id: 'k' }] }, SID);
  return JSON.parse(r.content[0].text);
}

test('handler: GitHub disabled platform-wide → no branch story', async () => {
  const out = await buildAndRun({
    'POST /deploy/solutions/sol/github/push': { body: { ok: true, skipped: true, reason: 'GitHub integration disabled' } },
    'GET /deploy/solutions/sol/github/connected': { body: { ok: true, enabled: false, connected: false } },
  });
  assert.equal(out.ok, true);
  assert.equal(out.deployed_from_branch, undefined);
  assert.doesNotMatch(out._next, /still on `?dev|ateam_github_promote/);
  assert.ok(hits.includes('GET /deploy/solutions/sol/github/connected'), 'the handler never asked whether GitHub is connected');
});

test('handler: tenant never connected GitHub → no branch story, and the failed push is still reported', async () => {
  const out = await buildAndRun({
    'POST /deploy/solutions/sol/github/push': { status: 500, body: { ok: false, error: 'github_not_connected: tenant "tenanta" has not connected its GitHub.' } },
    'GET /deploy/solutions/sol/github/connected': { body: { ok: true, enabled: true, connected: false } },
  });
  assert.equal(out.deployed_from_branch, undefined);
  assert.doesNotMatch(out._next, /still on `?dev|ateam_github_promote/);
  assert.ok(out.github?.error, 'the failed push was filtered out of the response');
});

test('handler: a repo that was PULLED keeps the branch story and needs no probe', async () => {
  const out = await buildAndRun({
    'GET /deploy/solutions/sol/github/status': { body: { repo_url: 'https://github.com/o/r' } },
    'POST /deploy/solutions/sol/github/pull-bundle': { body: { ok: true, mcp_store: {}, skills: [{ id: 'k' }] } },
  });
  assert.equal(out.deployed_from_branch, BRANCH_WORKFLOW.deploy_branch);
  assert.match(out._next, /ateam_github_promote/);
  assert.ok(!hits.includes('GET /deploy/solutions/sol/github/connected'), 'probed a connection the pull already proved');
});

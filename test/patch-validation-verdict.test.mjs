// ateam_patch's VALIDATION VERDICT must reach the caller, say only what is true,
// and cost the caller no more than an advisory check is worth.
//
// f09301b added a non-blocking `validation` block to skill patches ("silent is
// the bug"). It asked the skill-validator for …/skills/:id/validation. That
// route has never existed: the skill-validator serves …/skills/:id/validate
// (2b467c9), which proxies to the Builder's /api/…/validation. Every call
// 404'd into a bare `catch {}`, so the verdict never once reached a caller, and
// nothing said so. Four more defects sat behind the 404, unreachable until it
// was fixed (Codex e0dff497de, 0458c8ff65, 8d0c6310ae, d22df7da65):
//   - an absent `valid` was reported as INVALID, in _status, with no _verdict
//   - the advisory GET used the request default (120s, 2 retries): minutes
//     added to a patch that was already saved and redeployed
//   - a failure left no trace at all
//   - _verdict said "saved + redeployed" when the redeploy had failed
//
// Behavioural: the real ateam_patch, through the real dispatcher, against a
// local server playing the skill-validator. It serves only the routes the real
// one serves, unless a case says otherwise.
//
// Run: node --test test/patch-validation-verdict.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setSessionCredentials } from "../src/api.js";
import { handleToolCall } from "../src/tools.js";

const SID = "sess-patch-validation";
const KEY = "adas_tenanta_00000000000000000000000000000000";
const SKILL = { id: "walk-guide", name: "Walk Guide", description: "d" };
const VALIDATE = "/deploy/solutions/walkmate/skills/walk-guide/validate";
const OLD_ROUTE = "/deploy/solutions/walkmate/skills/walk-guide/validation";

let routes = {};
let hits = [];
let server;

before(async () => {
  server = createServer((req, res) => {
    const path = req.url.split("?")[0];
    hits.push(`${req.method} ${path}`);
    const hit = routes[`${req.method} ${path}`];
    const reply = typeof hit === "function" ? hit() : hit;
    if (!reply) { res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"error":"Cannot GET"}'); return; }
    res.writeHead(reply.status || 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, { apiKey: KEY, apiUrl: `http://127.0.0.1:${server.address().port}`, explicit: true });
});
after(() => server.close());

// What every patch needs: read the skill, write it, redeploy it. Widget health
// has nothing to report.
const BASE_ROUTES = (redeploy) => ({
  "GET /deploy/solutions/walkmate/github/read": { body: { ok: true, content: JSON.stringify(SKILL) } },
  "POST /deploy/solutions/walkmate/github/patch": { body: { ok: true, branch: "dev" } },
  "POST /deploy/solutions/walkmate/skills/walk-guide/redeploy": { body: redeploy },
  "GET /deploy/solutions/walkmate/definition": { body: { solution: {} } },
  "GET /deploy/solutions/walkmate/ui-plugins": { body: { plugins: [] } },
});
const CLEAN = { ok: true, deployed: 1 };

// The Builder's getValidationSummary, as /validate returns it.
const INVALID = { validation: { valid: false, ready_to_export: false, error_count: 2, warning_count: 0,
  unresolved_refs: { tools: 1, workflows: 0, intents: 0 }, sections: { role: { complete: false }, tools: { complete: true } } } };

async function patch(extraRoutes, redeploy = CLEAN) {
  routes = { ...BASE_ROUTES(redeploy), ...extraRoutes };
  hits = [];
  const r = await handleToolCall("ateam_patch",
    { solution_id: "walkmate", target: "skill", skill_id: "walk-guide", updates: { description: "new" } }, SID);
  return JSON.parse(r.content[0].text);
}

test("the verdict is read from the route the skill-validator serves, and reaches the caller", async () => {
  const out = await patch({ [`GET ${VALIDATE}`]: { body: INVALID } });
  assert.ok(hits.includes(`GET ${VALIDATE}`), `the verdict was never asked for at ${VALIDATE}; asked: ${hits.filter((h) => /valid/.test(h))}`);
  assert.ok(out.validation, "a skill the Builder calls INVALID came back with no validation block");
  assert.equal(out.validation.valid, false);
  assert.equal(out.validation.error_count, 2);
  assert.deepEqual(out.validation.incomplete_sections, ["role"]);
  assert.deepEqual(out.validation.unresolved_refs, { tools: 1 });
  assert.match(out._status, /Skill "walk-guide" is INVALID \(2 error\(s\)\)/);
  assert.match(out.validation._verdict, /INVALID/);
});

// Both routes answer below, so the same case reaches the verdict logic on a
// build that still asks the old route.
const both = (reply) => ({ [`GET ${VALIDATE}`]: reply, [`GET ${OLD_ROUTE}`]: reply });

test("a response with no `valid` is unknown, not INVALID", async () => {
  const out = await patch(both({ body: { validation: { errors: [], warnings: [] } } }));
  assert.ok(out.validation, "no validation block");
  assert.equal(out.validation.valid, null, "an absent `valid` was reported as a verdict");
  assert.equal(out.validation.ready_to_export, null, "an absent `ready_to_export` was reported as false");
  assert.doesNotMatch(out._status, /INVALID/, "the INVALID banner fired on a response that never said invalid");
  assert.equal(out.validation._verdict, undefined);
});

test("the verdict says 'redeployed' only when the redeploy happened", async () => {
  const failed = await patch(both({ body: INVALID }), { ok: false, error: "Core unreachable" });
  assert.equal(failed.ok, false);
  assert.match(failed.validation._verdict, /INVALID/);
  assert.doesNotMatch(failed.validation._verdict, /redeployed/, "the verdict claimed a redeploy that failed");
  assert.match(failed.validation._verdict, /redeploy did not complete/);

  const clean = await patch(both({ body: INVALID }));
  assert.match(clean.validation._verdict, /saved and redeployed/);
});

test("a verdict that could not be fetched is SAID, with its status", async () => {
  const out = await patch({}); // the skill-validator answers 404 for the verdict
  const phase = out.phases.find((p) => p.phase === "validation");
  assert.ok(phase, "a failed verdict left no trace: it reads exactly like one never asked for");
  assert.equal(phase.status, "unavailable");
  assert.equal(phase.http_status, 404);
  assert.equal(out.ok, true, "an advisory check downgraded a saved, redeployed patch");
  assert.equal(out.validation, undefined);
});

test("the advisory check is asked once — no retry budget on a finished patch", async () => {
  // 502 is retried by the request default (twice, 5s + 10s apart). An advisory
  // read after the patch is saved gets one attempt.
  const t0 = Date.now();
  const out = await patch(both({ status: 502, body: { error: "bad gateway" } }));
  const asked = hits.filter((h) => h === `GET ${VALIDATE}` || h === `GET ${OLD_ROUTE}`).length;
  assert.equal(asked, 1, `the advisory verdict was requested ${asked} times`);
  assert.ok(Date.now() - t0 < 4000, `the patch result was held ${Date.now() - t0}ms by an advisory check`);
  assert.equal(out.phases.find((p) => p.phase === "validation")?.status, "unavailable");
});

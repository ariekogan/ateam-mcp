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
//   - _verdict, _status and the tool description all said build_and_run would
//     refuse to deploy while the skill is invalid. build_and_run never asks
//     for this verdict: its gate is POST /validate/solution, the solution
//     validator, which does not run the per-skill check. Dormant while the
//     404 hid the verdict; live the moment it was fixed.
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
import { handleToolCall, tools } from "../src/tools.js";

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

// WHAT THE VERDICT SAYS ABOUT build_and_run MUST BE WHAT build_and_run DOES.
//
// First the fact, by behaviour: the real ateam_build_and_run, given a skill the
// per-skill route calls INVALID, never asks that route. It asks the solution
// validator, and when that has no errors it deploys. So "build_and_run will
// refuse" is false for exactly the case the verdict is shown in.
//
// Then the words: no clause the caller is shown — the verdict, the status line,
// the tool's own description — may say build_and_run refuses or blocks on this
// verdict, unless it says it does NOT.
const saysBuildAndRunRefuses = (text) =>
  String(text || "")
    .split(/[.;:()\n]|—/)
    .filter((c) => /build_and_run/.test(c) && /refus|block|stop/i.test(c))
    .filter((c) => !/\b(not|never|no|neither|nor)\b/i.test(c));

test("build_and_run never asks for the per-skill verdict: its gate is the solution validator", async () => {
  routes = {
    "POST /validate/solution": { body: { ok: true, valid: true, errors: [], warnings: [] } },
    "POST /deploy/solution": { body: { ok: true, deployed: true } },
    [`GET ${VALIDATE}`]: { body: INVALID },
  };
  hits = [];
  const r = await handleToolCall("ateam_build_and_run",
    { solution_id: "walkmate", solution: { id: "walkmate" }, skills: [SKILL], mcp_store: {} }, SID);
  const out = JSON.parse(r.content[0].text);
  assert.ok(hits.includes("POST /validate/solution"), `build_and_run did not validate: ${hits.join(", ")}`);
  assert.ok(!hits.some((h) => /\/skills\/[^/]+\/validat/.test(h)),
    `build_and_run asked the per-skill verdict after all: ${hits.join(", ")}`);
  assert.ok(hits.includes("POST /deploy/solution"),
    `build_and_run refused a skill the per-skill verdict calls INVALID: ${JSON.stringify(out).slice(0, 300)}`);
});

test("so nothing ateam_patch says claims build_and_run will refuse on it", async () => {
  const out = await patch(both({ body: INVALID }));
  assert.equal(out.validation.valid, false, "the case under test is an INVALID verdict");
  const description = tools.find((t) => t.name === "ateam_patch").description;
  for (const [where, text] of [["_verdict", out.validation._verdict], ["_status", out._status], ["description", description]]) {
    assert.deepEqual(saysBuildAndRunRefuses(text), [], `${where} promises a build_and_run gate that does not exist`);
  }
  // It still says the skill is invalid, and that nothing will stop on it.
  assert.match(out.validation._verdict, /INVALID/);
  assert.match(out._status, /INVALID/);
});

test("(control) the clause check catches the sentence it exists for", () => {
  assert.equal(saysBuildAndRunRefuses("…(non-blocking), but build_and_run will REFUSE to deploy while errors stand.").length, 1);
  assert.equal(saysBuildAndRunRefuses("see validation (non-blocking; build_and_run will refuse until fixed)").length, 1);
  assert.equal(saysBuildAndRunRefuses("build_and_run does not run this check, so it will not stop on it").length, 0);
});

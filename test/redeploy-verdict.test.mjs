// ateam_redeploy MUST NOT SAY "successfully" ABOUT A DEPLOY THAT LANDED WITH ERRORS.
//
// The Builder has three verdicts for a skill redeploy, not two: deployed,
// deployed_with_errors (it reached Core but did not come up clean — a tool
// import that contributed nothing, a UI plugin that fails verification), and
// failed. The wrapper passed `status` through as a data key and then wrote its
// summary sentence from `ok` alone, so a degraded deploy read
// 'Re-deployed skill "X" successfully.' — the line an agent reads first, and
// stops on. The Builder had already written the right sentence; the wrapper
// threw it away.
//
// And on the async path — the one agents actually take — the job's `status` is
// its LIFECYCLE ('done' | 'failed'), not the outcome. The Builder now carries
// the outcome as `deploy_status`; an older Builder does not, so the lifecycle
// word is the fallback and must never be read as degraded on its own.
//
// Behavioural: the real handler, through the real dispatcher, against a local
// server playing the Builder. Run: node --test test/redeploy-verdict.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setSessionCredentials } from "../src/api.js";
import { handleToolCall } from "../src/tools.js";

const SID = "sess-redeploy-verdict";
const KEY = "adas_tenanta_00000000000000000000000000000000";
let routes = {};
let server;

before(async () => {
  server = createServer((req, res) => {
    const key = `${req.method} ${req.url.split("?")[0]}`;
    const hit = routes[key];
    const reply = typeof hit === "function" ? hit() : hit;
    if (!reply) { res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"error":"no route"}'); return; }
    res.writeHead(reply.status || 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, { apiKey: KEY, apiUrl: `http://127.0.0.1:${server.address().port}`, explicit: true });
});
after(() => server.close());

// Widget health is advisory; give it nothing to report.
const QUIET = {
  "GET /deploy/solutions/sol/definition": { body: { solution: {} } },
  "GET /deploy/solutions/sol/ui-plugins": { body: { plugins: [] } },
};

async function redeploy(args, extraRoutes) {
  routes = { ...QUIET, ...extraRoutes };
  const r = await handleToolCall("ateam_redeploy", { solution_id: "sol", ...args }, SID);
  return { r, out: JSON.parse(r.content[0].text) };
}

// What the Builder's normalizeSkillRedeploy returns for a degraded skill.
const DEGRADED_SKILL = {
  ok: true, skill_id: "k", deployed: 1, failed: 0, total: 1,
  status: "deployed_with_errors",
  verification: { needs_attention: true, issues: ["Tool import: connector weather-mcp contributed no tools"] },
  skills: [{ id: "k", ok: true }],
  message: 'Skill "k" tool import PARTIAL: connector weather-mcp contributed no tools',
};

test("sync path: a skill that deployed WITH ERRORS is not reported as a success", async () => {
  const { r, out } = await redeploy({ skill_id: "k" }, {
    "POST /deploy/solutions/sol/skills/k/redeploy": { body: DEGRADED_SKILL },
  });
  assert.doesNotMatch(out.message, /successfully/i, `degraded deploy summarized as: ${out.message}`);
  assert.match(out.message, /WITH ERRORS/, "the summary does not say the deploy was degraded");
  assert.match(out.message, /contributed no tools/, "the Builder's own reason was thrown away");
  assert.equal(out.status, "deployed_with_errors");
  assert.equal(out.code, "DEPLOYED_WITH_ERRORS", "no machine-readable marker — callers must parse prose");
  // Degraded is not failed: the Builder says ok:true, and that verdict stands.
  assert.equal(out.ok, true);
  assert.equal(r.isError, undefined, "a landed-with-errors deploy was escalated to a tool failure");
});

test("async path: the OUTCOME comes from deploy_status, not the job lifecycle", async () => {
  const { out } = await redeploy({ skill_id: "k" }, {
    "POST /deploy/solutions/sol/skills/k/redeploy": { body: { ok: true, async: true, job_id: "job-1" } },
    "GET /deploy/jobs/job-1": { body: { job_id: "job-1", ...DEGRADED_SKILL, status: "done", deploy_status: "deployed_with_errors" } },
  });
  assert.equal(out.status, "deployed_with_errors", `the lifecycle word leaked through as the outcome: ${out.status}`);
  assert.doesNotMatch(out.message, /successfully/i, `degraded async deploy summarized as: ${out.message}`);
  assert.equal(out.code, "DEPLOYED_WITH_ERRORS");
});

test("async path, older Builder (no deploy_status): 'done' is a clean success, not a degradation", async () => {
  const { out } = await redeploy({ skill_id: "k" }, {
    "POST /deploy/solutions/sol/skills/k/redeploy": { body: { ok: true, async: true, job_id: "job-2" } },
    "GET /deploy/jobs/job-2": { body: { job_id: "job-2", ok: true, skill_id: "k", deployed: 1, failed: 0, total: 1, status: "done", skills: [{ id: "k", ok: true }] } },
  });
  assert.match(out.message, /Re-deployed skill "k" successfully\./);
  assert.equal(out.code, undefined);
});

test("a clean sync deploy still says successfully", async () => {
  const { out } = await redeploy({ skill_id: "k" }, {
    "POST /deploy/solutions/sol/skills/k/redeploy": { body: { ok: true, skill_id: "k", deployed: 1, failed: 0, total: 1, status: "deployed", skills: [{ id: "k", ok: true }] } },
  });
  assert.match(out.message, /Re-deployed skill "k" successfully\./);
  assert.equal(out.code, undefined);
});

test("bulk: ok:true with failures is not 'successfully'", async () => {
  const { out } = await redeploy({}, {
    "POST /deploy/solutions/sol/redeploy": { body: { ok: true, deployed: 3, failed: 2, total: 5, skills: [] } },
  });
  assert.doesNotMatch(out.message, /successfully/i, `partial bulk deploy summarized as: ${out.message}`);
  assert.match(out.message, /3 of 5/);
  assert.equal(out.code, "DEPLOYED_WITH_ERRORS");
});

test("bulk async: a leftover job PROGRESS message is never used as the summary", async () => {
  // The bulk job's runFn returns no `message`, so the job entry still carries
  // the progress text from updateJob. Preferring result.message blindly would
  // report 'Calling Builder bulk-redeploy...' as the final word.
  const { out } = await redeploy({}, {
    "POST /deploy/solutions/sol/redeploy": { body: { ok: true, async: true, job_id: "job-3" } },
    "GET /deploy/jobs/job-3": { body: { job_id: "job-3", status: "done", ok: true, deployed: 2, failed: 0, total: 2, skills: [], stage: "invoking-builder", message: "Calling Builder bulk-redeploy..." } },
  });
  assert.equal(out.message, "Re-deployed 2 skill(s) successfully.");
});

test("bulk async, degraded: the progress text is not quoted as the reason either", async () => {
  const { out } = await redeploy({}, {
    "POST /deploy/solutions/sol/redeploy": { body: { ok: true, async: true, job_id: "job-4" } },
    "GET /deploy/jobs/job-4": { body: { job_id: "job-4", status: "done", ok: true, deployed: 1, failed: 1, total: 2, skills: [], stage: "invoking-builder", message: "Calling Builder bulk-redeploy..." } },
  });
  assert.match(out.message, /1 of 2 skill\(s\) WITH ERRORS/);
  assert.doesNotMatch(out.message, /Calling Builder/, `progress text leaked into the verdict: ${out.message}`);
});

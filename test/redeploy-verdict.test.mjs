// ateam_redeploy MUST NOT SAY "successfully" ABOUT A DEPLOY THAT LANDED WITH ERRORS,
// AND MUST NOT SAY "WITH ERRORS" ABOUT ONE THAT NEVER RAN.
//
// The Builder has three verdicts for a skill redeploy, not two: deployed,
// deployed_with_errors (it reached Core but did not come up clean — a tool
// import that contributed nothing), and failed. The wrapper passed `status`
// through as a data key and then wrote its summary sentence from `ok` alone, so
// a degraded deploy read 'Re-deployed skill "X" successfully.' — the line an
// agent reads first, and stops on.
//
// On the async path — the one agents actually take — the job's `status` is its
// LIFECYCLE ('done' | 'failed'), not the outcome. Builder #44 carries the outcome
// as `deploy_status`; every Builder in service today does NOT (mac1 dev runs
// c6c20d3, prod runs 2e8cab5), so the verdict has to come from what those
// Builders DO send. And a job whose runFn crashed carries no `ok` at all.
//
// The fixtures below are the job entries those Builders actually write — built
// the way startAsyncDeployJob builds them — not hand-trimmed approximations.
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

async function call(tool, args, extraRoutes) {
  routes = { ...QUIET, ...extraRoutes };
  const r = await handleToolCall(tool, { solution_id: "sol", ...args }, SID);
  return { r, out: JSON.parse(r.content[0].text) };
}
const redeploy = (args, extraRoutes) => call("ateam_redeploy", args, extraRoutes);

// ─── What the Builders actually write ────────────────────────────────────────

// A finished async job, built exactly as startAsyncDeployJob builds it (Builder
// packages/skill-validator/src/routes/deploy.js, identical on 2e8cab5, c6c20d3
// and 0eea716): seed the entry, updateJob() adds the PROGRESS text, then on
// return spread the runFn result and OVERWRITE `status` with the lifecycle
// word — which is where the outcome is lost on a Builder without deploy_status.
function finishedJob(jobId, { single }, runFnResult) {
  return {
    job_id: jobId, status: "in_progress", label: single ? "redeploy-skill" : "redeploy-bulk",
    key: single ? "sol--k" : "sol", started_at: "2026-09-25T10:00:00.000Z",
    ...(single
      ? { stage: "redeploying-skill", skill_id: "k", message: "Redeploying skill from GitHub or Builder FS..." }
      : { stage: "invoking-builder", message: "Calling Builder bulk-redeploy..." }),
    ...runFnResult,
    status: runFnResult?.ok === false ? "failed" : "done",
    completed_at: "2026-09-25T10:00:09.000Z",
  };
}

// The same job when runFn THREW (catch branch): only {status, error} is
// patched in — no `ok`, and the progress text is left standing. This is an
// HTML 502 from the Builder (resp.json() throws) or the 300s AbortSignal.
function crashedJob(jobId, { single }, error) {
  return {
    job_id: jobId, status: "failed", label: single ? "redeploy-skill" : "redeploy-bulk",
    key: single ? "sol--k" : "sol", started_at: "2026-09-25T10:00:00.000Z",
    ...(single
      ? { stage: "redeploying-skill", skill_id: "k", message: "Redeploying skill from GitHub or Builder FS..." }
      : { stage: "invoking-builder", message: "Calling Builder bulk-redeploy..." }),
    error,
    completed_at: "2026-09-25T10:05:00.000Z",
  };
}

// deploySkillToADAS's `verification` for a skill-only redeploy
// (apps/backend/src/services/exportDeploy.js, identical on every Builder in
// service). Two facts matter:
//   - needs_attention is TRUE ON A CLEAN DEPLOY. has_get_skill_definition is
//     `result.hasGetSkillDefinition ?? false`, and Core's deploy-mcp has not
//     returned that field since b6a83a035 (2026-05-01) — so every deploy
//     carries it, with the issue below. It cannot tell degraded from clean.
//   - tool_import is set unconditionally, and its verdict is the Builder's own
//     importBad (`verdict !== 'SUCCESS'`), which with uiHardFail is the WHOLE of
//     its deployed_with_errors rule. UI verification never runs on a skill-only
//     redeploy (skipConnectorSync leaves no healthy connector to check), so on
//     this path tool_import IS the verdict.
const verification = (importVerdict) => ({
  skill_deployed: true, skill_registered: true, skill_tools: null, has_get_skill_definition: false,
  connectors_linked: 1, connectors_checked: false,
  connectors_total: null, connectors_healthy: null, connectors_failed: null, connectors_zero_tools: null,
  connectors_note: "skill-only redeploy — connectors were not re-checked. This skill links 1 connector(s): weather-mcp. Run a full redeploy to verify them.",
  needs_attention: true,
  issues: [
    "Missing get_skill_definition — ADAS Core cannot load skill config",
    ...(importVerdict === "SUCCESS" ? [] : ["Tool import: connector weather-mcp contributed no tools"]),
  ],
  tool_import: { verdict: importVerdict, connectors_declared: 1, connectors_queried: 1, connectors: [{ id: "weather-mcp", tools: importVerdict === "SUCCESS" ? 4 : 0 }] },
});

// normalizeSkillRedeploy as c6c20d3 (mac1 dev) returns it, around the Builder's
// deploySkillToADAS body. The closed object drops the top-level tool_import but
// keeps verification; `status` survives here and is then overwritten by the job.
const c6c20d3Normalized = (importVerdict) => ({
  ok: true, source: "builder-fs", skill_id: "k", tools: 0,
  deployed: 1, failed: 0, total: 1, skills: [{ id: "k", ok: true }],
  status: importVerdict === "SUCCESS" ? "deployed" : "deployed_with_errors",
  verification: verification(importVerdict),
  message: importVerdict === "SUCCESS"
    ? 'Skill "k" deployed to ADAS Core and running!'
    : `Skill "k" tool import ${importVerdict}: connector weather-mcp contributed no tools`,
});

// What the Builder's normalizeSkillRedeploy returns for a degraded skill (sync).
const DEGRADED_SKILL = {
  ok: true, skill_id: "k", deployed: 1, failed: 0, total: 1,
  status: "deployed_with_errors",
  verification: { needs_attention: true, issues: ["Tool import: connector weather-mcp contributed no tools"] },
  skills: [{ id: "k", ok: true }],
  message: 'Skill "k" tool import PARTIAL: connector weather-mcp contributed no tools',
};

// ─── Builder #44: deploy_status present ──────────────────────────────────────

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

// ─── Builders in service today: NO deploy_status ─────────────────────────────

test("async path, Builder without deploy_status (c6c20d3): a clean deploy still says successfully — needs_attention is not a verdict", async () => {
  const { r, out } = await redeploy({ skill_id: "k" }, {
    "POST /deploy/solutions/sol/skills/k/redeploy": { body: { ok: true, async: true, job_id: "job-2" } },
    "GET /deploy/jobs/job-2": { body: finishedJob("job-2", { single: true }, c6c20d3Normalized("SUCCESS")) },
  });
  assert.equal(out.message, 'Re-deployed skill "k" successfully.', `a clean deploy was summarized as: ${out.message}`);
  assert.equal(out.code, undefined);
  assert.equal(out.status, "deployed", `the job lifecycle leaked through as the outcome: ${out.status}`);
  assert.equal(r.isError, undefined);
});

for (const importVerdict of ["PARTIAL", "FAILED"]) {
  test(`async path, Builder without deploy_status (c6c20d3): tool import ${importVerdict} is WITH ERRORS, not successfully`, async () => {
    const jobId = `job-import-${importVerdict}`;
    const { r, out } = await redeploy({ skill_id: "k" }, {
      "POST /deploy/solutions/sol/skills/k/redeploy": { body: { ok: true, async: true, job_id: jobId } },
      ["GET /deploy/jobs/" + jobId]: { body: finishedJob(jobId, { single: true }, c6c20d3Normalized(importVerdict)) },
    });
    assert.doesNotMatch(out.message, /successfully/i, `degraded deploy on a Builder without deploy_status summarized as: ${out.message}`);
    assert.match(out.message, /WITH ERRORS/);
    assert.match(out.message, new RegExp(`Builder: Skill "k" tool import ${importVerdict}: connector weather-mcp contributed no tools`),
      `the Builder's own sentence was thrown away: ${out.message}`);
    assert.equal(out.status, "deployed_with_errors", `the job lifecycle leaked through as the outcome: ${out.status}`);
    assert.equal(out.code, "DEPLOYED_WITH_ERRORS");
    assert.equal(out.ok, true);
    assert.equal(r.isError, undefined, "a landed-with-errors deploy was escalated to a tool failure");
  });
}

test("async path, prod Builder (2e8cab5, no normaliser): a degraded skill arrives as ok:false and stays a FAILURE", async () => {
  // Prod's runFn returns `{ ok: resp.ok && data.ok !== false, skill_id, ...data }`,
  // and deploySkillToADAS says ok:false for deployed_with_errors — so the job is
  // lifecycle 'failed' with ok:false. That is the Builder's verdict: failed is
  // decided before degraded, and never gets the DEPLOYED_WITH_ERRORS marker.
  const data = {
    skill_id: "k", ok: false, status: "deployed_with_errors",
    tool_import: verification("PARTIAL").tool_import, verification: verification("PARTIAL"),
    message: 'Skill "k" tool import PARTIAL: connector weather-mcp contributed no tools',
  };
  const { r, out } = await redeploy({ skill_id: "k" }, {
    "POST /deploy/solutions/sol/skills/k/redeploy": { body: { ok: true, async: true, job_id: "job-prod" } },
    "GET /deploy/jobs/job-prod": { body: finishedJob("job-prod", { single: true }, { ok: false, skill_id: "k", ...data }) },
  });
  assert.equal(r.isError, true);
  assert.equal(out.ok, false);
  assert.equal(out.code, undefined, "a failed deploy was marked DEPLOYED_WITH_ERRORS");
  assert.equal(r.structuredContent?.code, "TOOL_FAILED");
  assert.doesNotMatch(out.message, /successfully|WITH ERRORS/, `summarized as: ${out.message}`);
});

// ─── A job that crashed never reached Core ──────────────────────────────────

for (const single of [true, false]) {
  const kind = single ? "single-skill" : "bulk";
  test(`${kind} async job that CRASHED is 'Re-deploy failed', isError — not WITH ERRORS, and never quotes the progress text`, async () => {
    const jobId = `job-crash-${kind}`;
    const endpoint = single ? "POST /deploy/solutions/sol/skills/k/redeploy" : "POST /deploy/solutions/sol/redeploy";
    const { r, out } = await redeploy(single ? { skill_id: "k" } : {}, {
      [endpoint]: { body: { ok: true, async: true, job_id: jobId } },
      // The exact shape: {status:'failed', message:<progress>, error:<the throw>}, no ok.
      ["GET /deploy/jobs/" + jobId]: { body: crashedJob(jobId, { single }, "Unexpected token <…") },
    });
    assert.equal(out.message, "Re-deploy failed: Unexpected token <…", `crashed job summarized as: ${out.message}`);
    assert.doesNotMatch(out.message, /Redeploying skill from|Calling Builder/, "a progress message was quoted as the verdict");
    assert.equal(out.code, undefined, "a deploy that never reached Core was marked DEPLOYED_WITH_ERRORS");
    assert.equal(out.ok, false, `ok must be false, got ${out.ok}`);
    assert.equal(out.error, "Unexpected token <…");
    assert.equal(out.status, "failed");
    assert.equal(r.isError, true, "a crashed deploy was not flagged as a tool failure");
    assert.equal(r.structuredContent?.code, "TOOL_FAILED");
  });
}

test("sync path: a failure answered with HTTP 200 (no lifecycle word) is still a failure", async () => {
  // Both Builders' GitHub exit answer 200 with ok:false — c6c20d3 via
  // normalizeSkillRedeploy, prod by hand. There is no job, so no lifecycle
  // 'failed' to key on: `ok` is the verdict, and it must be read as stated.
  const { r, out } = await redeploy({ skill_id: "k" }, {
    "POST /deploy/solutions/sol/skills/k/redeploy": { body: {
      ok: false, source: "github", skill_id: "k", tools: 0, deployed: 0, failed: 1, total: 1,
      skills: [{ id: "k", ok: false, error: "MCP generation failed: no tools" }],
      error: "MCP generation failed: no tools", message: 'Re-deploy of "k" failed: MCP generation failed: no tools',
    } },
  });
  assert.equal(out.message, "Re-deploy failed: MCP generation failed: no tools");
  assert.equal(out.ok, false);
  assert.equal(out.code, undefined);
  assert.equal(r.isError, true);
});

// ─── Unchanged contracts ────────────────────────────────────────────────────

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
    "GET /deploy/jobs/job-3": { body: finishedJob("job-3", { single: false }, { ok: true, deployed: 2, failed: 0, total: 2, skills: [] }) },
  });
  assert.equal(out.message, "Re-deployed 2 skill(s) successfully.");
});

test("bulk async, degraded: the progress text is not quoted as the reason either", async () => {
  const { out } = await redeploy({}, {
    "POST /deploy/solutions/sol/redeploy": { body: { ok: true, async: true, job_id: "job-4" } },
    "GET /deploy/jobs/job-4": { body: finishedJob("job-4", { single: false }, { ok: true, deployed: 1, failed: 1, total: 2, skills: [] }) },
  });
  assert.match(out.message, /1 of 2 skill\(s\) WITH ERRORS/);
  assert.doesNotMatch(out.message, /Calling Builder/, `progress text leaked into the verdict: ${out.message}`);
});

// ─── ateam_patch reads the SAME verdict for its rebuild phase ───────────────
//
// ateam_patch kicks the same redeploy endpoint and polls the same job, and had
// its own one-line copy of the verdict (`ok === false ? "error" : "done"`) —
// so a crashed job read as "✅ Patched + redeployed." and a degraded one as a
// clean rebuild. There is one verdict; both tools ask it.

const PATCH_LOCAL = {
  "GET /deploy/solutions/sol/skills/k": { body: { skill: { id: "k", name: "K", description: "old", connectors: ["weather-mcp"] } } },
  "PATCH /deploy/solutions/sol/skills/k": { body: { ok: true } },
};
const patchSkill = (extraRoutes) => call("ateam_patch",
  { target: "skill", skill_id: "k", source: "local", updates: { description: "new" } },
  { ...PATCH_LOCAL, ...extraRoutes });

test("ateam_patch: a redeploy job that CRASHED is not '✅ redeployed'", async () => {
  const { r, out } = await patchSkill({
    "POST /deploy/solutions/sol/skills/k/redeploy": { body: { ok: true, async: true, job_id: "job-p1" } },
    "GET /deploy/jobs/job-p1": { body: crashedJob("job-p1", { single: true }, "Unexpected token <…") },
  });
  const phase = out.phases.find((p) => p.phase === "redeploy");
  assert.equal(phase?.status, "error", `a crashed redeploy was recorded as: ${JSON.stringify(phase)}`);
  assert.equal(phase.error, "Unexpected token <…");
  assert.equal(out.ok, false, "a patch whose rebuild never ran reported ok");
  assert.equal(out.patch_persisted, true);
  assert.doesNotMatch(out._status, /✅ Patched on .* \+ redeployed/, `summarized as: ${out._status}`);
  assert.equal(r.isError, true);
});

test("ateam_patch: a redeploy that landed WITH ERRORS (Builder without deploy_status) says so", async () => {
  const { r, out } = await patchSkill({
    "POST /deploy/solutions/sol/skills/k/redeploy": { body: { ok: true, async: true, job_id: "job-p2" } },
    "GET /deploy/jobs/job-p2": { body: finishedJob("job-p2", { single: true }, c6c20d3Normalized("PARTIAL")) },
  });
  const phase = out.phases.find((p) => p.phase === "redeploy");
  assert.equal(phase?.status, "done", "the rebuild ran — the edit is live, degraded");
  assert.equal(phase.code, "DEPLOYED_WITH_ERRORS", `no marker on the redeploy phase: ${JSON.stringify(phase)}`);
  assert.equal(out.ok, true);
  assert.match(out._status, /WITH ERRORS/, `a degraded rebuild was summarized as: ${out._status}`);
  assert.doesNotMatch(out._status, /✅/);
  assert.equal(r.isError, undefined);
});

test("ateam_patch: a clean redeploy is still '✅ Patched … + redeployed.'", async () => {
  const { out } = await patchSkill({
    "POST /deploy/solutions/sol/skills/k/redeploy": { body: { ok: true, async: true, job_id: "job-p3" } },
    "GET /deploy/jobs/job-p3": { body: finishedJob("job-p3", { single: true }, c6c20d3Normalized("SUCCESS")) },
  });
  assert.equal(out.ok, true);
  assert.match(out._status, /^✅ Patched on Builder store \(local\) \+ redeployed\./, `summarized as: ${out._status}`);
  assert.equal(out.phases.find((p) => p.phase === "redeploy")?.code, undefined);
});

// ─── #18 re-review ───────────────────────────────────────────────────────────

test("prod single-skill (ok:false, no error): the Builder's own sentence is quoted — not 'gave no reason'", async () => {
  // Prod's runFn RETURNED ok:false with deploySkillToADAS's message and no
  // `error`. The summary said it "named no skill and gave no reason" while the
  // reason sat in the same object.
  const { r, out } = await redeploy({ skill_id: "k" }, {
    "POST /deploy/solutions/sol/skills/k/redeploy": { body: { ok: true, async: true, job_id: "job-prod-msg" } },
    "GET /deploy/jobs/job-prod-msg": { body: finishedJob("job-prod-msg", { single: true }, {
      ok: false, skill_id: "k", status: "deployed_with_errors",
      message: 'Skill "k" tool import PARTIAL: connector weather-mcp contributed no tools',
    }) },
  });
  assert.doesNotMatch(out.message, /gave no reason/, `the reason was in the job and the summary denied it: ${out.message}`);
  assert.match(out.message, /Skill "k" tool import PARTIAL: connector weather-mcp contributed no tools\./);
  assert.equal(out.ok, false, "the Builder's ok:false is still a failure");
  assert.equal(r.isError, true);
});

test("a BULK job's leftover message is still never quoted as the reason", async () => {
  const { out } = await redeploy({}, {
    "POST /deploy/solutions/sol/redeploy": { body: { ok: true, async: true, job_id: "job-bulk-false" } },
    "GET /deploy/jobs/job-bulk-false": { body: finishedJob("job-bulk-false", { single: false }, { ok: false }) },
  });
  assert.doesNotMatch(out.message, /Calling Builder bulk-redeploy/, `progress text quoted as a verdict: ${out.message}`);
});

test("ok:true WITH a top-level error is a failure, not a success", async () => {
  const { r, out } = await redeploy({ skill_id: "k" }, {
    "POST /deploy/solutions/sol/skills/k/redeploy": { body: {
      ok: true, skill_id: "k", deployed: 1, failed: 0, total: 1, status: "deployed",
      skills: [{ id: "k", ok: true }], error: "Core refused the skill manifest",
    } },
  });
  assert.equal(out.ok, false, `a body that reported an error was summarized as: ${out.message}`);
  assert.equal(out.message, "Re-deploy failed: Core refused the skill manifest");
  assert.doesNotMatch(out.message, /successfully/);
  assert.equal(r.isError, true);
});

test("the quoted Builder sentence ends before 'See verification.' begins", async () => {
  const { out } = await redeploy({ skill_id: "k" }, {
    "POST /deploy/solutions/sol/skills/k/redeploy": { body: DEGRADED_SKILL },
  });
  assert.match(out.message, /contributed no tools\. See verification\.$/, `run-on sentence: ${out.message}`);
});

// ateam_test_skill wait_for:"chain" RETURNS WHEN THE CHAIN IS DONE, NOT AT ITS TIMEOUT.
//
// The Builder answers the chain as {ok, success, data:{chainJobs}}. The wait read
// the job list at the top of the reply, never found it, and always ran to
// chain_timeout_ms ("Chain wait timed out") even for a test that finished in seconds.
//
// Run: node --test test/test-skill-chain-wait.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { setSessionCredentials } from "../src/api.js";
import { handleToolCall } from "../src/tools.js";

const API = "http://builder.test";
setSessionCredentials("sess-chain", { apiKey: "adas_tenanta_00000000000000000000000000000000", apiUrl: API, explicit: true });
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

test("a finished chain in the Builder's real shape ends the wait early", async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  globalThis.fetch = async (url, opts = {}) => {
    const { pathname } = new URL(String(url));
    if ((opts.method || "GET") === "POST" && pathname.endsWith("/test")) return json({ ok: true, job_id: "job_root" });
    if (pathname.includes("/deploy/jobs/job_root/chain")) {
      return json({ ok: true, success: true, data: { chainJobs: [{ id: "job_root", status: "done" }, { id: "job_b", status: "completed" }] } });
    }
    return json({ ok: false });
  };
  const started = Date.now();
  const out = JSON.parse((await handleToolCall("ateam_test_skill", { solution_id: "sol", skill_id: "s1", message: "hi", wait_for: "chain", chain_timeout_ms: 20000 }, "sess-chain")).content?.[0]?.text ?? "{}");
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300));
  assert.ok(Date.now() - started < 10000, "returned long before chain_timeout_ms");
});

// Live on dev (job_z6kmny9p): the job ended in 16 s but the call returned at its 60 s limit, while
// the chain it returned said status "done" and activeJobIds []. Core's chain-level answer decides;
// a job's own status word (here one the wait does not list) must not hold the wait open.
test("chain status done + activeJobIds empty ends the wait even if a job carries another status word", async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  globalThis.fetch = async (url, opts = {}) => {
    const { pathname } = new URL(String(url));
    if ((opts.method || "GET") === "POST" && pathname.endsWith("/test")) return json({ ok: true, job_id: "job_root" });
    if (pathname.includes("/deploy/jobs/job_root/chain")) {
      return json({ ok: true, success: true, data: { status: "done", activeJobIds: [], activeSkills: [], chainJobs: [{ jobId: "job_root", status: "idle" }] } });
    }
    return json({ ok: false });
  };
  const started = Date.now();
  const out = JSON.parse((await handleToolCall("ateam_test_skill", { solution_id: "sol", skill_id: "s1", message: "hi2", wait_for: "chain", chain_timeout_ms: 20000 }, "sess-chain")).content?.[0]?.text ?? "{}");
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300));
  assert.ok(Date.now() - started < 10000);
});

test("a running chain is not finished, whatever its job words say", async () => {
  const { _chainIsFinished } = await import("../src/tools.js");
  const term = (s) => ["done", "completed", "error", "failed", "aborted"].includes(s);
  assert.equal(_chainIsFinished({ data: { status: "running", activeJobIds: ["j1"], chainJobs: [{ status: "done" }, { status: "running" }] } }, term), false);
  assert.equal(_chainIsFinished({ data: { status: "done", activeJobIds: ["j1"], chainJobs: [] } }, term), false, "an active job keeps it open");
  assert.equal(_chainIsFinished({ data: { chainJobs: [] } }, term), false, "an empty answer is not finished");
  assert.equal(_chainIsFinished({ data: { status: "done", activeJobIds: [], chainJobs: [] } }, term), true);
});

// The exact chain object the dev connector returned at its timeout (live, job_jwh4d1sd, 2026-10-12):
// everything under `data`. Called through the same entry the server uses (runToolCall -> handleToolCall).
test("the live dev object ends the wait early through the server's own entry point", async (t) => {
  const { runToolCall } = await import("../src/api.js");
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  const live = { ok: true, data: { status: "done", chainJobs: [{ status: "done", relation: "root", depth: 0 }], activeJobIds: [], activeSkills: [], manualPaused: false, activeJobId: "job_jwh4d1sd", brainInfo: { status: "done" }, plan: [], planVersions: [] } };
  globalThis.fetch = async (url, opts = {}) => {
    const { pathname } = new URL(String(url));
    if ((opts.method || "GET") === "POST" && pathname.endsWith("/test")) return json({ ok: true, job_id: "job_jwh4d1sd" });
    if (pathname.includes("/deploy/jobs/job_jwh4d1sd/chain")) return json(live);
    return json({ ok: false });
  };
  const started = Date.now();
  const res = await runToolCall("sess-chain", () => handleToolCall("ateam_test_skill", { solution_id: "sol", skill_id: "s1", message: "hi3", wait_for: "chain", chain_timeout_ms: 20000 }, "sess-chain"), { transport: "http" });
  const out = JSON.parse(res.content?.[0]?.text ?? "{}");
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 400));
  assert.ok(Date.now() - started < 10000);
});

test("a timeout reply says what the last poll showed and what the exit test made of it", async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  globalThis.fetch = async (url, opts = {}) => {
    const { pathname } = new URL(String(url));
    if ((opts.method || "GET") === "POST" && pathname.endsWith("/test")) return json({ ok: true, job_id: "job_run" });
    if (pathname.includes("/deploy/jobs/job_run/chain")) return json({ ok: true, data: { status: "running", activeJobIds: ["job_run"], chainJobs: [{ status: "running" }] } });
    return json({ ok: false });
  };
  const out = JSON.parse((await handleToolCall("ateam_test_skill", { solution_id: "sol", skill_id: "s1", message: "hi4", wait_for: "chain", chain_timeout_ms: 10000 }, "sess-chain")).content?.[0]?.text ?? "{}");
  assert.equal(out.ok, false);
  assert.deepEqual(out.last_seen, { top_level_keys: ["ok", "data"], chain_status: "running", active_job_ids: 1, job_statuses: ["running"], exit_test_says_finished: false });
});

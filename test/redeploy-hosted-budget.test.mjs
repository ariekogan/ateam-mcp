// A HOSTED ateam_redeploy ANSWERS BEFORE THE CHAT CLIENT GIVES UP (near 60 s), AND resume:true + job_id WAITS FOR THE SAME JOB.
// (Outside-agent run on dev, 2026-10-13: the deploy tool "timed out after 60s" while the deploy was still going.)
//
// Behavioural: the real dispatcher inside runToolCall with the transport stated as src/http.js states it. The Builder is a stubbed
// fetch whose job finishes only when the test says so; the clock is node:test's mock timers, so 45 s costs no wall time.
//
// Run: node --test test/redeploy-hosted-budget.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { setSessionCredentials, runToolCall } from "../src/api.js";
import { handleToolCall, HOSTED_CALL_BUDGET_MS } from "../src/tools.js";

const API = "http://builder.test";
const KEY = "adas_tenanta_00000000000000000000000000000000";
setSessionCredentials("sess-rd", { apiKey: KEY, apiUrl: API, explicit: true });

const flush = () => new Promise((r) => setImmediate(r));
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function stubBuilder(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const sent = [];
  const state = { done: false, kicks: 0, gone: false, uploads: 0 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const { pathname } = new URL(String(url));
    const method = opts.method || "GET";
    sent.push({ method, path: pathname });
    if (method === "POST" && pathname.endsWith("/redeploy")) { state.kicks++; return json(200, { async: true, job_id: "job-1" }); }
    if (method === "POST" && pathname.endsWith("/upload")) { state.uploads++; return json(200, { async: true, job_id: "job-1" }); }
    if (pathname === "/deploy/jobs/job-1" && state.gone) return json(404, { error: "no such job" });
    if (pathname === "/deploy/jobs/job-1") {
      return json(200, state.done
        ? { job_id: "job-1", status: "done", ok: true, deployed: 2, failed: 0, total: 2, skills: [{ id: "a", ok: true }, { id: "b", ok: true }], deploy_status: "deployed" }
        : { job_id: "job-1", status: "in_progress", message: "Calling Builder bulk-redeploy..." });
    }
    if (pathname.endsWith("/definition")) return json(200, { solution: {} });
    if (pathname.endsWith("/ui-plugins")) return json(200, { plugins: [] });
    return json(404, { error: "no route" });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  let ms = 0;
  return {
    sent, state,
    call(transport, args) {
      const out = { settled: false, value: undefined, at: null };
      const run = () => handleToolCall("ateam_redeploy", { solution_id: "sol", ...args }, "sess-rd");
      (transport ? runToolCall("sess-rd", run, { transport }) : run()).then((v) => { out.settled = true; out.value = v; out.at = ms; });
      return out;
    },
    async advance(total, until = () => false) {
      for (let i = 0; i < 40; i++) await flush();
      for (let step = 0; step < total && !until(); step += 1000) {
        ms += 1000;
        t.mock.timers.tick(1000);
        for (let i = 0; i < 10; i++) await flush();
      }
    },
  };
}
const upload = (b, transport, args) => {
  const out = { settled: false, value: undefined };
  const run = () => handleToolCall("ateam_upload_connector", { solution_id: "sol", connector_id: "c", github: true, ...args }, "sess-rd");
  (transport ? runToolCall("sess-rd", run, { transport }) : run()).then((v) => { out.settled = true; out.value = v; });
  return out;
};
const answer = (out) => JSON.parse(out.value.content[0].text);

test("the budget is under the chat client's 60 s", () => {
  assert.ok(HOSTED_CALL_BUDGET_MS <= 50_000, `${HOSTED_CALL_BUDGET_MS} ms`);
});

test("hosted: a redeploy still going at the budget answers status:running with its job_id; resume waits for the same job and deploys nothing new", async (t) => {
  const b = stubBuilder(t);
  const first = b.call("http", {});
  await b.advance(HOSTED_CALL_BUDGET_MS + 3000, () => first.settled);
  assert.equal(first.settled, true);
  assert.ok(first.at <= HOSTED_CALL_BUDGET_MS + 3000, `answered at ${first.at} ms`);
  const a = answer(first);
  assert.equal(a.status, "running");
  assert.equal(a.ok, null);
  assert.equal(a.job_id, "job-1");
  assert.match(a._next, /resume: true/);
  assert.equal(b.state.kicks, 1);

  b.state.done = true;
  const second = b.call("http", { resume: true, job_id: "job-1" });
  await b.advance(10_000, () => second.settled);
  assert.equal(second.settled, true);
  const done = answer(second);
  assert.equal(done.ok, true);
  assert.equal(done.deployed, 2);
  assert.equal(b.state.kicks, 1, "resume kicked no new redeploy");
});

test("hosted: a redeploy that finishes within the budget answers with its result at once", async (t) => {
  const b = stubBuilder(t);
  b.state.done = true;
  const r = b.call("http", {});
  await b.advance(10_000, () => r.settled);
  assert.equal(answer(r).ok, true);
  assert.equal(b.state.kicks, 1);
});

test("resume without a job_id deploys nothing and says what to pass", async (t) => {
  const b = stubBuilder(t);
  const r = b.call("http", { resume: true });
  await b.advance(2000, () => r.settled);
  assert.equal(answer(r).code, "NO_JOB_TO_RESUME");
  assert.equal(b.state.kicks, 0);
});

test("stdio: unchanged - the call waits for the whole redeploy", async (t) => {
  const b = stubBuilder(t);
  const r = b.call("stdio", {});
  await b.advance(HOSTED_CALL_BUDGET_MS + 20_000, () => r.settled);
  assert.equal(r.settled, false, "a stdio call is held as long as the redeploy takes");
  b.state.done = true;
  await b.advance(10_000, () => r.settled);
  assert.equal(answer(r).ok, true);
});

test("a job id the Builder does not know answers JOB_NOT_FOUND at once, never 'running' (evicted after 30 min, a Builder restart, a typo)", async (t) => {
  const b = stubBuilder(t);
  b.state.gone = true;
  const r = b.call("http", { resume: true, job_id: "job-1" });
  await b.advance(HOSTED_CALL_BUDGET_MS + 3000, () => r.settled);
  assert.equal(r.settled, true);
  const a = answer(r);
  assert.equal(a.ok, false);
  assert.equal(a.code, "JOB_NOT_FOUND");
  assert.equal(a.job_id, "job-1");
  assert.notEqual(a.status, "running");
  assert.equal(b.state.kicks, 0, "nothing was redeployed");
});

test("a job that vanishes while a fresh redeploy waits for it is JOB_NOT_FOUND too, not a hang", async (t) => {
  const b = stubBuilder(t);
  b.state.gone = true;
  const r = b.call("http", {});
  await b.advance(HOSTED_CALL_BUDGET_MS + 3000, () => r.settled);
  assert.equal(r.settled, true);
  assert.equal(answer(r).code, "JOB_NOT_FOUND");
});

test("ateam_upload_connector is on the same budget: a hosted upload still going answers status:running with a job_id; resume waits for the same job", async (t) => {
  const b = stubBuilder(t);
  const first = upload(b, "http", {});
  await b.advance(HOSTED_CALL_BUDGET_MS + 3000, () => first.settled);
  assert.equal(first.settled, true);
  const a = answer(first);
  assert.equal(a.status, "running");
  assert.equal(a.job_id, "job-1");
  assert.match(a._next, /ateam_upload_connector\(.*resume: true/);
  b.state.done = true;
  const second = upload(b, "http", { github: undefined, resume: true, job_id: "job-1" });
  await b.advance(10_000, () => second.settled);
  assert.equal(answer(second).status, "done");
  assert.equal(b.state.uploads, 1, "resume uploaded nothing new");
});

test("ateam_upload_connector resume without a job_id uploads nothing; a gone job is JOB_NOT_FOUND", async (t) => {
  const b = stubBuilder(t);
  const none = upload(b, "http", { resume: true });
  await b.advance(2000, () => none.settled);
  assert.equal(answer(none).code, "NO_JOB_TO_RESUME");
  b.state.gone = true;
  const gone = upload(b, "http", { resume: true, job_id: "job-1" });
  await b.advance(HOSTED_CALL_BUDGET_MS + 3000, () => gone.settled);
  assert.equal(answer(gone).code, "JOB_NOT_FOUND");
  assert.equal(b.state.uploads, 0);
});

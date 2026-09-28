// A HOSTED ateam_build_and_run ANSWERS BEFORE THE EDGE DROPS IT, AND resume:true
// ANSWERS WITH THAT RUN'S RESULT WITHOUT DEPLOYING AGAIN. (K15, Ada Guide E2E
// 2026-09-28.)
//
// Over the hosted transport a tools/call is one silent HTTP request until the
// tool returns (src/http.js, enableJsonResponse), and Cloudflare drops it after
// ~100s. build_and_run ran ~133s: the client got no result and nothing to ask
// about, while the deploy went on. Now a call on any transport but a stated
// "stdio" waits for its run at most HOSTED_CALL_BUDGET_MS; a run not done by
// then answers status:"running" with a run_id and keeps going, and
// resume:true waits for THAT run again. Stdio holds the call as before.
//
// Behavioural: the real dispatcher (handleToolCall) inside api.js runToolCall,
// which is what src/server.js runs every tools/call in, with the transport
// stated as src/index.js ("stdio") and src/http.js ("http") state it. The
// Builder is a stubbed fetch whose deploy answers only when the test says so,
// and the clock is node:test's mock timers, so a 75s budget costs no wall time.
//
// Run: node --test test/build-and-run-hosted-budget.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { setSessionCredentials, runToolCall } from "../src/api.js";
import * as TOOLS from "../src/tools.js";
// Namespace import: a missing export fails ITS test below, not the whole file.
const { handleToolCall } = TOOLS;
// The design's number when the export is missing, so every other test still
// says what it would do on a server that has none.
const HOSTED_CALL_BUDGET_MS = TOOLS.HOSTED_CALL_BUDGET_MS ?? 75_000;

const KEY_A = "adas_tenanta_00000000000000000000000000000000";
const KEY_B = "adas_tenantb_00000000000000000000000000000000";
const API = "http://builder.test";
setSessionCredentials("sess-a", { apiKey: KEY_A, apiUrl: API, explicit: true });
setSessionCredentials("sess-a2", { apiKey: KEY_A, apiUrl: API, explicit: true }); // the same caller, reconnected
setSessionCredentials("sess-b", { apiKey: KEY_B, apiUrl: API, explicit: true }); // another tenant

// A first deploy as the Ada Guide E2E made it: everything inline.
const firstDeploy = (id, extra = {}) => ({
  solution: { id, name: id },
  skills: [{ id: "s1", name: "S1" }],
  mcp_store: { "walk-guide": [{ path: "server.js", content: "// v1" }] },
  ...extra,
});

// ─── the Builder, and a clock the test drives ───────────────────────────────
const flush = () => new Promise((r) => setImmediate(r));
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function stubBuilder(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent = [];
  const gates = [];
  let deploys = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const { pathname } = new URL(String(url));
    const method = opts.method || "GET";
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    sent.push({ method, path: pathname, body });
    if (method === "POST" && pathname === "/deploy/solution") {
      // Each deploy answers when the test releases it, with its own marker, so
      // an answer can be traced to the deploy that produced it.
      const n = ++deploys;
      await new Promise((release, reject) => {
        gates.push(release);
        opts.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
      return json(200, { ok: true, import: { skills: [{ id: `deployed-by-deploy-${n}`, status: "deployed" }], connectors: 1 } });
    }
    if (pathname === "/validate/solution") return json(200, { ok: true, errors: [], warnings: [] });
    if (pathname.endsWith("/upload")) return json(200, { ok: true, tools: 3 });
    if (pathname.endsWith("/github/push")) return json(200, { ok: true, skipped: true, reason: "GitHub integration disabled" });
    if (pathname.endsWith("/github/connected")) return json(200, { ok: true, enabled: false, connected: false });
    if (pathname.endsWith("/health")) return json(200, { ok: true, connectors: [{ id: "walk-guide", status: "connected" }] });
    return json(404, { error: "no route" });
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const clock = { ms: 0 };
  return {
    sent,
    clock,
    deployPosts: () => sent.filter((r) => r.method === "POST" && r.path === "/deploy/solution").length,
    writes: () => sent.filter((r) => r.method !== "GET"),
    releaseDeploys: () => { while (gates.length) gates.shift()(); },
    /** Start a tools/call as the server does, on `transport` ("http" | "stdio" | null = not stated). */
    call(transport, args, sid = "sess-a") {
      const out = { settled: false, value: undefined, error: undefined, at: null };
      const run = () => handleToolCall("ateam_build_and_run", args, sid);
      (transport ? runToolCall(sid, run, { transport }) : run()).then(
        (v) => { out.settled = true; out.value = v; out.at = clock.ms; },
        (e) => { out.settled = true; out.error = e; out.at = clock.ms; },
      );
      return out;
    },
    /** Advance the mock clock in 1s steps, letting every awaited step run. */
    async advance(ms, until = () => false) {
      for (let i = 0; i < 40; i++) await flush();
      for (let step = 0; step < ms && !until(); step += 1000) {
        clock.ms += 1000;
        t.mock.timers.tick(1000);
        for (let i = 0; i < 10; i++) await flush();
      }
    },
  };
}
const answer = (out) => JSON.parse(out.value.content[0].text);

// ─── over the hosted transport ──────────────────────────────────────────────

test("the budget is under the edge's ~100s, with room for the hop", () => {
  assert.equal(typeof TOOLS.HOSTED_CALL_BUDGET_MS, "number", "tools.js exports no HOSTED_CALL_BUDGET_MS");
  assert.ok(HOSTED_CALL_BUDGET_MS <= 90_000, `a ${HOSTED_CALL_BUDGET_MS}ms budget leaves the edge no margin`);
  assert.ok(HOSTED_CALL_BUDGET_MS >= 30_000, `a ${HOSTED_CALL_BUDGET_MS}ms budget turns ordinary deploys into resumes`);
});

test("http: a slow deploy answers within the budget with a resumable handle, and is not sent again", async (t) => {
  const b = stubBuilder(t);
  const first = b.call("http", firstDeploy("k15-slow"));

  await b.advance(HOSTED_CALL_BUDGET_MS - 1000, () => first.settled);
  assert.equal(first.settled, false, `answered at ${first.at}ms — before the budget, while the deploy was still running`);
  await b.advance(2000, () => first.settled);
  assert.equal(first.settled, true, "no answer by the budget: over the hosted transport the edge drops this call at ~100s");
  assert.ok(first.at <= HOSTED_CALL_BUDGET_MS, `answered at ${first.at}ms`);

  const out = answer(first);
  assert.equal(out.status, "running", `not a running handle: ${JSON.stringify(out).slice(0, 300)}`);
  assert.equal(out.ok, null, "a run with no verdict yet must not read as a success or a failure");
  assert.equal(first.value.isError, undefined, "a run still going is not an error");
  assert.match(out.run_id || "", /^bar_/, "no run_id to resume");
  assert.equal(out.solution_id, "k15-slow");
  assert.match(out._next, /resume: true, run_id: "bar_/, "the answer does not say how to get THIS run's result");

  // The run goes on: nothing of it is stopped or sent again.
  assert.equal(b.deployPosts(), 1, `the deploy was POSTed ${b.deployPosts()} times`);
  b.releaseDeploys();
  await b.advance(60_000, () => b.sent.some((r) => r.path.endsWith("/github/push")));
  assert.equal(b.deployPosts(), 1, `the deploy was POSTed ${b.deployPosts()} times after the budget answer`);
  assert.ok(b.sent.some((r) => r.path.endsWith("/health")), "the run stopped when the call answered — it must go on");
});

test("http: resume:true answers with THAT run's result and sends no deploy write of its own", async (t) => {
  const b = stubBuilder(t);
  const first = b.call("http", firstDeploy("k15-resume"));
  await b.advance(HOSTED_CALL_BUDGET_MS, () => first.settled);
  assert.equal(first.settled, true, "no answer by the budget");
  const { run_id } = answer(first);
  assert.ok(run_id, "no run_id");

  // Resume while the run is still going: it waits for THAT run.
  const resumed = b.call("http", { solution_id: "k15-resume", resume: true, run_id }, "sess-a2");
  await b.advance(5000, () => resumed.settled);
  assert.equal(resumed.settled, false, "resume answered before the run finished");
  b.releaseDeploys();
  await b.advance(60_000, () => resumed.settled);
  assert.equal(resumed.settled, true, "resume did not answer when the run finished");
  const out = answer(resumed);
  assert.equal(out.ok, true, `resume did not return the run's result: ${JSON.stringify(out).slice(0, 400)}`);
  assert.deepEqual(out.deploy.skills_deployed.map((s) => s.id), ["deployed-by-deploy-1"],
    "the result is not the one this run's deploy produced");
  assert.equal(b.deployPosts(), 1, `a resume sent the deploy again (${b.deployPosts()} POSTs)`);
  // Every write of the run went out once: the resume added none.
  const writes = b.writes().map((w) => `${w.method} ${w.path}`);
  assert.deepEqual(writes, [...new Set(writes)], `a write went out twice: ${JSON.stringify(writes)}`);
  assert.deepEqual(writes, [
    "POST /validate/solution",
    "POST /deploy/solution",
    "POST /deploy/solutions/k15-resume/connectors/walk-guide/upload",
    "POST /deploy/solutions/k15-resume/github/push",
  ]);

  // Resumed again after it finished: the same answer, and not one request.
  const sentBefore = b.sent.length;
  const again = b.call("http", { solution_id: "k15-resume", resume: true }, "sess-a2");
  await b.advance(1000, () => again.settled);
  assert.equal(b.sent.length, sentBefore, `resuming a finished run sent: ${JSON.stringify(b.sent.slice(sentBefore))}`);
  assert.equal(again.value.content[0].text, resumed.value.content[0].text, "a second resume answered differently");

  // And a newer run does not replace it: the run_id still reads its own run.
  const newer = b.call("http", firstDeploy("k15-resume", { test_skill_id: "s1" }));
  await b.advance(HOSTED_CALL_BUDGET_MS, () => newer.settled);
  b.releaseDeploys();
  await b.advance(60_000, () => b.sent.filter((r) => r.path.endsWith("/github/push")).length === 2);
  const byId = b.call("http", { solution_id: "k15-resume", resume: true, run_id });
  await b.advance(1000, () => byId.settled);
  assert.deepEqual(answer(byId).deploy.skills_deployed.map((s) => s.id), ["deployed-by-deploy-1"],
    "run_id answered with the NEWER run's result");
});

test("http: resume with no run to resume deploys nothing and says so", async (t) => {
  const b = stubBuilder(t);
  for (const args of [
    { solution_id: "k15-never", resume: true },
    { solution_id: "k15-never", resume: true, run_id: "bar_nope_00000000" },
    // resume wins over every deploy argument it is sent with
    { ...firstDeploy("k15-never"), resume: true },
  ]) {
    const r = b.call("http", args);
    await b.advance(1000, () => r.settled);
    assert.equal(r.settled, true);
    assert.deepEqual(b.sent, [], `resume sent: ${JSON.stringify(b.sent)}`);
    assert.equal(r.value.isError, true);
    assert.equal(r.value.structuredContent?.code, "NO_RUN_TO_RESUME");
    assert.match(answer(r)._next, /view: "status"/, "does not say where to see what is deployed");
  }
});

test("http: a run is resumable only with the credentials that started it", async (t) => {
  const b = stubBuilder(t);
  const first = b.call("http", firstDeploy("k15-owned"));
  await b.advance(HOSTED_CALL_BUDGET_MS, () => first.settled);
  assert.equal(first.settled, true, "no answer by the budget");
  const { run_id } = answer(first);
  const other = b.call("http", { solution_id: "k15-owned", resume: true, run_id }, "sess-b");
  await b.advance(1000, () => other.settled);
  assert.equal(other.settled, true, "another tenant's resume is waiting on this tenant's run");
  assert.equal(other.value.structuredContent?.code, "NO_RUN_TO_RESUME", "another tenant read this tenant's run");
  const otherSolution = b.call("http", { solution_id: "k15-other", resume: true, run_id });
  await b.advance(1000, () => otherSolution.settled);
  assert.equal(otherSolution.settled, true, "a resume of another solution is waiting on this run");
  assert.equal(otherSolution.value.structuredContent?.code, "NO_RUN_TO_RESUME", "a run_id answered for another solution");
  b.releaseDeploys();
  await b.advance(60_000, () => b.sent.some((r) => r.path.endsWith("/github/push")));
});

test("http: an identical call while the run is in flight joins it; a different one runs its own", async (t) => {
  const b = stubBuilder(t);
  const count = (p) => b.sent.filter((r) => r.path === p).length;
  const first = b.call("http", firstDeploy("k15-join"));
  await b.advance(HOSTED_CALL_BUDGET_MS, () => first.settled);
  assert.equal(first.settled, true, "no answer by the budget");
  const { run_id } = answer(first);

  // The same arguments in another key order: the retry an agent makes.
  const { solution, skills, mcp_store } = firstDeploy("k15-join");
  const retry = b.call("http", { mcp_store, skills, solution });
  await b.advance(5000, () => retry.settled);
  assert.equal(count("/validate/solution"), 1, "the identical retry ran the pipeline again");
  assert.equal(b.deployPosts(), 1, "the identical retry deployed again");

  const edited = b.call("http", firstDeploy("k15-join", { skills: [{ id: "s1", name: "S1 edited" }] }));
  await b.advance(5000, () => edited.settled);
  assert.equal(count("/validate/solution"), 2, "a DIFFERENT payload was answered with the older run");

  b.releaseDeploys();
  await b.advance(30_000, () => retry.settled);
  assert.equal(retry.settled, true);
  assert.deepEqual(answer(retry).deploy.skills_deployed.map((s) => s.id), ["deployed-by-deploy-1"],
    "the retry did not answer with the run it joined");
  const resumed = b.call("http", { solution_id: "k15-join", resume: true, run_id });
  await b.advance(1000, () => resumed.settled);
  assert.equal(resumed.value.content[0].text, retry.value.content[0].text, "the joined call and the run answer differently");

  b.releaseDeploys();
  await b.advance(60_000, () => edited.settled);
  assert.equal(edited.settled, true);
  assert.deepEqual(answer(edited).deploy.skills_deployed.map((s) => s.id), ["deployed-by-deploy-2"],
    "the edited payload was not deployed as its own run");
});

test("no transport stated is not local: the budget applies (api.js callTransport)", async (t) => {
  const b = stubBuilder(t);
  const first = b.call(null, firstDeploy("k15-unstated"));
  await b.advance(HOSTED_CALL_BUDGET_MS, () => first.settled);
  assert.equal(first.settled, true, "a call with no stated transport was held past the budget");
  assert.equal(answer(first).status, "running");
  b.releaseDeploys();
  await b.advance(60_000, () => b.sent.some((r) => r.path.endsWith("/github/push")));
});

// ─── over stdio: unchanged ──────────────────────────────────────────────────

test("stdio: the call holds as long as the pipeline takes and answers with its own result; nothing is held for resume", async (t) => {
  const b = stubBuilder(t);
  const local = b.call("stdio", firstDeploy("k15-stdio"));
  await b.advance(HOSTED_CALL_BUDGET_MS + 15_000, () => local.settled);
  assert.equal(local.settled, false, "a stdio call answered before its run finished");
  b.releaseDeploys();
  await b.advance(60_000, () => local.settled);
  assert.equal(local.settled, true);
  const out = answer(local);
  assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300));
  assert.equal(out.status, undefined, "a stdio call answered with a running handle");
  assert.equal(out.run_id, undefined, "a stdio call was made resumable");
  assert.deepEqual(out.deploy.skills_deployed.map((s) => s.id), ["deployed-by-deploy-1"]);
  assert.equal(b.deployPosts(), 1);

  const sentBefore = b.sent.length;
  const resumed = b.call("http", { solution_id: "k15-stdio", resume: true });
  await b.advance(1000, () => resumed.settled);
  assert.equal(resumed.value.structuredContent?.code, "NO_RUN_TO_RESUME", "a stdio run was held for resume");
  assert.equal(b.sent.length, sentBefore, "resume after a stdio run sent a request");
});

test("stdio: resume:true never deploys there either", async (t) => {
  const b = stubBuilder(t);
  const r = b.call("stdio", { ...firstDeploy("k15-stdio-resume"), resume: true });
  await b.advance(1000, () => r.settled);
  assert.deepEqual(b.sent, [], `resume on stdio sent: ${JSON.stringify(b.sent.map((s) => `${s.method} ${s.path}`))}`);
  assert.equal(r.value.structuredContent?.code, "NO_RUN_TO_RESUME");
});

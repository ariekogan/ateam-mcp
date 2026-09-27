// BUILDER-SEC-DEL-FORCEINJ: A DELETE ID CANNOT INJECT ?force=true, AND A
// DESTRUCTIVE CALL IS NEVER SILENTLY RE-SENT.
//
//   1. ateam_delete_solution pasted solution_id into the URL raw. So
//      solution_id:"walkmate?force=true" in PREVIEW mode (no force, no confirm)
//      became DELETE /deploy/solutions/walkmate?force=true: a forced tenant
//      clear that no confirm had approved. "../x" left the route entirely.
//
//   2. The forced DELETE went out with request()'s default retries (2, since
//      c99acb7). On a 502 it was re-sent without its body being read, and again
//      on request()'s own 120s timeout. The Builder's 502 was a JSON verdict
//      naming the Core step that failed; the caller saw the answer to the last
//      pass instead, which found Core already empty (B7, core_skills: []).
//      CORE ruling 11 makes this general: a response carrying a verdict (a JSON
//      body with a `code`) is never re-sent; a write is re-sent only when it
//      provably never reached the server (a refused connection); a read is also
//      re-sent after a transport failure. api.js mayAutoRetry is the one place
//      that decides. Four async-kick handlers and build_and_run re-sent a write
//      on their own after ANY failure; kickFallsBackToSync now decides that.
//      CORE's probes (pr26-vj-probe.mjs, retry-repro*.mjs) are ported below.
//
//   3. The words. The description never said the delete wipes conversations,
//      memory and stored data, or that it keeps the account; its recovery line
//      ("ateam_github_pull rebuilds from main") named a repo the delete empties.
//      ateam_delete_skill and ateam_delete_connector said "GitHub source is
//      preserved", but the Builder deletes skills/<id>/ and connectors/<id>/
//      from dev AND main (skill-validator routes/deploy.js, writeToRepo
//      op:'delete' with the owner's both-branch default).
//
// Behavioural: the real dispatcher against a local server playing the
// skill-validator, and, where a transport failure is needed, a stubbed fetch
// driven by mock timers (so a 95s timeout or a 5s backoff costs no wall time).
// Run: node --test test/delete-force-injection.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import * as API from "../src/api.js";
import { handleToolCall, tools, SOLUTION_ID_RX } from "../src/tools.js";

const { setSessionCredentials } = API;
const SID = "sess-delete-force-injection";
const KEY = "adas_tenanta_00000000000000000000000000000000";
let routes = {};
let hits = [];
let server;

// A reply is { status, body } (sent as JSON) or { status, html } (sent as-is,
// the way a gateway's error page arrives), or a function returning one per request.
before(async () => {
  server = createServer((req, res) => {
    const pathname = req.url.split("?")[0];
    hits.push(`${req.method} ${req.url}`);
    req.resume();
    req.on("end", () => {
      const route = routes[`${req.method} ${pathname}`];
      const reply = typeof route === "function" ? route() : route;
      if (!reply) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "no route" }));
      }
      if (reply.html !== undefined) {
        res.writeHead(reply.status, { "Content-Type": "text/html" });
        return res.end(reply.html);
      }
      res.writeHead(reply.status || 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, { apiKey: KEY, apiUrl: `http://127.0.0.1:${server.address().port}`, explicit: true });
});
after(() => server.close());

async function call(tool, args, r = {}) {
  routes = r;
  hits = [];
  const res = await handleToolCall(tool, args, SID);
  let out;
  try { out = JSON.parse(res.content[0].text); } catch { out = { text: res.content[0].text }; }
  return { res, out };
}

const FORCE = (id = "walkmate") => ({ solution_id: id, confirm: true, confirm_solution_id: id, force: true });
const FORCE_URL = "DELETE /deploy/solutions/walkmate?force=true";
const DEL_ROUTE = "DELETE /deploy/solutions/walkmate";
const sent = (url) => hits.filter((h) => h === url).length;

// ─── a stubbed fetch, driven by mock timers ─────────────────────────────────
//
// `answers` is called once per fetch with (n, opts) and returns a Response, a
// rejection, or "hang" (never answers; rejects with AbortError when aborted).
// The clock is advanced in 1s steps so every timer request() sets (its abort,
// a backoff) fires in order. Returns what happened by then, settled or not: a
// test must fail on a re-send, not hang waiting for one.
const flush = () => new Promise((r) => setImmediate(r));
async function drive(t, start, answers, { advanceMs }) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const realFetch = globalThis.fetch;
  const log = { sent: 0, abortedAtMs: null, clockMs: 0, settled: false, value: undefined, error: undefined };
  globalThis.fetch = async (_url, opts) => {
    log.sent += 1;
    const a = answers(log.sent, opts, _url);
    if (a !== "hang") return a;
    return new Promise((_, reject) => {
      opts.signal.addEventListener("abort", () => {
        if (log.abortedAtMs === null) log.abortedAtMs = log.clockMs;
        reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
      });
    });
  };
  try {
    start().then((v) => { log.settled = true; log.value = v; }, (e) => { log.settled = true; log.error = e; });
    for (let i = 0; i < 20 && log.sent === 0 && !log.settled; i++) await flush();
    const checkpoints = [];
    for (let ms = 0; ms < advanceMs; ms += 1000) {
      log.clockMs += 1000;
      t.mock.timers.tick(1000);
      await flush(); await flush();
      checkpoints.push({ ms: log.clockMs, aborted: log.abortedAtMs !== null, sent: log.sent });
    }
    for (let i = 0; i < 20 && !log.settled; i++) await flush();
    return { ...log, at: (ms) => checkpoints.find((c) => c.ms === ms) };
  } finally {
    globalThis.fetch = realFetch;
  }
}
const refused = () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const toolOut = (log) => JSON.parse(log.value.content[0].text);

// ─── T21: the id is a path segment ──────────────────────────────────────────

const BAD_IDS = ["x?force=true", "walkmate?force=true", "../x", "a b", "x/y", "x#y", "%2e%2e", "-x", "", " walkmate", "x".repeat(129)];

test("T21: an id that could inject or traverse is refused with ZERO requests, preview and force alike", async () => {
  for (const id of BAD_IDS) {
    for (const args of [{ solution_id: id }, FORCE(id)]) {
      const { res, out } = await call("ateam_delete_solution", args, { [DEL_ROUTE]: { body: { ok: true } } });
      assert.equal(hits.length, 0,
        `solution_id ${JSON.stringify(id)} (${args.force ? "force" : "preview"}) sent ${hits.length} request(s): ${hits.join(", ")}`);
      assert.equal(out.code, "INVALID_SOLUTION_ID", `${JSON.stringify(id)}: ${JSON.stringify(out)}`);
      assert.match(out.error, /Nothing was sent/);
      assert.equal(res.isError, true);
    }
  }
  const { out } = await call("ateam_delete_solution", { confirm: true, force: true }, {});
  assert.equal(hits.length, 0, "a missing solution_id reached the server");
  assert.equal(out.code, "INVALID_SOLUTION_ID");
});

test("(control) T21: a valid id previews without force and forces only with force:true", async () => {
  const preview = await call("ateam_delete_solution", { solution_id: "walkmate" },
    { [DEL_ROUTE]: { body: { ok: true, preview: true, will_clear: { skills: [], connectors: [] } } } });
  assert.deepEqual(hits, ["DELETE /deploy/solutions/walkmate"]);
  assert.equal(preview.out.preview, true);
  assert.match(preview.out._next, /WIPES the tenant's conversations and history, memory facts and stored actor data/);

  const forced = await call("ateam_delete_solution", FORCE("Walk_Mate-2"),
    { "DELETE /deploy/solutions/Walk_Mate-2": { body: { ok: true, cleared: {} } } });
  assert.deepEqual(hits, ["DELETE /deploy/solutions/Walk_Mate-2?force=true"]);
  assert.equal(forced.out.ok, true);
});

test("T21: the id rule is the Builder's own validateSolutionId pattern", () => {
  // apps/backend/src/store/solutions.js validateSolutionId, Builder origin/dev.
  assert.equal(String(SOLUTION_ID_RX), "/^[a-z0-9][a-z0-9_-]{0,127}$/i",
    "SOLUTION_ID_RX is not the Builder's pattern: an id one side accepts, the other refuses");
  for (const ok of ["walkmate", "Walk_Mate-2", "a", "0", "x".repeat(128)]) assert.ok(SOLUTION_ID_RX.test(ok), ok);
});

// ─── T19: a JSON verdict is returned, once ──────────────────────────────────

const STOPPED = {
  ok: false,
  code: "SOLUTION_DELETE_STOPPED",
  stopped_at: "core_skills",
  error: "Core answered HTTP 502 at step 2; steps 3-7 did not run.",
  hint: "re-run once Core recovers",
  steps: [
    { n: 1, step: "core_connectors", state: "done", core_status: 200, deleted: ["walk-trail"] },
    { n: 2, step: "core_skills", state: "failed", core_status: 502 },
    { n: 3, step: "core_ui_plugins", state: "not_run" },
  ],
};

test("T19: a 502 carrying a JSON verdict reaches the caller whole, from ONE DELETE", async () => {
  const { res, out } = await call("ateam_delete_solution", FORCE(), { [DEL_ROUTE]: { status: 502, body: STOPPED } });
  assert.equal(sent(FORCE_URL), 1, `the forced DELETE was sent ${sent(FORCE_URL)} times for one call`);
  assert.equal(hits.length, 1, `unexpected requests: ${hits.join(", ")}`);
  assert.equal(out.code, "SOLUTION_DELETE_STOPPED");
  assert.deepEqual(out.steps, STOPPED.steps, "the verdict's steps did not reach the caller");
  assert.equal(out.stopped_at, "core_skills");
  assert.equal(out.http_status, 502);
  assert.match(out._next, /NOT re-sent/);
  assert.equal(res.isError, true);
  assert.equal(res.structuredContent.code, "SOLUTION_DELETE_STOPPED");
});

test("R4: a 5xx without a `code` is NO_ANSWER, not a verdict — the proxy's own {ok:false,error}, and today's Builder refusal", async () => {
  // pr26-vj-probe D: the skill-validator's 15s proxy abort (deploy.js DELETE /solutions/:id catch).
  const proxyAbort = { ok: false, error: "The operation was aborted due to timeout" };
  const refusal = { ok: false, retryable: true, error: "Refused to delete \"walkmate\": 1 ADAS Core cleanup step(s) failed (skills)", failures: [{ step: "skills", status: 409 }] };
  for (const [status, body] of [[502, proxyAbort], [502, refusal], [500, { ok: false, error: "fetch failed" }]]) {
    const { out } = await call("ateam_delete_solution", FORCE(), { [DEL_ROUTE]: { status, body } });
    assert.equal(sent(FORCE_URL), 1, `the forced DELETE was sent ${sent(FORCE_URL)} times for one call`);
    assert.equal(out.code, "NO_ANSWER", `a ${status} ${JSON.stringify(body)} was read as a verdict: ${JSON.stringify(out)}`);
    assert.deepEqual(out.upstream, body, "the body that came with it was dropped");
    assert.match(out._next, NO_ANSWER_NEXT);
  }
});

test("T19: _next follows the verdict's code — re-run where it finishes the delete, never where it cannot help", async () => {
  const cases = [
    [409, "SOLUTION_TEARDOWN_INCOMPLETE", /Re-running is safe/],
    [500, "SOLUTION_RESET_INCOMPLETE", /Re-running is safe/],
    [502, "GITHUB_CLEANUP_INCOMPLETE", /Re-running is safe/],
    [404, "SOLUTION_NOT_FOUND", /^Do not retry: there is no solution "walkmate"/],
    [403, undefined, /^Do not retry: this key may not delete/],
    [400, "INVALID_SOLUTION_ID", /^Do not retry: the request was refused as invalid/],
    [504, "BUILDER_NO_ANSWER", /may have run/],
  ];
  for (const [status, code, next] of cases) {
    const { out } = await call("ateam_delete_solution", FORCE(),
      { [DEL_ROUTE]: { status, body: { ok: false, ...(code && { code }), error: "x", leftovers: { skills: ["a"] } } } });
    assert.equal(sent(FORCE_URL), 1, `${status} ${code}: sent ${sent(FORCE_URL)} times`);
    assert.equal(out.http_status, status);
    assert.equal(out.code, code);
    assert.deepEqual(out.leftovers, { skills: ["a"] }, `${status} ${code}: the verdict was not returned whole`);
    assert.match(out._next, next, `${status} ${code}: ${out._next}`);
  }
});

// ─── T20: no answer is said, once ───────────────────────────────────────────

const NO_ANSWER_NEXT = /^The delete may have run\. Call the preview first \(.*without force\), then re-issue the forced delete only if it still shows the solution\.$/;

test("T20: a gateway 504/524/502/520 with no JSON body → ONE DELETE, and NO_ANSWER guidance", async () => {
  for (const status of [504, 524, 502, 520]) {
    const { res, out } = await call("ateam_delete_solution", FORCE(),
      { [DEL_ROUTE]: { status, html: `<html><body>${status} Gateway error</body></html>` } });
    assert.equal(sent(FORCE_URL), 1, `a ${status} made the forced DELETE go out ${sent(FORCE_URL)} times`);
    assert.equal(out.code, "NO_ANSWER", `${status}: ${JSON.stringify(out)}`);
    assert.equal(out.http_status, status);
    assert.match(out._next, NO_ANSWER_NEXT);
    assert.match(out.error, /sent once and NOT re-sent/);
    assert.equal(res.structuredContent.code, "NO_ANSWER");
  }
});

test("T20: the force call gives up after CORE's 90s budget and before Cloudflare's ~100s 524 — once, with NO_ANSWER", async (t) => {
  const log = await drive(t, () => handleToolCall("ateam_delete_solution", FORCE(), SID), () => "hang", { advanceMs: 160_000 });
  assert.equal(log.at(90_000).aborted, false, "the forced delete gave up inside CORE's 90s end-to-end budget");
  assert.equal(log.at(99_000).aborted, true,
    "still waiting at 99s: Cloudflare answers 524 at ~100s, so the caller would get the edge's page, not this call's answer");
  assert.equal(log.sent, 1, `after its own timeout the forced DELETE was sent ${log.sent} times`);
  assert.ok(log.settled, "the call never returned after its timeout");
  const out = toolOut(log);
  assert.equal(out.code, "NO_ANSWER");
  assert.match(out.error, /no answer within 95s/);
  assert.match(out._next, NO_ANSWER_NEXT);
});

test("R5: a socket that died after the request went out is NO_ANSWER — once", async (t) => {
  for (const code of ["ECONNRESET", "UND_ERR_SOCKET"]) {
    t.mock.timers.reset();
    const lost = () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code } }));
    const log = await drive(t, () => handleToolCall("ateam_delete_solution", FORCE(), SID), lost, { advanceMs: 30_000 });
    assert.equal(log.sent, 1, `${code}: the forced DELETE was sent ${log.sent} times`);
    const out = toolOut(log);
    assert.equal(out.code, "NO_ANSWER", `${code}: ${JSON.stringify(out)}`);
    assert.match(out.error, new RegExp(`lost after the request was sent \\(${code}\\)`));
  }
});

test("R5: until the Builder joins an in-flight delete, NO_ANSWER never says re-issuing joins it", async () => {
  const { out } = await call("ateam_delete_solution", FORCE(), { [DEL_ROUTE]: { status: 504, html: "<html>504</html>" } });
  assert.doesNotMatch(out._next, /joins|finishes it/, out._next);
  assert.match(out._next, /Call the preview first/);
});

test("(control) T20: a refused connection sent nothing, so it is reported as that, not as 'may have run'", async (t) => {
  const log = await drive(t, () => handleToolCall("ateam_delete_solution", FORCE(), SID), refused, { advanceMs: 30_000 });
  assert.equal(log.sent, 1, `a refused forced DELETE was attempted ${log.sent} times`);
  assert.match(log.value.content[0].text, /Cannot connect to A-Team API/);
  assert.doesNotMatch(log.value.content[0].text, /may have run/);
});

// ─── the api.js helper: CORE ruling 11, for every tool ──────────────────────

test("mayAutoRetry: a JSON verdict never; a transport failure only for an idempotent read", () => {
  const { mayAutoRetry } = API;
  assert.equal(typeof mayAutoRetry, "function", "api.js has no mayAutoRetry — the retry question has no owner");
  const verdict = JSON.stringify({ ok: false, code: "X" });
  const rows = [
    // method, opts, expected
    ["GET", { status: 502, body: "<html>502</html>" }, true],
    ["GET", { status: 504, body: "" }, true],
    ["GET", { noAnswer: true }, true],
    ["GET", { status: 502, body: verdict }, false],
    ["GET", { status: 504, body: verdict }, false],
    ["GET", { status: 500, body: "<html>500</html>" }, false],
    ["GET", { status: 503, body: "" }, false],
    ["GET", { status: 502, body: JSON.stringify({ ok: false, error: "fetch failed" }) }, true],
    ["POST", { status: 502, body: "<html>502</html>" }, false],
    ["POST", { status: 502, body: JSON.stringify({ ok: false, error: "fetch failed" }) }, false],
    ["POST", { noAnswer: true }, false],
    ["DELETE", { status: 504, body: "" }, false],
    ["DELETE", { noAnswer: true }, false],
    ["PATCH", { noAnswer: true }, false],
    ["POST", { neverSent: true }, true],
    ["DELETE", { neverSent: true }, true],
    ["PATCH", { neverSent: true }, true],
    ["POST", { idempotent: true, status: 502, body: "" }, true],
    ["POST", { idempotent: true, noAnswer: true }, true],
    ["POST", { idempotent: true, status: 502, body: verdict }, false],
    ["GET", { idempotent: false, noAnswer: true }, false],
  ];
  for (const [method, f, want] of rows) {
    assert.equal(mayAutoRetry({ method, ...f }), want, `${method} ${JSON.stringify(f)}`);
  }
});

test("jsonVerdictOf: only a body with a `code` is a verdict; a bare {ok:false,error}, a page or nothing is not", () => {
  const { jsonVerdictOf, jsonBodyOf } = API;
  assert.deepEqual(jsonVerdictOf('{"ok":false,"code":"X"}'), { ok: false, code: "X" });
  for (const b of ['{"ok":false,"error":"fetch failed"}', '{"ok":false,"code":""}', "<html>502</html>", "", "   ", '"A timeout occurred"', "[1,2]", "null", "42", undefined, null, { ok: false, code: "X" }]) {
    assert.equal(jsonVerdictOf(b), null, `${JSON.stringify(b)} read as a verdict`);
  }
  assert.deepEqual(jsonBodyOf('{"ok":false,"error":"fetch failed"}'), { ok: false, error: "fetch failed" });
  assert.equal(jsonBodyOf("<html>502</html>"), null);
});

test("a JSON-verdict 502/504 is not re-sent on ANY tool — a GET read, a POST write, a raw get()", async () => {
  const gh = await call("ateam_github_status", { solution_id: "sol" },
    { "GET /deploy/solutions/sol/github/status": { status: 502, body: { ok: false, code: "GITHUB_DOWN", error: "GitHub answered 502" } } });
  assert.equal(sent("GET /deploy/solutions/sol/github/status"), 1,
    `a GET whose 502 carried a JSON verdict was sent ${sent("GET /deploy/solutions/sol/github/status")} times`);
  assert.equal(gh.res.isError, true);

  await call("ateam_github_push", { solution_id: "sol" },
    { "POST /deploy/solutions/sol/github/push": { status: 504, body: { ok: false, code: "PUSH_FAILED", error: "push failed upstream" } } });
  assert.equal(sent("POST /deploy/solutions/sol/github/push"), 1,
    `a POST whose 504 carried a JSON verdict was sent ${sent("POST /deploy/solutions/sol/github/push")} times`);

  routes = { "GET /raw": { status: 504, body: { ok: false, code: "UPSTREAM" } } };
  hits = [];
  const err = await API.get("/raw", SID, { retries: 2 }).then(() => null, (e) => e);
  assert.equal(sent("GET /raw"), 1, `get() re-sent a JSON verdict ${sent("GET /raw")} times`);
  assert.equal(err.status, 504);
});

test("a transport ECONNREFUSED on a read IS re-sent", async (t) => {
  const log = await drive(t, () => API.get("/read", SID, { retries: 2 }),
    (n) => (n === 1 ? refused() : json(200, { ok: true, n })), { advanceMs: 20_000 });
  assert.equal(log.sent, 2, `a GET refused once was sent ${log.sent} times (expected one re-send)`);
  assert.deepEqual(log.value, { ok: true, n: 2 });
});

test("(control) a gateway 502 page on a read IS re-sent", async (t) => {
  const log = await drive(t, () => API.get("/read", SID, { retries: 2 }),
    (n) => (n === 1 ? new Response("<html>502 Bad Gateway</html>", { status: 502 }) : json(200, { ok: true })), { advanceMs: 20_000 });
  assert.equal(log.sent, 2, `a GET behind a gateway 502 page was sent ${log.sent} times`);
  assert.deepEqual(log.value, { ok: true });
});

test("R2: a write whose connection was refused (nothing sent) IS re-sent", async (t) => {
  for (const [name, start] of [
    ["post", () => API.post("/write", { a: 1 }, SID)],
    ["patch", () => API.patch("/write", { a: 1 }, SID)],
    ["del", () => API.del("/write", SID)],
  ]) {
    t.mock.timers.reset();
    const log = await drive(t, start, (n) => (n === 1 ? refused() : json(200, { ok: true, n })), { advanceMs: 20_000 });
    assert.equal(log.sent, 2, `${name}(): a write refused before it was sent went out ${log.sent} times (expected one re-send)`);
    assert.deepEqual(log.value, { ok: true, n: 2 });
  }
});

test("R2: a write that may have reached the server is NOT re-sent — a gateway page, a bare JSON 502, a timeout", async (t) => {
  for (const [what, answer] of [
    ["an HTML 502", () => new Response("<html>502 Bad Gateway</html>", { status: 502 })],
    ["an HTML 504", () => new Response("", { status: 504 })],
    ["a bare {ok:false,error} 502", () => json(502, { ok: false, error: "fetch failed" })],
  ]) {
    t.mock.timers.reset();
    const log = await drive(t, () => API.post("/write", { a: 1 }, SID, { retries: 2 }), answer, { advanceMs: 30_000 });
    assert.equal(log.sent, 1, `a write that got ${what} was sent ${log.sent} times`);
    assert.doesNotMatch(log.error?.message || "", /Try again in a minute/, `${what}: the hint tells the caller to re-send a write`);
  }
  t.mock.timers.reset();
  const log = await drive(t, () => API.post("/write", { a: 1 }, SID, { retries: 2, timeoutMs: 1000 }), () => "hang", { advanceMs: 40_000 });
  assert.equal(log.sent, 1, `a write that timed out was sent ${log.sent} times`);
  assert.equal(log.error?.timedOut, true);
  assert.match(log.error.message, /It was NOT re-sent: a write that got no answer may still have run/);
});

test("every `retries` a tool passes can act: on a get(), or on a call declared idempotent", () => {
  // A `retries` on a write is a promise nothing keeps: mayAutoRetry never
  // re-sends one. Each `retries: N` (N ≥ 1) must sit in a get() call, or in an
  // options object that says `idempotent: true`.
  const src = readFileSync(new URL("../src/tools.js", import.meta.url), "utf8");
  const dead = [];
  for (const m of src.matchAll(/retries:\s*([1-9]\d*)/g)) {
    const before = src.slice(0, m.index);
    const open = before.lastIndexOf("{");
    const close = src.indexOf("}", m.index);
    const opts = src.slice(open, close + 1);
    const verb = [...before.matchAll(/(?<![.\w])(get|post|patch|del)\(/g)].pop()?.[1];
    if (verb !== "get" && !/idempotent:\s*true/.test(opts)) {
      dead.push(`line ${before.split("\n").length}: ${verb}(… ${opts})`);
    }
  }
  assert.deepEqual(dead, [], `a write passes retries that cannot re-send it:\n${dead.join("\n")}`);
});

// ─── R3: an async kick that failed is not re-sent the sync way ────────────
//
// Ported from CORE's retry-repro.mjs: the first send of each write gets a JSON
// verdict 502, every later send would succeed. One write must go out, and the
// caller must see the verdict, not the answer to a later send.

const VERDICT = { status: 502, body: { ok: false, code: "CORE_DEPLOY_FAILED", error: "Core rejected step 3 after writing skill s1" } };
const firstVerdictThenOk = () => {
  let n = 0;
  return () => (++n === 1 ? VERDICT : { status: 200, body: { ok: true, pass: n, note: "answer to a LATER send" } });
};
const writes = () => hits.filter((h) => !h.startsWith("GET "));

const KICKS = [
  ["ateam_redeploy", { solution_id: "sol", skill_id: "s1" }, "POST /deploy/solutions/sol/skills/s1/redeploy"],
  ["ateam_github_pull", { solution_id: "sol" }, "POST /deploy/solutions/sol/github/pull"],
  ["ateam_upload_connector", { solution_id: "sol", connector_id: "c1", github: true }, "POST /deploy/solutions/sol/connectors/c1/upload"],
  ["ateam_create_plugin", { solution_id: "sol", connector_id: "c1", plugin_name: "p1" }, "POST /deploy/solutions/sol/connectors/c1/upload"],
];

test("R3: redeploy, github_pull, upload_connector and create_plugin do NOT re-send after a JSON 502", async () => {
  for (const [tool, args, route] of KICKS) {
    const next = firstVerdictThenOk();
    const { res } = await call(tool, args, { [route]: next });
    assert.equal(writes().length, 1, `${tool}: the write went out ${writes().length} times after a JSON 502: ${writes().join(", ")}`);
    assert.match(res.content[0].text, /CORE_DEPLOY_FAILED/, `${tool}: the caller did not see the verdict`);
    assert.doesNotMatch(res.content[0].text, /answer to a LATER send/, `${tool}: the caller saw a later send's answer`);
  }
});

test("R3: build_and_run does NOT re-POST the deploy after a JSON 502", async () => {
  const next = firstVerdictThenOk();
  const { res, out } = await call("ateam_build_and_run",
    { solution: { id: "sol", name: "Sol" }, skills: [{ id: "s1", name: "S1" }], mcp_store: {} }, {
      "POST /validate/solution": { body: { ok: true, errors: [], warnings: [] } },
      "POST /deploy/solution": next,
    });
  assert.equal(sent("POST /deploy/solution"), 1, `the deploy was POSTed ${sent("POST /deploy/solution")} times after a JSON 502`);
  assert.match(out.error || res.content[0].text, /CORE_DEPLOY_FAILED/);
});

test("R3: an async kick that got no answer in 30s is not re-sent either (upload_connector)", async (t) => {
  const log = await drive(t,
    () => handleToolCall("ateam_upload_connector", { solution_id: "sol", connector_id: "c1", github: true }, SID),
    () => "hang", { advanceMs: 60_000 });
  assert.equal(log.sent, 1, `a kick that timed out was sent ${log.sent} times`);
  assert.ok(log.settled, "the call never returned");
});

test("(control) R3: the sync door is still used when the kick never reached the server or the server has no async door", async (t) => {
  const { out } = await call("ateam_github_pull", { solution_id: "sol" }, {
    "POST /deploy/solutions/sol/github/pull": (() => { let n = 0; return () => (++n === 1 ? { status: 404, body: { error: "Cannot POST" } } : { status: 200, body: { ok: true, sync: true } }); })(),
  });
  assert.equal(sent("POST /deploy/solutions/sol/github/pull"), 2, "a 404 kick (no async door) did not fall back to sync");
  assert.equal(out.sync, true);

  const log = await drive(t,
    () => handleToolCall("ateam_github_pull", { solution_id: "sol" }, SID),
    (n) => (n <= 3 ? refused() : json(200, { ok: true, sync: true })), { advanceMs: 60_000 });
  assert.equal(log.sent, 4, `a kick refused 3 times (never sent) should fall back to sync once; sent ${log.sent}`);
  assert.equal(toolOut(log).sync, true);
});

// ─── CORE's pr26-vj-probe: reads re-sent after a hop lost the answer ─────────

test("vj-probe B/H: a GET read behind the proxy's own {ok:false,error} 502, or an HTML 502, IS re-sent", async (t) => {
  for (const first of [
    () => json(502, { ok: false, error: "fetch failed" }),
    () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
  ]) {
    t.mock.timers.reset();
    const log = await drive(t, () => handleToolCall("ateam_github_status", { solution_id: "walkmate" }, SID),
      (n) => (n === 1 ? first() : json(200, { ok: true, exists: true })), { advanceMs: 20_000 });
    assert.equal(log.sent, 2, `the read was sent ${log.sent} times`);
    assert.equal(toolOut(log).exists, true);
  }
});

test("vj-probe C + R5: the pure reads over POST/DELETE are re-sent after a lost answer", async (t) => {
  const NOT_A_VERDICT = { ok: false, error: "Could not resolve authored state for validation: fetch failed", hint: "This is NOT a verdict about the solution — nothing was validated." };
  const cases = [
    ["ateam_validate_solution", { solution: { id: "walkmate" }, skills: [] }, "/validate/solution", true],
    ["ateam_delete_solution (preview)", { solution_id: "walkmate" }, "/deploy/solutions/walkmate", true],
    ["ateam_github_reconcile dry_run", { solution_id: "walkmate", dry_run: true }, "/reconcile", true],
    ["ateam_github_sync_from_main dry_run", { solution_id: "walkmate", dry_run: true }, "/sync-from-main", true],
    ["ateam_github_reconcile (not a dry run)", { solution_id: "walkmate" }, "/reconcile", false],
  ];
  for (const [label, args, path, read] of cases) {
    t.mock.timers.reset();
    const tool = label.split(" ")[0];
    let onPath = 0;
    const log = await drive(t, () => handleToolCall(tool, args, SID),
      (_n, _o, url) => (String(url).split("?")[0].endsWith(path) && ++onPath === 1 ? json(502, NOT_A_VERDICT) : json(200, { ok: true, valid: true, errors: [], warnings: [] })),
      { advanceMs: 20_000 });
    assert.equal(onPath, read ? 2 : 1, `${label}: sent ${onPath} times`);
  }

  // build_and_run's validate phase is the same read.
  t.mock.timers.reset();
  let validates = 0;
  await drive(t, () => handleToolCall("ateam_build_and_run", { solution: { id: "sol", name: "Sol" }, skills: [{ id: "s1" }], mcp_store: {} }, SID),
    (_n, _o, url) => {
      const u = String(url);
      if (u.endsWith("/validate/solution")) return ++validates === 1 ? json(502, NOT_A_VERDICT) : json(200, { ok: true, errors: [], warnings: [] });
      if (u.endsWith("/deploy/solution")) return json(VERDICT.status, VERDICT.body);
      return json(404, { error: "no route" });
    }, { advanceMs: 20_000 });
  assert.equal(validates, 2, `build_and_run's validate phase was sent ${validates} times`);
});

test("R5: formatError tells a read to try again, never a write", () => {
  const { formatError } = API;
  for (const status of [500, 502, 503]) {
    assert.match(formatError("GET", "/r", status, "<html></html>", ""), /Try again in a minute/, `GET ${status}`);
    const w = formatError("POST", "/w", status, "<html></html>", "");
    assert.doesNotMatch(w, /Try again/, `POST ${status}: ${w}`);
    assert.match(w, /was not re-sent: check whether it took effect/);
    assert.match(formatError("POST", "/r", status, "", "", { read: true }), /Try again in a minute/, `idempotent POST ${status}`);
  }
});

// ─── T22: the words ─────────────────────────────────────────────────────────

const RECOVERY =
  "Code and config can be recovered from git history, and rolling main back to a prod tag restores the files. " +
  "Conversations, memory and stored data are gone and cannot be recovered.";
const def = (name) => tools.find((x) => x.name === name);
const allText = (o) => JSON.stringify(o);

test("T22: ateam_delete_solution's description says what it wipes, what it keeps, and CORE's recovery line", () => {
  const d = def("ateam_delete_solution").description;
  assert.match(d, /removes EVERY skill and connector from the tenant's Core registry/);
  assert.match(d, /deletes the solution record/);
  assert.match(d, /WIPES the tenant's conversations and history, memory facts and stored actor data/);
  assert.match(d, /clears the voice configuration/);
  assert.match(d, /KEEPS the tenant account, its members and its settings/);
  assert.ok(d.includes(RECOVERY), "the recovery sentence is not CORE's approved text");
  assert.doesNotMatch(allText(def("ateam_delete_solution")), /ateam_github_pull rebuilds from main|ateam_github_pull/,
    "the description still names ateam_github_pull as the recovery");
  // PR-3a does not claim GitHub removal: that wording ships with the Builder's PR-2.
  assert.doesNotMatch(d, /(remov|delet)[^.]*\b(GitHub|repo|dev and main)\b/i, "claims GitHub removal before the Builder does it");
});

test("T22: the force refusal says the same, and sends nothing", async () => {
  const { out } = await call("ateam_delete_solution", { solution_id: "walkmate", force: true, confirm_solution_id: "walkmate" }, {});
  assert.equal(hits.length, 0);
  assert.match(out.error, /WIPES the tenant's conversations and history, memory facts and stored actor data/);
  assert.match(out.error, /KEEPS the tenant account, its members and its settings/);
  assert.equal(out.recovery, RECOVERY);
  assert.doesNotMatch(allText(out), /ateam_github_pull/);
});

test("T22: skill and connector deletes no longer claim the GitHub source is preserved", async () => {
  const skill = await call("ateam_delete_skill", { solution_id: "sol", skill_id: "k" }, {});
  const conn = await call("ateam_delete_connector", { solution_id: "sol", connector_id: "c" }, {});
  assert.equal(hits.length, 0);
  for (const [what, text] of [
    ["ateam_delete_skill description", def("ateam_delete_skill").description],
    ["ateam_delete_skill refusal", allText(skill.out)],
    ["ateam_delete_connector description", def("ateam_delete_connector").description],
    ["ateam_delete_connector refusal", allText(conn.out)],
  ]) {
    assert.doesNotMatch(text, /GitHub source is preserved|still lives in GitHub|can resurrect|ateam_github_pull/i, `${what}: ${text}`);
    assert.match(text, /dev and main|main AND dev/i, `${what} does not say the source goes from both branches`);
  }
});

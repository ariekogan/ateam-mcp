// A TIMEOUT IS KNOWN BY ITS STATUS, NOT BY WHAT ITS BODY SAYS — AND A PROBE
// THAT LAUNCHES A BROWSER IS NOT RETRIED BEHIND THE CALLER'S BACK.
//
//   1. ateam_build_and_run and ateam_redeploy each classified a failure as a
//      timeout with /524|502|503|timeout|ETIMEDOUT/ over err.message. That
//      message carries up to 2000 chars of the response body (formatError), so a
//      deterministic 400 whose body said "timeout" was a timeout: build_and_run
//      then re-POSTed the whole deploy in async mode instead of returning the
//      real error, and redeploy told the caller its 15-minute poll had run out.
//      Both now ask api.js isTimeoutError, which reads the status and request()'s
//      own timeout mark.
//
//   2. ateam_verify_surface posted with { timeoutMs: 60000 } and request()'s
//      default retries:2 — up to three headless-browser probes and ~195s for a
//      call whose comment budgets 60s. A retry does not stop the probe already
//      running in Core; it starts another one.
//
//   3. formatError normalized the body three times, three ways.
//
// Behavioural: the real dispatcher against a local server playing the Builder.
// Run: node --test test/timeout-by-status.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import * as API from "../src/api.js";
// Namespace import: a missing export fails ITS test below, not the whole file.
const { setSessionCredentials, formatError } = API;
import { handleToolCall } from "../src/tools.js";

const SID = "sess-timeout-by-status";
let routes = {};
let hits = [];
let server;

before(async () => {
  server = createServer((req, res) => {
    const key = `${req.method} ${req.url.split("?")[0]}`;
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      hits.push({ key, body: body ? JSON.parse(body) : null });
      const hit = routes[key];
      const reply = typeof hit === "function" ? hit(body ? JSON.parse(body) : null) : hit;
      res.writeHead(reply?.status || (reply ? 200 : 404), { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply ? reply.body : { error: "no route" }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, {
    apiKey: "adas_tenanta_00000000000000000000000000000000",
    apiUrl: `http://127.0.0.1:${server.address().port}`,
    explicit: true,
  });
});
after(() => server.close());

async function call(tool, args, r) {
  routes = r;
  hits = [];
  const res = await handleToolCall(tool, args, SID);
  let out;
  try { out = JSON.parse(res.content[0].text); } catch { out = { text: res.content[0].text }; }
  return { res, out };
}
const count = (key) => hits.filter((h) => h.key === key).length;

// ─── 1a. build_and_run ───────────────────────────────────────────────────────

const DEPLOY_BASE = {
  "POST /validate/solution": { body: { valid: true, errors: [], warnings: [] } },
  "GET /deploy/solutions/sol/health": { body: { ok: true } },
  "GET /deploy/solutions/sol/definition": { body: { solution: {} } },
  "GET /deploy/solutions/sol/ui-plugins": { body: { plugins: [] } },
  "POST /deploy/solutions/sol/github/push": { body: { ok: true, skipped: true, reason: "GitHub integration disabled" } },
  "GET /deploy/solutions/sol/github/connected": { body: { ok: true, enabled: false, connected: false } },
};
const buildAndRun = (deployRoute, extra = {}) => call("ateam_build_and_run",
  { solution: { id: "sol", name: "Sol" }, skills: [{ id: "k" }] },
  { ...DEPLOY_BASE, "POST /deploy/solution": deployRoute, ...extra });

test("build_and_run: a 400 whose body mentions 'timeout' is returned as the 400 it is", async () => {
  const { out } = await buildAndRun({
    status: 400,
    body: { ok: false, error: "connector 'weather-mcp': field `timeout` must be a number (got \"503ms\")" },
  });
  assert.equal(count("POST /deploy/solution"), 1,
    "a deterministic 400 was re-POSTed in async mode as if it had timed out");
  assert.equal(out.ok, false);
  assert.doesNotMatch(out.error, /Sync timed out/, `reported as a timeout: ${out.error}`);
  assert.match(out.error, /returned 400/);
});

test("(control) build_and_run: a gateway 524 still falls back to async and polls", async () => {
  const { out } = await buildAndRun((body) => body?.async
    ? { body: { ok: true, async: true, job_id: "job_1" } }
    : { status: 524, body: "A timeout occurred" },
  { "GET /deploy/jobs/job_1": { body: { status: "done", ok: true, import: { skills: ["k"], connectors: 0 } } } });
  assert.equal(count("POST /deploy/solution"), 2, "a 524 did not fall back to async");
  assert.ok(out.phases.some((p) => p.phase === "deploy" && p.status === "async_retry"));
});

// ─── 1b. redeploy ────────────────────────────────────────────────────────────

test("redeploy: a 500 whose body mentions 'timeout' is not reported as a 15-minute timeout", async () => {
  const fail = { status: 500, body: { ok: false, error: "connector restart failed: upstream said ETIMEDOUT (timeout)" } };
  const { out } = await call("ateam_redeploy", { solution_id: "sol" }, {
    "POST /deploy/solutions/sol/redeploy": fail,
  });
  assert.equal(out.ok, false);
  assert.doesNotMatch(out.hint || "", /timed out/, `a 500 was described as a timeout: ${out.hint}`);
});

test("(control) redeploy: a gateway 524 still gets the timeout hint", async () => {
  const { out } = await call("ateam_redeploy", { solution_id: "sol" }, {
    "POST /deploy/solutions/sol/redeploy": { status: 524, body: "A timeout occurred" },
  });
  assert.match(out.hint || "", /timed out/);
});

// ─── 2. verify_surface is ONE probe ──────────────────────────────────────────

test("verify_surface: a gateway error is not retried into a second and third probe", async () => {
  const path = "POST /deploy/solutions/sol/plugins/mcp%3Aw%3Ap/verify-surface";
  const { res } = await call("ateam_verify_surface", { solution_id: "sol", plugin_id: "mcp:w:p" }, {
    [path]: { status: 504, body: { ok: false, error: "gateway timeout" } },
  });
  assert.equal(count(path), 1, `the probe was POSTed ${count(path)} times for one call`);
  assert.equal(res.isError, true);
});

// ─── the owner ───────────────────────────────────────────────────────────────

test("isTimeoutError reads the status and request()'s mark, never the words", () => {
  const { isTimeoutError } = API;
  assert.equal(typeof isTimeoutError, "function", "api.js has no isTimeoutError — the question has no owner");
  const withStatus = (status, message = "x") => Object.assign(new Error(message), { status });
  for (const s of [502, 503, 504, 524]) assert.equal(isTimeoutError(withStatus(s)), true, `status ${s}`);
  assert.equal(isTimeoutError(withStatus(400, "field timeout must be a number; 503; ETIMEDOUT")), false);
  assert.equal(isTimeoutError(withStatus(500, "upstream timeout")), false);
  assert.equal(isTimeoutError(Object.assign(new Error("A-Team API timeout"), { timedOut: true })), true);
  assert.equal(isTimeoutError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } })), true);
  assert.equal(isTimeoutError(new Error("timeout")), false, "the message alone decided");
  assert.equal(isTimeoutError(undefined), false);
});

test("request() marks its OWN timeout, so the owner can see it without the words", async () => {
  const { isTimeoutError } = API;
  const hang = createServer(() => { /* never answers */ });
  await new Promise((r) => hang.listen(0, "127.0.0.1", r));
  const sid = "sess-timeout-mark";
  setSessionCredentials(sid, { apiKey: "adas_tenanta_00000000000000000000000000000000", apiUrl: `http://127.0.0.1:${hang.address().port}`, explicit: true });
  try {
    const err = await API.get("/slow", sid, { timeoutMs: 100, retries: 0 }).then(() => null, (e) => e);
    assert.ok(err, "a request that never answered resolved");
    assert.equal(err.timedOut, true, "request() threw its timeout without marking it");
    assert.equal(isTimeoutError(err), true);
  } finally {
    hang.closeAllConnections?.();
    hang.close();
  }
});

// ─── 3. formatError reads its body ONCE ──────────────────────────────────────

test("formatError normalizes the body in one place", () => {
  const src = formatError.toString();
  const copies = src.match(/typeof body === "string"/g) || [];
  assert.equal(copies.length, 1, `formatError normalizes its body ${copies.length} times — they drift`);
});

test("(control) every check formatError makes still reads the body", () => {
  const cfg = formatError("POST", "/chat", 500, JSON.stringify({ message: "OPENAI_API_KEY is not set" }), "https://api.x");
  assert.match(cfg, /CONFIGURATION, not an outage/);
  assert.match(formatError("POST", "/p", 409, JSON.stringify({ error: "github_not_connected" }), ""), /GitHub isn't connected/);
  const specific = formatError("POST", "/p", 404, JSON.stringify({ code: "NO_MATCH", hint: "copy the exact bytes" }), "");
  assert.doesNotMatch(specific, /Hint: Resource not found/, "a generic hint was appended to a specific one");
  const long = formatError("POST", "/p", 422, "x".repeat(2500), "");
  assert.match(long, /… \(truncated\)/);
  assert.match(formatError("POST", "/p", 422, { failures: ["a"] }, ""), /\{"failures":\["a"\]\}/, "an object body is not rendered");
  assert.doesNotMatch(formatError("POST", "/p", 500, undefined, ""), / — /, "an absent body rendered as detail");
});

// MGAP-A19 (client half): A SUCCESS WITH NO BODY IS NAMED, NOT A SYNTAXERROR.
//
// request() parsed every 2xx with `res.json()`, unchanged since the first
// commit (1be27f6; moved into request() by a3f8b26). An empty body made that
// "Unexpected end of JSON input": a bare SyntaxError with no call, no status
// and no server in it. That is what an agent got from
// ateam_get_spec(topic:'skill', search:'voice_native') when the Builder's
// /spec/skill?search answered 200 with nothing (77b1806; fixed on the Builder
// by ac55a15 and 386de00). The client must say what happened whatever the
// server does: EMPTY_RESPONSE, naming the method, the path and the status.
//
// 204: no route this client calls answers one (checked Builder and Core
// origin/dev: the only 204s are CORS preflights and a connector's own route),
// and a 204 threw the same SyntaxError before. Every caller reads fields off
// the result, so a 204 is EMPTY_RESPONSE too rather than a null that fails
// later, unnamed.
//
// Behavioural: request() and the real dispatcher against a local server.
// Run: node --test test/empty-2xx-body.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import * as API from "../src/api.js";
import { handleToolCall } from "../src/tools.js";

const { setSessionCredentials, formatError, get, post } = API;

const SID = "sess-empty-2xx-body";
let routes = {};
let hits = [];
let server;
let origin;

before(async () => {
  server = createServer((req, res) => {
    const key = `${req.method} ${req.url}`;
    req.resume();
    req.on("end", () => {
      hits.push(key);
      const r = routes[key] || { status: 404, raw: JSON.stringify({ error: "no route" }) };
      res.writeHead(r.status, r.status === 204 ? {} : { "Content-Type": "application/json" });
      res.end(r.raw);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
  setSessionCredentials(SID, {
    apiKey: "adas_tenanta_00000000000000000000000000000000",
    apiUrl: origin,
    explicit: true,
  });
});
after(() => server.close());

function serve(r) {
  routes = r;
  hits = [];
}

const EMPTY = { status: 200, raw: "" };
const SEARCH = "/spec/skill?search=voice_native";

// ─── the gap ────────────────────────────────────────────────────────────────

test("a 200 with an empty body is EMPTY_RESPONSE naming the method, path and status", async () => {
  serve({ [`GET ${SEARCH}`]: EMPTY });
  const err = await get(SEARCH, SID).then(
    (v) => assert.fail(`resolved with ${JSON.stringify(v)}: an empty body read as a result`),
    (e) => e,
  );
  assert.equal(err.code, "EMPTY_RESPONSE", `got ${err.name}: ${err.message}`);
  assert.doesNotMatch(err.message, /Unexpected end of JSON input/);
  assert.match(err.message, /GET \/spec\/skill\?search=voice_native answered 200 with an empty body/);
  assert.match(err.message, /the server answered success with no body/);
  assert.ok(err.message.includes(`(server: ${origin})`), err.message);
  assert.equal(err.status, 200);
  assert.equal(err.method, "GET");
  assert.equal(err.path, SEARCH);
  // The server answered: an answer is not re-sent, even for a read.
  assert.equal(hits.length, 1, `sent ${hits.length} times`);
});

test("a whitespace-only 200 body is EMPTY_RESPONSE too", async () => {
  serve({ "GET /spec/enums": { status: 200, raw: " \n\t " } });
  await assert.rejects(get("/spec/enums", SID), (e) => {
    assert.equal(e.code, "EMPTY_RESPONSE", `got ${e.name}: ${e.message}`);
    assert.match(e.message, /GET \/spec\/enums answered 200 with an empty body/);
    return true;
  });
});

test("through the dispatcher: ateam_get_spec(skill, search) fails with code EMPTY_RESPONSE", async () => {
  serve({ [`GET ${SEARCH}`]: EMPTY });
  const res = await handleToolCall("ateam_get_spec", { topic: "skill", search: "voice_native" }, SID);
  const text = res.content[0].text;
  assert.equal(res.isError, true, text);
  assert.equal(res.structuredContent?.code, "EMPTY_RESPONSE", text);
  assert.doesNotMatch(text, /Unexpected end of JSON input/);
  assert.match(text, /GET \/spec\/skill\?search=voice_native answered 200/);
});

test("a write answered 200 with no body is EMPTY_RESPONSE, sent once, and says it may have run", async () => {
  serve({ "POST /deploy/solutions/sol/skills/k/redeploy": EMPTY });
  await assert.rejects(post("/deploy/solutions/sol/skills/k/redeploy", {}, SID), (e) => {
    assert.equal(e.code, "EMPTY_RESPONSE", `got ${e.name}: ${e.message}`);
    assert.match(e.message, /POST \/deploy\/solutions\/sol\/skills\/k\/redeploy answered 200/);
    assert.match(e.message, /not re-sent, and it may have taken effect/);
    return true;
  });
  assert.equal(hits.length, 1, `sent ${hits.length} times`);
});

test("a 204 is EMPTY_RESPONSE as well: no caller reads a result-less success", async () => {
  serve({ "DELETE /deploy/solutions/sol/skills/k": { status: 204, raw: "" } });
  await assert.rejects(API.del("/deploy/solutions/sol/skills/k", SID), (e) => {
    assert.equal(e.code, "EMPTY_RESPONSE", `got ${e.name}: ${e.message}`);
    assert.equal(e.status, 204);
    assert.match(e.message, /DELETE \/deploy\/solutions\/sol\/skills\/k answered 204/);
    return true;
  });
});

// ─── controls: what had a body behaves as before ────────────────────────────

test("control: a 2xx JSON body is returned as parsed, objects, arrays and null alike", async () => {
  serve({
    "GET /spec/skill": { status: 200, raw: JSON.stringify({ topic: "skill", sections: ["a"] }) },
    "GET /deploy/tenants": { status: 200, raw: "[1,2]" },
    "GET /null": { status: 200, raw: "null" },
    "POST /made": { status: 201, raw: JSON.stringify({ ok: true, id: "x" }) },
  });
  assert.deepEqual(await get("/spec/skill", SID), { topic: "skill", sections: ["a"] });
  assert.deepEqual(await get("/deploy/tenants", SID), [1, 2]);
  assert.equal(await get("/null", SID), null);
  assert.deepEqual(await post("/made", {}, SID), { ok: true, id: "x" });
});

test("control: an empty body on an error status is still that status's error", async () => {
  serve({ "GET /deploy/solutions/nope": { status: 404, raw: "" } });
  await assert.rejects(get("/deploy/solutions/nope", SID), (e) => {
    assert.equal(e.code, undefined);
    assert.equal(e.status, 404);
    assert.equal(e.body, "");
    assert.equal(e.message, formatError("GET", "/deploy/solutions/nope", 404, "", origin, { read: true }));
    return true;
  });
});

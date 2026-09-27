// MGAP-A3: ateam_spec_search answers a session that has NOT signed in.
//
// 3a23931 (2026-07-19) sent it to the Builder's POST /spec/search, which the
// Builder's apiKeyAuth exempts: public docs, no tenant, no LLM. b90f423
// (2026-07-21) moved it, with the advisor, onto the key-gated connector-call
// route (/deploy/solutions/_/connectors/sysSpecSearch-mcp/call) to dodge prod
// /spec 404s. 8e84d1f moved the advisor back once the relay forwarded /spec and
// left this one behind. From then on an agent that had not signed in got
// 401 "Missing API key" from the one doc search bootstrap names as the door
// that works when the advisor does not — "neither fails the way the advisor
// can" (2268b3f). Checked on prod and dev on 2026-09-27: POST /spec/search with
// no key answers 200, the connector-call route 401.
//
// The stand-in below answers the way the Builder's apiKeyAuth does: GET
// /spec/* and POST /spec/search are open, any other route without X-API-KEY
// is 401 "Missing API key". The session under test holds NO credentials, and
// the process has no ADAS_API_KEY: an outside agent before any sign-in.
//
// Run: node --test test/spec-search-keyless.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readdirSync, readFileSync } from "node:fs";

const SID = "sess-never-signed-in";
let hits = [];
let server;
let origin;
let handleToolCall;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const path = req.url.split("?")[0];
      hits.push({ method: req.method, path, key: req.headers["x-api-key"] || null, body: body ? JSON.parse(body) : null });
      const open = (req.method === "GET" && path.startsWith("/spec")) || (req.method === "POST" && path === "/spec/search");
      const send = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (!open && !req.headers["x-api-key"]) return send(401, { error: "Missing API key", hint: "Include header: X-API-KEY: adas_<env>_<key>" });
      if (path === "/spec/search") {
        return send(200, { ok: true, query: "q", count: 1, results: [{ topic: "actor-storage", heading_path: "when_to_use", text: "per-user state", score: 0.9 }] });
      }
      return send(200, { topic: path.split("/").pop(), questions: [{ id: "q1" }] });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
  // An agent before sign-in: no key anywhere, the process default API is the
  // stand-in. api.js reads both when it loads, so set them first.
  delete process.env.ADAS_API_KEY;
  delete process.env.ADAS_TENANT;
  process.env.ADAS_API_URL = origin;
  ({ handleToolCall } = await import("../src/tools.js"));
});
after(() => server.close());

async function call(tool, args) {
  hits = [];
  const res = await handleToolCall(tool, args, SID);
  return { res, text: res.content[0].text };
}

test("a session that never signed in gets search results, from the keyless route", async () => {
  const { res, text } = await call("ateam_spec_search", { query: "per-user persistence", top_k: 2 });
  assert.ok(!res.isError, `ateam_spec_search failed without sign-in: ${text.slice(0, 300)}`);
  const out = JSON.parse(text);
  assert.equal(out.count, 1);
  assert.equal(out.results[0].topic, "actor-storage");
  assert.deepEqual(hits.map((h) => `${h.method} ${h.path}`), ["POST /spec/search"]);
  assert.deepEqual(hits[0].body, { query: "per-user persistence", top_k: 2 });
  assert.equal(hits[0].key, null, "a key was sent from a session that holds none");
});

// The bootstrap names its keyless doors in prose. Read them out of the text an
// agent reads and drive each one with no credentials: the claim, checked.
test("every door bootstrap says needs no sign-in answers with no sign-in", async () => {
  const { text } = await call("ateam_bootstrap", {});
  const claim = JSON.parse(text).design_advisor.if_the_advisor_does_not_answer;
  assert.match(claim, /NO sign-in/, "the text no longer states the claim this test checks");
  const doors = [
    ...[...claim.matchAll(/ateam_get_spec\(topic:'([\w-]+)'\)/g)].map((m) => ["ateam_get_spec", { topic: m[1] }]),
    ...(/ateam_spec_search\(/.test(claim) ? [["ateam_spec_search", { query: "how do I remember each user?" }]] : []),
  ];
  assert.ok(doors.length >= 3, `found only ${doors.length} doors in: ${claim}`);
  for (const [tool, args] of doors) {
    const { res, text: out } = await call(tool, args);
    assert.ok(!res.isError, `${tool}(${JSON.stringify(args)}) failed without sign-in: ${out.slice(0, 200)}`);
    assert.ok(hits.length > 0 && hits.every((h) => h.key === null), `${tool}: ${JSON.stringify(hits)}`);
  }
});

test("the key-gated connector-call route is gone from the source, not just unused", () => {
  const offenders = [];
  for (const f of readdirSync(new URL("../src/", import.meta.url)).filter((n) => n.endsWith(".js"))) {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    // The route as code builds it, and the tool it called there.
    if (/\/connectors\/sysSpecSearch-mcp\/call|["'`]sysSpecSearch\.search["'`]/.test(src)) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});

// (control) The stand-in must refuse what the Builder refuses, or the first
// test could not have failed on the old route.
test("(control) the stand-in refuses the old route without a key, as the Builder does", async () => {
  const r = await fetch(`${origin}/deploy/solutions/_/connectors/sysSpecSearch-mcp/call`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "sysSpecSearch.search", args: { query: "q" } }),
  });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, "Missing API key");
});

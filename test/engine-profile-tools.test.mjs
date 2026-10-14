// The two engine-profile tools reach the Builder's /deploy/engine-profiles door:
// list = GET, set = PUT { activeProfile, shadowProfile, builderProfile }, null clears, and nothing else is sent.
// Run: node --test test/engine-profile-tools.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setSessionCredentials } from "../src/api.js";
import { handleToolCall, tools, toolSafetyClass } from "../src/tools.js";

const SID = "sess-engine-profiles";
const seen = [];
let server;
before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, profiles: [{ name: "live" }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, { apiKey: "adas_tenanta_00000000000000000000000000000000", apiUrl: `http://127.0.0.1:${server.address().port}`, explicit: true });
});
after(() => server.close());

test("list is a GET of the door", async () => {
  seen.length = 0;
  await handleToolCall("ateam_list_engine_profiles", {}, SID);
  assert.deepEqual(seen.map((s) => [s.method, s.url]), [["GET", "/deploy/engine-profiles"]]);
});

test("set sends all three roles; one left out goes as null (the platform default)", async () => {
  seen.length = 0;
  await handleToolCall("ateam_set_engine_profile", { live_profile: "a", builder_profile: "strong" }, SID);
  await handleToolCall("ateam_set_engine_profile", {}, SID);
  assert.deepEqual(seen.map((s) => [s.method, s.body]), [
    ["PUT", { activeProfile: "a", shadowProfile: null, builderProfile: "strong" }],
    ["PUT", { activeProfile: null, shadowProfile: null, builderProfile: null }],
  ]);
});

test("a non-string profile is refused before anything is sent", async () => {
  seen.length = 0;
  const r = await handleToolCall("ateam_set_engine_profile", { shadow_profile: 5 }, SID);
  assert.equal(seen.length, 0);
  assert.match(r.content[0].text, /shadow_profile must be a profile name/);
});

test("both tools are registered and safety-classed", () => {
  for (const n of ["ateam_list_engine_profiles", "ateam_set_engine_profile"]) {
    assert.ok(tools.some((t) => t.name === n));
    assert.ok(toolSafetyClass.has(n));
  }
});

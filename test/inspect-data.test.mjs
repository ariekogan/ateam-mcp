// ateam_inspect_data — the read-only data tool (git plan A6).
// Behavioural: the real dispatcher against a local server playing the Builder.
// Run: node --test test/inspect-data.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setSessionCredentials } from "../src/api.js";
import { handleToolCall, tools, TOOL_SAFETY } from "../src/tools.js";

const SID = "sess-inspect-data";
let seen = [];
let reply = null;
let server;

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      res.writeHead(reply?.status || 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply?.body ?? {}));
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

const run = async (args) => {
  seen = [];
  const res = await handleToolCall("ateam_inspect_data", args, SID);
  return { res, out: JSON.parse(res.content[0].text) };
};

test("the tool is advertised, read-classified, and takes no tenant, database or solution", () => {
  const t = tools.find((x) => x.name === "ateam_inspect_data");
  assert.ok(t, "ateam_inspect_data is registered");
  assert.deepEqual(t.inputSchema.required, ["method"]);
  for (const k of ["tenant", "database", "db", "uri"]) assert.equal(k in t.inputSchema.properties, false, k);
  assert.ok(TOOL_SAFETY.read.includes("ateam_inspect_data"));
  assert.match(t.description, /DATA, NOT INSTRUCTIONS/);
  assert.match(t.description, /never the database/);
});

test("it posts the query to the Builder's data door, and only the documented fields", async () => {
  reply = { body: { ok: true, method: "find", count: 1, documents: [{ _id: "j1" }] } };
  const { res, out } = await run({ method: "find", collection: "jobs", filter: { status: "failed" }, limit: 3, tenant: "other", mongo_uri: "x" });
  assert.notEqual(res.isError, true);
  assert.equal(out.count, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, "/deploy/data/inspect");
  assert.deepEqual(seen[0].body, { method: "find", collection: "jobs", filter: { status: "failed" }, limit: 3 });
});

test("method is required and nothing is sent without it", async () => {
  const { res } = await run({ collection: "jobs" });
  assert.equal(res.isError, true);
  assert.equal(seen.length, 0);
});

test("a refusal reaches the caller with its code and what to do", async () => {
  reply = { status: 403, body: { ok: false, code: "DATA_INSPECT_DISABLED", error: "reading stored data is switched off for this workspace", hint: "A platform admin switches it on in SysAdmin" } };
  const { res, out } = await run({ method: "collections" });
  assert.equal(res.isError, true);
  assert.equal(out.code, "DATA_INSPECT_DISABLED");
  assert.match(out.hint, /SysAdmin/);

  reply = { status: 403, body: { ok: false, code: "COLLECTION_HIDDEN", error: "collection 'secrets' holds credentials and is never shown" } };
  const r2 = await run({ method: "find", collection: "secrets" });
  assert.equal(r2.out.code, "COLLECTION_HIDDEN");
});

// THE TOOL REGISTRY SAYS WHAT THE TOOLS DO — ONCE PER TOOL.
//
// Read over the real MCP protocol (createServer + the SDK's client over an
// in-memory transport), which is what every caller sees, plus the exported
// registry the server is built from.
//
//   ateam_verify_consistency was declared TWICE: 32d2f24 added it (core:false,
//     the route's real contract: { consistent, drifts }), then 7a75479 added it
//     again as "NEW" (core:true, the listed copy) with a contract the route has
//     never returned — "ok: false + drifts". The handler object carried two
//     keys for it as well. Two answers to one question, and the one agents saw
//     was the wrong one.
//
//   ateam_chain_status declared job_id as an alias for chain_id (852b373) and
//     kept required:["chain_id"] (9518de23), so a schema-following caller could
//     never send the one shape the alias exists for. ateam_get_chain, fixed in
//     the same commit, says required:[].
//
// Run: node --test test/tool-registry.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { setSessionCredentials } from "../src/api.js";
import { createServer } from "../src/server.js";
import { tools, handlers } from "../src/tools.js";

const SID = "sess-tool-registry";
let client;
let listed;
let upstream;
let hits = [];

before(async () => {
  upstream = createHttpServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ chainId: "chain-1", chainStatus: "running", chainDone: false, lastUpdate: new Date().toISOString() }));
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, {
    apiKey: "adas_tenanta_00000000000000000000000000000000",
    apiUrl: `http://127.0.0.1:${upstream.address().port}`,
    explicit: true,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(SID).connect(serverSide);
  client = new Client({ name: "tool-registry-test", version: "1" });
  await client.connect(clientSide);
  listed = (await client.listTools()).tools;
});
after(async () => { await client?.close(); upstream?.close(); });

const find = (name) => listed.find((t) => t.name === name);

test("every tool name is declared once — in the registry and in tools/list", () => {
  const dupes = (names) => names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual(dupes(tools.map((t) => t.name)), [], "the registry declares a tool twice");
  assert.deepEqual(dupes(listed.map((t) => t.name)), [], "tools/list advertises a tool twice");
});

test("every declared tool has a handler, and every handler is declared", () => {
  const declared = new Set(tools.map((t) => t.name));
  assert.deepEqual(tools.map((t) => t.name).filter((n) => typeof handlers[n] !== "function"), []);
  assert.deepEqual(Object.keys(handlers).filter((n) => !declared.has(n)), []);
});

test("ateam_verify_consistency advertises the contract its route returns", () => {
  const t = find("ateam_verify_consistency");
  assert.ok(t, "ateam_verify_consistency is not listed");
  // The route: { ok: true, consistent, drifts: [{path, kind}] } (Builder routes/deploy.js /verify).
  assert.match(t.description, /consistent: false/, "the verdict field is not named");
  assert.doesNotMatch(t.description, /ok: false \+ drifts/,
    "the listed contract says drift is ok:false — the route has never returned that");
  for (const kind of ["fs_missing", "content_differs", "gh_missing", "gh_read_error", "repo_unreachable"]) {
    assert.ok(t.description.includes(kind), `drift kind ${kind} is not documented`);
  }
});

test("ateam_chain_status: the declared alias is a valid call on its own", () => {
  const schema = find("ateam_chain_status")?.inputSchema;
  assert.ok(schema?.properties?.job_id, "job_id is not declared");
  const validate = new AjvJsonSchemaValidator().getValidator(schema);
  assert.equal(validate({ job_id: "job_abc" }).valid, true,
    "a call carrying only job_id does not satisfy the schema the tool advertises");
  assert.equal(validate({ chain_id: "chain_abc" }).valid, true);
});

test("(control) ateam_get_chain has the same alias contract", () => {
  const validate = new AjvJsonSchemaValidator().getValidator(find("ateam_get_chain").inputSchema);
  assert.equal(validate({ job_id: "job_abc" }).valid, true);
});

test("ateam_chain_status called with job_id alone resolves the chain", async () => {
  hits = [];
  const r = await client.callTool({ name: "ateam_chain_status", arguments: { job_id: "job_abc" } });
  assert.notEqual(r.isError, true, r.content?.[0]?.text);
  assert.ok(hits.includes("GET /deploy/jobs/job_abc/status"), `hit: ${hits.join(", ")}`);
  assert.equal(JSON.parse(r.content[0].text).chain_id, "chain-1");
});

test("ateam_chain_status with neither id says both are accepted", async () => {
  const r = await client.callTool({ name: "ateam_chain_status", arguments: {} });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /chain_id required \(job_id accepted as an alias\)/);
});

// Every tool carries MCP safety hints, and a tool that says it only reads DOES
// only read.
//
// ateam-mcp #4: "0/47 tools carry a valid safety-hint annotation". A client
// uses readOnlyHint / destructiveHint to decide whether a call may run without
// asking the user, and a tool with none is, by the spec's defaults, one that
// may destroy data. So a read was presented exactly like a delete.
//
// The hints come from one table in src/tools.js (TOOL_SAFETY). This file checks
// them where a client sees them — tools/list over the real MCP server — and
// then holds the "read" class to its word: each read tool is driven through the
// real dispatcher against a local stand-in for the API, and every request it
// issues must be a read. A hint that says "safe" wrongly is the dangerous
// mistake, so that is the one tested by behaviour.
//
// Run: node --test test/tool-annotations.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { setSessionCredentials } from "../src/api.js";
import { tools, handleToolCall } from "../src/tools.js";
import { createServer } from "../src/server.js";

const SID = "sess-annotations";
const KEY = "adas_tenanta_00000000000000000000000000000000";
const requests = [];
let api;

before(async () => {
  api = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      requests.push({ method: req.method, path: req.url.split("?")[0] });
      res.writeHead(200, { "Content-Type": "application/json" });
      // One body that is plausible for most reads; what the handler makes of
      // it does not matter here, only what it asks for.
      res.end(JSON.stringify({ ok: true, solutions: [], skills: [], plugins: [], content: "{}", files: [], commits: [], status: "done" }));
    });
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, { apiKey: KEY, apiUrl: `http://127.0.0.1:${api.address().port}`, explicit: true });
});
after(() => api.close());

const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];

test("tools/list, over the MCP protocol, carries a safety hint on every tool it lists", async () => {
  const server = createServer("sess-annotations-list");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "annotations-test", version: "1" });
  await client.connect(clientT);
  try {
    const { tools: listed } = await client.listTools();
    assert.ok(listed.length > 0);
    const bare = listed.filter((t) => typeof t.annotations?.readOnlyHint !== "boolean").map((t) => t.name);
    assert.deepEqual(bare, [], `listed with no readOnlyHint: ${bare.join(", ")}`);
    const unclear = listed
      .filter((t) => t.annotations.readOnlyHint === false && typeof t.annotations.destructiveHint !== "boolean")
      .map((t) => t.name);
    // readOnlyHint:false with no destructiveHint means "may destroy" by default —
    // an additive tool would be mislabelled by omission.
    assert.deepEqual(unclear, [], `a writing tool with no destructiveHint: ${unclear.join(", ")}`);
    for (const t of listed) {
      for (const k of Object.keys(t.annotations)) {
        assert.ok(HINTS.includes(k), `${t.name}: "${k}" is not an MCP tool annotation`);
        assert.equal(typeof t.annotations[k], "boolean", `${t.name}.${k} is not a boolean`);
      }
    }
  } finally {
    await client.close();
  }
});

test("the unlisted (advanced) tools are hinted too — they are still callable by name", () => {
  const bare = tools.filter((t) => typeof t.annotations?.readOnlyHint !== "boolean").map((t) => t.name);
  assert.deepEqual(bare, [], `no readOnlyHint: ${bare.join(", ")}`);
});

test("no tool is in two classes — the map would silently keep whichever came last", async () => {
  const { TOOL_SAFETY } = await import("../src/tools.js");
  assert.ok(TOOL_SAFETY && typeof TOOL_SAFETY === "object", "src/tools.js exports no TOOL_SAFETY");
  const seen = new Map();
  const twice = [];
  for (const [cls, names] of Object.entries(TOOL_SAFETY)) {
    for (const n of names) {
      if (seen.has(n)) twice.push(`${n} (${seen.get(n)} and ${cls})`);
      seen.set(n, cls);
    }
  }
  assert.deepEqual(twice, [], `classified twice: ${twice.join(", ")}`);
});

test("the table names only tools that exist — a renamed tool leaves no stale entry behind", async () => {
  const { toolSafetyClass } = await import("../src/tools.js");
  const names = new Set(tools.map((t) => t.name));
  const stale = [...(toolSafetyClass?.keys?.() || [])].filter((n) => !names.has(n));
  assert.ok(toolSafetyClass instanceof Map, "src/tools.js exports no toolSafetyClass");
  assert.deepEqual(stale, [], `classified but not a tool: ${stale.join(", ")}`);
});

test("the ones that delete, and the ones that promote to production, say so", () => {
  const hint = (n) => tools.find((t) => t.name === n)?.annotations || {};
  for (const n of ["ateam_delete_solution", "ateam_delete_skill", "ateam_delete_connector",
    "ateam_github_promote", "ateam_github_rollback", "ateam_build_and_run", "ateam_patch"]) {
    assert.equal(hint(n).readOnlyHint, false, `${n} is not hinted as writing (readOnlyHint:false)`);
    assert.equal(hint(n).destructiveHint, true, `${n} is not marked destructive`);
  }
});

// Reads that need a body. Each is named with the reason it is still a read.
const READ_BY_POST = [
  [/^\/validate\/(skill|solution)$/, "validation of the definition in the body; stores nothing"],
  [/^\/spec\/advisor$/, "an LLM answer over the capability catalog"],
  [/^\/deploy\/solutions\/[^/]+\/connectors\/sysSpecSearch-mcp\/call$/, "the spec search index's own search tool"],
  [/^\/deploy\/solutions\/[^/]+\/plugins\/[^/]+\/verify-surface$/, "renders the surface in a headless browser and reports it"],
];
const isRead = ({ method, path }) =>
  method === "GET" || (method === "POST" && READ_BY_POST.some(([rx]) => rx.test(path)));

// Arguments every read tool is satisfied by; unused ones are ignored.
const ARGS = {
  solution_id: "s", skill_id: "k", connector_id: "c", plugin_id: "mcp:c:p", chain_id: "ch", job_id: "j",
  path: "solution.json", topic: "overview", type: "skill", goal: "g", query: "q", view: "definition",
  skill: { id: "k" }, solution: { id: "s" },
};

test('every tool hinted readOnlyHint:true issues only reads', async () => {
  const readTools = [...new Set(tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name))];
  assert.ok(readTools.length > 10, `only ${readTools.length} read tools`);
  const writes = [];
  const silent = [];
  for (const name of readTools) {
    requests.length = 0;
    await handleToolCall(name, { ...ARGS }, SID);
    if (requests.length === 0) silent.push(name);
    for (const r of requests) if (!isRead(r)) writes.push(`${name}: ${r.method} ${r.path}`);
  }
  assert.deepEqual(writes, [], `a tool that says it only reads wrote:\n  ${writes.join("\n  ")}`);
  // Not vacuous: each one was actually driven to the API. ateam_status_all
  // refuses before any request without a master key, which this session has not.
  assert.deepEqual(silent.filter((n) => n !== "ateam_status_all"), [], "these read tools were never exercised");
});

// The check above must be able to fail: a known write, run through the same
// predicate, is caught.
test("(control) the read check catches a write", async () => {
  requests.length = 0;
  await handleToolCall("ateam_github_promote", { solution_id: "s", dry_run: true }, SID);
  assert.ok(requests.length > 0 && requests.some((r) => !isRead(r)), `promote was not seen writing: ${JSON.stringify(requests)}`);
});

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
// then holds every class that says "safe" to its word, by behaviour: each read
// tool and each additive tool is driven through the real dispatcher against a
// local stand-in for the API, and every request it issues must be one its class
// allows. A hint that says "safe" wrongly is the dangerous mistake, so a tool
// can leave `destructive` only by passing the check of the class it joins —
// and a control proves that check refuses every tool that is destructive today.
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
let origin;
const realFetch = globalThis.fetch;
const coreUrlBefore = process.env.ADAS_CORE_URL;

// One body that is plausible for most calls; what the handler makes of it does
// not matter here, only what it asks for. It is rich enough to walk a handler
// past its reads to the call it exists for: ateam_verify reaches its connector
// smoke call only when a connector is connected and a skill declares a
// read-shaped tool of it; ateam_create_plugin stops polling Core's catalog as
// soon as its plugin is listed there.
const BODY = {
  ok: true, status: "done", solutions: [], content: "{}", files: [], commits: [],
  plugins: [{ id: "mcp:c:p", render: { mode: "iframe", iframeUrl: "/ui/p/index.html" } }],
  connectors: [{ id: "c", status: "connected", tools: 1 }],
  skills: [{ id: "k" }],
  skill: { id: "k", tools: [{ name: "c.list_items", source: { connector: "c" } }] },
};

before(async () => {
  api = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      requests.push({ method: req.method, path: req.url.split("?")[0] });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(BODY));
    });
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${api.address().port}`;
  setSessionCredentials(SID, { apiKey: KEY, apiUrl: origin, explicit: true });
  // Tools that speak to Core directly (test_notification, test_skill) read
  // this per call; point it at the stand-in so nothing leaves the machine.
  process.env.ADAS_CORE_URL = origin;
  // Anything else addressed off this machine is recorded and refused: it is
  // neither a read nor an addition this file can vouch for.
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url instanceof Request ? url.url : url);
    if (!u.startsWith(origin)) {
      requests.push({ method: (opts.method || "GET").toUpperCase(), path: u, outside: true });
      throw new Error(`blocked by test: ${u}`);
    }
    return realFetch(url, opts);
  };
});
after(() => {
  globalThis.fetch = realFetch;
  if (coreUrlBefore === undefined) delete process.env.ADAS_CORE_URL;
  else process.env.ADAS_CORE_URL = coreUrlBefore;
  api.close();
});

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

const hint = (n) => tools.find((t) => t.name === n)?.annotations || {};
const assertDestructive = (n) => {
  assert.equal(hint(n).readOnlyHint, false, `${n} is not hinted as writing (readOnlyHint:false)`);
  assert.equal(hint(n).destructiveHint, true, `${n} is not marked destructive`);
};

test("the ones that delete, and the ones that promote to production, say so", () => {
  for (const n of ["ateam_delete_solution", "ateam_delete_skill", "ateam_delete_connector",
    "ateam_github_promote", "ateam_github_rollback", "ateam_build_and_run", "ateam_patch"]) assertDestructive(n);
});

// A connector tool can delete, send or pay. Whether it is reached by name, by a
// skill's planner, or by a plugin's own JS while it renders, this server sees
// none of what it does — so neither can the hint.
test("the ones that run code this server cannot see say so", () => {
  for (const n of [
    "ateam_test_connector",                                     // a connector tool, by name
    "ateam_verify",                                             // one per connector, picked by a "read-shaped" name
    "ateam_test_skill", "ateam_conversation", "ateam_test_voice", // a deployed skill; its planner picks the tools
    "ateam_solution_chat",                                      // the Solution Bot, which edits the solution
    "ateam_verify_surface",                                     // the plugin's JS, in the real host, live tool calls
  ]) assertDestructive(n);
});

// Reads that need a body. Each is named with the reason it is still a read.
const READ_BY_POST = [
  [/^\/validate\/(skill|solution)$/, "validation of the definition in the body; stores nothing"],
  [/^\/spec\/advisor$/, "an LLM answer over the capability catalog"],
  [/^\/spec\/search$/, "a semantic search over the public spec docs"],
];
const isRead = ({ method, path, outside }) =>
  !outside && (method === "GET" || (method === "POST" && READ_BY_POST.some(([rx]) => rx.test(path))));

// What an additive tool may do beyond reading: add something new, beside what
// exists. Each is named with what it adds. A route that runs a skill, calls a
// connector tool, or writes a definition, a file or a branch is not here, so a
// tool that issues one cannot pass as additive.
const ADD_BY_POST = [
  [/^\/deploy\/solutions\/[^/]+\/progress$/, "appends a progress entry"],
  [/^\/deploy\/solutions\/[^/]+\/lessons$/, "appends a lesson"],
  [/^\/deploy\/solutions\/[^/]+\/skills\/[^/]+\/test-pipeline$/, "plans one step; executes none of the skill's tools"],
  [/^\/api\/internal\/notify-user$/, "a new [TEST] notification to an existing actor"],
];
const isAdditive = (r) =>
  isRead(r) || (!r.outside && r.method === "POST" && ADD_BY_POST.some(([rx]) => rx.test(r.path)));

// Arguments every read tool is satisfied by; unused ones are ignored.
const ARGS = {
  solution_id: "s", skill_id: "k", connector_id: "c", plugin_id: "mcp:c:p", chain_id: "ch", job_id: "j",
  path: "solution.json", topic: "overview", type: "skill", goal: "g", query: "q", view: "definition",
  skill: { id: "k" }, solution: { id: "s" }, skills: [{ id: "k" }],
  // for the additive and destructive tools: enough to reach the call each
  // exists for, and no longer than one round trip.
  message: "m", messages: ["m"], actor_id: "a", content: "c", step: "st", status: "built",
  tool: "c.list_items", error: "e", api_key: KEY, wait: false, wait_for: "never",
  plugin_name: "p", files: [{ path: "server.js", content: "x" }], confirm: true, confirm_solution_id: "s",
};

// Drives one tool through the real dispatcher; returns what it asked for. The
// session is set afresh each time, so a tool that changes it (ateam_auth)
// cannot send the next one somewhere else.
async function drive(name) {
  setSessionCredentials(SID, { apiKey: KEY, apiUrl: origin, explicit: true });
  requests.length = 0;
  await handleToolCall(name, { ...ARGS }, SID);
  return [...requests];
}

test('every tool hinted readOnlyHint:true issues only reads', async () => {
  const readTools = [...new Set(tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name))];
  assert.ok(readTools.length > 10, `only ${readTools.length} read tools`);
  const writes = [];
  const silent = [];
  for (const name of readTools) {
    const seen = await drive(name);
    if (seen.length === 0) silent.push(name);
    for (const r of seen) if (!isRead(r)) writes.push(`${name}: ${r.method} ${r.path}`);
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

// ─── THE ADDITIVE CLASS, BY BEHAVIOUR ────────────────────────────────────────
//
// destructiveHint:false tells a client the tool "performs only additive
// updates". Three tools that run a deployed skill end to end were in this class
// while ateam_test_connector, which runs ONE connector tool, was destructive:
// the table broke its own rule in the direction it calls dangerous, and nothing
// here could see it, because only the read class was held to behaviour.
const additiveTools = () => [...new Set(tools
  .filter((t) => t.annotations?.readOnlyHint === false && t.annotations?.destructiveHint === false)
  .map((t) => t.name))];

test("every tool hinted additive only reads and adds — never runs a skill or a connector, never overwrites", async () => {
  const names = additiveTools();
  assert.ok(names.length > 0, "no additive tools — this check would be vacuous");
  const beyond = [];
  const silent = [];
  for (const name of names) {
    const seen = await drive(name);
    if (seen.length === 0) silent.push(name);
    for (const r of seen) if (!isAdditive(r)) beyond.push(`${name}: ${r.method} ${r.path}`);
  }
  assert.deepEqual(beyond, [], `a tool hinted additive did more than add:\n  ${beyond.join("\n  ")}`);
  assert.deepEqual(silent, [], `these additive tools were never exercised, so nothing above vouches for them: ${silent.join(", ")}`);
});

// The check above must refuse every tool that is destructive today, so moving
// ANY of them into `additive` (or `read`, whose check is stricter) fails it.
// Each one, driven exactly as above, either asks for something the additive
// class does not allow, or asks for nothing at all and so fails "exercised".
test("(control) every destructive tool fails the additive check — none can leave the class unnoticed", async () => {
  const destructive = [...new Set(tools.filter((t) => t.annotations?.destructiveHint === true).map((t) => t.name))];
  assert.ok(destructive.length > 20, `only ${destructive.length} destructive tools`);
  const wouldPass = [];
  for (const name of destructive) {
    const seen = await drive(name);
    if (seen.length > 0 && seen.every(isAdditive)) wouldPass.push(`${name}: ${seen.map((r) => `${r.method} ${r.path}`).join(", ")}`);
  }
  assert.deepEqual(wouldPass, [],
    `these destructive tools would pass as additive — the check does not reach what makes them destructive:\n  ${wouldPass.join("\n  ")}`);
});

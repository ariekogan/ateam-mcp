// A tool that reaches the connector upload route says how long it takes.
//
// Core sizes the timeout of every in-app tool call in ai-dev-assistant
// apps/backend/utils/connectorManager.js timeoutForTool: 30s by default; a
// tool's own monitoring.latency_ms_p95, read from tools/list, ×4 and capped at
// 300s, and only ever raising the default. The upload
// (/deploy/solutions/<id>/connectors/<id>/upload) runs npm install + build + a
// connector restart, so a tool that reaches it and declares nothing is cut off
// at 30s. Run 4 (2026-10-03): the in-app builder's ateam_create_plugin, through
// ateam-proxy-mcp, failed "HTTP connector timeout after 30000ms".
// ateam_upload_connector escaped only because Core keeps a hand-written list
// that names it; ateam_create_plugin and ateam_create_connector were never on
// it. The declaration is this repo's half, so the next tool that reaches the
// upload must make it too: the guard below finds every such tool by what it
// sends, not by a list.
//
// Run: node --test test/upload-tools-declare-latency.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { setSessionCredentials } from "../src/api.js";
import { tools, handlers, handleToolCall } from "../src/tools.js";
import { createServer } from "../src/server.js";

// Core's rule, as connectorManager.js states it (REQUEST_TIMEOUT_MS,
// ATEAM_SLOW_TOOL_TIMEOUT_MS, LATENCY_HEADROOM_MULTIPLIER). For a tool not on
// Core's list, the ceiling is the default raised by the declaration.
const CORE_DEFAULT_MS = 30_000;
const CORE_CAP_MS = 300_000;
const HEADROOM = 4;
const coreCeiling = (p95) =>
  Math.max(CORE_DEFAULT_MS, typeof p95 === "number" && p95 > 0 ? Math.min(p95 * HEADROOM, CORE_CAP_MS) : 0);
// The smallest declaration that buys the cap — the most Core grants any tool.
const P95_FOR_CAP = CORE_CAP_MS / HEADROOM;

const UPLOAD_ROUTE = /^\/deploy\/solutions\/[^/]+\/connectors\/[^/]+\/upload$/;
const UPLOAD_IN_SOURCE = /\/connectors\/\$\{[^}]+\}\/upload/;

// What the handler itself is prepared to wait for: every timeoutMs and maxMs
// it states (the async kick, the job poll, the sync fallback), added up.
const ms = (expr) => expr.split("*").reduce((acc, f) => acc * Number(f.trim().replace(/_/g, "")), 1);
const statedWaits = (name) =>
  [...handlers[name].toString().matchAll(/\b(?:timeoutMs|maxMs):\s*([\d_]+(?:\s*\*\s*[\d_]+)*)/g)].map((m) => ms(m[1]));

// tools/list as Core reads it: the raw JSON-RPC result (connectorManager.js
// keeps it as toolSchemas). Not through the SDK's Client, whose schema drops
// keys it does not know — monitoring among them.
async function listedOverMcp() {
  const server = createServer("sess-upload-latency-list");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const replies = new Map();
  clientT.onmessage = (m) => { if (m.id !== undefined) replies.set(m.id, m); };
  await clientT.start();
  const ask = async (id, method, params = {}) => {
    await clientT.send({ jsonrpc: "2.0", id, method, params });
    for (let i = 0; i < 100 && !replies.has(id); i++) await new Promise((r) => setTimeout(r, 10));
    return replies.get(id);
  };
  try {
    await ask(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "upload-latency-test", version: "1" } });
    await clientT.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return (await ask(2, "tools/list"))?.result?.tools || [];
  } finally {
    await clientT.close();
  }
}

for (const name of ["ateam_create_plugin", "ateam_create_connector"]) {
  test(`${name}: tools/list — what Core reads — declares a p95 whose ceiling covers the upload it waits for`, async () => {
    const listed = (await listedOverMcp()).find((t) => t.name === name);
    assert.ok(listed, `${name} is not in tools/list`);
    const p95 = listed.monitoring?.latency_ms_p95;
    assert.ok(typeof p95 === "number" && p95 > 0,
      `${name} declares no monitoring.latency_ms_p95 in tools/list, so Core cuts it at ${CORE_DEFAULT_MS / 1000}s`);

    const waits = statedWaits(name);
    assert.ok(waits.length > 0, `${name} states no timeoutMs/maxMs of its own, so this test cannot say what its upload needs`);
    // A poll allowed 15 minutes needs more than Core grants anything; then the
    // declaration must reach the cap.
    const needs = Math.min(waits.reduce((a, b) => a + b, 0), CORE_CAP_MS);
    assert.ok(coreCeiling(p95) >= needs,
      `${name}: latency_ms_p95 ${p95} gives Core a ${coreCeiling(p95) / 1000}s ceiling; its upload waits up to ` +
      `${waits.map((w) => `${w / 1000}s`).join(" + ")}, so it needs ${needs / 1000}s`);
  });
}

// ─── THE GUARD: found by what a tool sends, not by name ─────────────────────

const SID = "sess-upload-latency";
const KEY = "adas_tenanta_00000000000000000000000000000000";
const requests = [];
let api;
let origin;
const realFetch = globalThis.fetch;
const coreUrlBefore = process.env.ADAS_CORE_URL;

// A body plausible for most calls (the shape tool-annotations.test.mjs uses):
// ateam_create_plugin stops polling Core's catalog once mcp:c:p is listed.
const BODY = {
  ok: true, status: "done", solutions: [], content: "{}", files: [], commits: [],
  plugins: [{ id: "mcp:c:p", render: { mode: "iframe", iframeUrl: "/ui/p/index.html" } }],
  connectors: [{ id: "c", status: "connected", tools: 1 }],
  skills: [{ id: "k" }],
  skill: { id: "k", tools: [{ name: "c.list_items", source: { connector: "c" } }] },
};

// Enough for each tool to reach the call it exists for. mcp_store carries a
// connector's files, which is what takes ateam_build_and_run to the upload.
const ARGS = {
  solution_id: "s", skill_id: "k", connector_id: "c", plugin_id: "mcp:c:p", chain_id: "ch", job_id: "j",
  path: "solution.json", topic: "overview", type: "skill", goal: "g", query: "q", view: "definition",
  skill: { id: "k" }, solution: { id: "s" }, skills: [{ id: "k" }],
  message: "m", messages: ["m"], actor_id: "a", content: "c", step: "st", status: "built",
  tool: "c.list_items", error: "e", api_key: KEY, wait: false, wait_for: "never",
  plugin_name: "p", files: [{ path: "server.js", content: "x" }], confirm: true, confirm_solution_id: "s",
  mcp_store: { c: [{ path: "server.js", content: "x" }] },
};

before(async () => {
  api = createHttpServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests.push({ method: req.method, path: req.url.split("?")[0] });
      // A connector with no authored source and nothing deployed: what
      // ateam_create_connector must hear before it uploads (create never
      // replaces an existing one), so the drive reaches the upload it exists for.
      if (req.method === "GET" && /\/connectors\/[^/]+\/source$/.test(req.url.split("?")[0])) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, code: "AUTHORED_SOURCE_MISSING", deployed_in_core: false }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(BODY));
    });
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${api.address().port}`;
  process.env.ADAS_CORE_URL = origin;
  // Nothing leaves this machine.
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url instanceof Request ? url.url : url);
    if (!u.startsWith(origin)) throw new Error(`blocked by test: ${u}`);
    return realFetch(url, opts);
  };
});
after(() => {
  globalThis.fetch = realFetch;
  if (coreUrlBefore === undefined) delete process.env.ADAS_CORE_URL;
  else process.env.ADAS_CORE_URL = coreUrlBefore;
  api.close();
});

async function toolsThatUpload() {
  const found = new Set();
  for (const name of new Set(tools.map((t) => t.name))) {
    setSessionCredentials(SID, { apiKey: KEY, apiUrl: origin, explicit: true });
    requests.length = 0;
    try { await handleToolCall(name, { ...ARGS }, SID); } catch { /* a refusal is fine; what was sent is the answer */ }
    if (requests.some((r) => r.method === "POST" && UPLOAD_ROUTE.test(r.path))) found.add(name);
  }
  return found;
}

test("every tool that reaches the connector upload route declares a p95 that buys Core's 300s cap, and is not poll-safe", async () => {
  const uploading = await toolsThatUpload();

  // Not vacuous: the drive reaches the tools known to upload, and every handler
  // whose own code names the route — a tool the drive missed would otherwise
  // pass by never being looked at.
  for (const n of ["ateam_upload_connector", "ateam_create_plugin", "ateam_create_connector"]) {
    assert.ok(uploading.has(n), `${n} was not seen posting to the upload route — the drive no longer reaches it`);
  }
  const namedInCode = Object.keys(handlers).filter((n) => UPLOAD_IN_SOURCE.test(handlers[n].toString()));
  const unseen = namedInCode.filter((n) => !uploading.has(n));
  assert.deepEqual(unseen, [], `these handlers name the upload route but were never seen sending it: ${unseen.join(", ")}`);

  const short = [];
  for (const name of uploading) {
    const m = tools.find((t) => t.name === name)?.monitoring;
    const p95 = m?.latency_ms_p95;
    if (!(typeof p95 === "number" && p95 >= P95_FOR_CAP) || m.safe !== false) {
      short.push(`${name}: monitoring ${JSON.stringify(m ?? null)} → ${coreCeiling(p95) / 1000}s from its declaration`);
    }
  }
  assert.deepEqual(short, [],
    `a tool that reaches the upload route needs monitoring.latency_ms_p95 >= ${P95_FOR_CAP} (×${HEADROOM} = Core's ` +
    `${CORE_CAP_MS / 1000}s cap) and safe:false (it redeploys a connector):\n  ${short.join("\n  ")}`);
});

// The model of Core above, checked against the case that failed: no
// declaration is 30s, and a declaration under P95_FOR_CAP stops short of the cap.
test("(control) Core's rule as modelled here: undeclared is 30s, ×4 caps at 300s, never lowers", () => {
  assert.equal(coreCeiling(undefined), CORE_DEFAULT_MS);
  assert.equal(coreCeiling(5_000), CORE_DEFAULT_MS);
  assert.equal(coreCeiling(P95_FOR_CAP - 1) < CORE_CAP_MS, true);
  assert.equal(coreCeiling(P95_FOR_CAP), CORE_CAP_MS);
  assert.equal(coreCeiling(10 * P95_FOR_CAP), CORE_CAP_MS);
});

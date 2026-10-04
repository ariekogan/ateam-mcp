// ateam_create_connector SCAFFOLDS THE RECOMMENDED RUNTIME, AND POINTS AT THE
// ONE STORAGE DECISION (BUILDER-7; Builder #107 review, B107-1).
//
// The scaffold wrote a raw JSON-RPC server.js (21eb3bb, 2026-07-18) that
// declared `_adas_actor` in every tool's inputSchema and hand-read it through
// getActorId — the identity form the Builder's storage decision forbids
// ("NOT hand-read _adas_actor arguments … declaring one is refused") — with
// `dependencies: {}`, and nothing about where data goes. An outside agent
// starts every connector here, so every connector started there.
//
// So this RUNS what the scaffold generates, on the published runtime
// (@ateam-ai/sdk, a devDependency): the generated server.js is loaded with its
// own imports, against defineConnector and the real MCP SDK server — only the
// stdio transport is a stub, so the test does not hand its own stdin to it.
// A generated file that declared an _adas_* field would be refused at
// definition, and this file would fail loading it.
//
// Run: node --test test/scaffold-connector.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { setSessionCredentials } from "../src/api.js";
import { tools, handleToolCall } from "../src/tools.js";
import { createOnlyAnswer } from "./create-only-stand-in.mjs";

const SID = "sess-scaffold-connector";
const uploads = [];
const tmpDirs = [];
let server;
before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const upload = req.url.split("?")[0].endsWith("/upload");
      const sent = upload ? JSON.parse(body || "{}") : null;
      if (upload) uploads.push(sent);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, tools: 1, ...(upload && createOnlyAnswer(sent)) }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, { apiKey: "adas_tenanta_" + "0".repeat(32), apiUrl: `http://127.0.0.1:${server.address().port}`, explicit: true });
});
after(() => {
  server.close();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** What ateam_create_connector uploads, as files by path. */
async function scaffold(args) {
  uploads.length = 0;
  const r = await handleToolCall("ateam_create_connector", { solution_id: "walkmate", ...args }, SID);
  assert.ok(!r.isError, r.content?.[0]?.text?.slice(0, 300));
  const files = Object.fromEntries(uploads.flatMap((u) => u.files || []).map((f) => [f.path, f.content]));
  return { out: JSON.parse(r.content[0].text), files };
}

/**
 * Load a generated server.js as Core would run it — its own imports, on the
 * published @ateam-ai/sdk and the real MCP SDK server — with only the stdio
 * transport stubbed. Returns the connector it defined.
 */
async function load(serverJs, { manifests = {} } = {}) {
  // Checked BEFORE importing: a raw stdio server would attach to this test's
  // stdin and keep it running instead of failing.
  assert.match(serverJs, /^import \{ defineConnector \} from "@ateam-ai\/sdk\/serve";$/m,
    "the generated server.js is not a defineConnector module — not loading it");
  const dir = mkdtempSync(join(tmpdir(), "scaffold-"));
  tmpDirs.push(dir);   // kept until the end: the generated code reads ui-dist at CALL time
  const url = (spec) => JSON.stringify(import.meta.resolve(spec));
  const serve = readFileSync(fileURLToPath(import.meta.resolve("@ateam-ai/sdk/serve")), "utf8")
    .replace('from "@modelcontextprotocol/sdk/server/mcp.js"', `from ${url("@modelcontextprotocol/sdk/server/mcp.js")}`)
    .replace('from "@modelcontextprotocol/sdk/server/streamableHttp.js"', `from ${url("@modelcontextprotocol/sdk/server/streamableHttp.js")}`)
    .replace('from "@modelcontextprotocol/sdk/server/stdio.js"', 'from "./stdio-stub.mjs"');
  assert.doesNotMatch(serve, /from "@modelcontextprotocol\//, "serve.js imports an MCP SDK module this harness does not bind");
  writeFileSync(join(dir, "stdio-stub.mjs"), "export class StdioServerTransport { async start() {} async send() {} async close() {} }\n");
  writeFileSync(join(dir, "serve.mjs"), serve);
  writeFileSync(join(dir, "capture.mjs"),
    'import { defineConnector as real } from "./serve.mjs";\nexport const defined = [];\n' +
    "export function defineConnector(spec) { const c = real(spec); defined.push(c); return c; }\n");
  const generated = serverJs
    .replace('from "@ateam-ai/sdk/serve"', 'from "./capture.mjs"')
    .replace('from "zod"', `from ${url("zod")}`);
  assert.doesNotMatch(generated, /from "(?!node:|\.\/|file:)[^"]+"/, "the generated server.js imports a package this harness does not provide");
  writeFileSync(join(dir, "server.mjs"), generated);
  for (const [plugin, manifest] of Object.entries(manifests)) {
    mkdirSync(join(dir, "ui-dist", plugin), { recursive: true });
    writeFileSync(join(dir, "ui-dist", plugin, "manifest.json"), JSON.stringify(manifest));
  }
  const { defined } = await import(pathToFileURL(join(dir, "capture.mjs")).href);
  await import(pathToFileURL(join(dir, "server.mjs")).href);
  assert.equal(defined.length, 1, "the generated server.js should define exactly one connector");
  return defined[0];
}
/**
 * tools/call over MCP, as Core makes it: arguments validated against the
 * tool's schema by the real MCP SDK server, the caller on params._meta. (Not
 * connector.handlers: that direct-call door reads _adas_* arguments when the
 * envelope is empty, which a call over MCP never reaches.)
 */
async function answer(connector, tool, args, meta) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await connector.buildServer().connect(serverSide);
  const client = new Client({ name: "scaffold-test", version: "0.0.0" });
  await client.connect(clientSide);
  try {
    const res = await client.callTool({ name: tool, arguments: args, ...(meta ? { _meta: meta } : {}) });
    return JSON.parse(res.content[0].text);
  } finally {
    await client.close();
  }
}

test("the generated server.js is a defineConnector skeleton that points at the storage decision", async () => {
  for (const ui_capable of [false, true]) {
    const { files } = await scaffold({ connector_id: "walk-mcp", ui_capable });
    const src = files["server.js"];
    assert.ok(src, "no server.js was uploaded");
    assert.match(src, /^import \{ defineConnector \} from "@ateam-ai\/sdk\/serve";$/m);
    assert.match(src, /await connector\.start\(\);/);
    assert.doesNotMatch(src, /_adas_actor/, "the scaffold names _adas_actor — the caller is ctx");
    assert.doesNotMatch(src, /DATA_DIR\s*(?:\|\||\?\?)/);
    assert.match(src, /storage_decision/);
    assert.match(src, /READ-ONLY/);
    assert.doesNotMatch(src, /getActorId|_system_service|tools\/call|process\.stdin/, "the raw JSON-RPC form is back");
    // node --check: it parses as the ESM module it is.
    const dir = mkdtempSync(join(tmpdir(), "scaffold-check-"));
    try {
      writeFileSync(join(dir, "server.mjs"), src);
      const r = spawnSync(process.execPath, ["--check", join(dir, "server.mjs")], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("package.json declares the runtime and zod — it was `dependencies: {}`", async () => {
  const { files } = await scaffold({ connector_id: "walk-mcp" });
  const pkg = JSON.parse(files["package.json"]);
  assert.equal(pkg.type, "module");
  assert.match(pkg.dependencies?.["@ateam-ai/sdk"] || "", /^\^1\.(?:[4-9]|\d{2,})\./, "@ateam-ai/sdk missing or below what ./serve needs");
  assert.ok(pkg.dependencies?.zod, "zod is imported by server.js but not declared");
});

test("it RUNS: the echo tool answers with the caller from the envelope, and refuses a call with none", async () => {
  const { files } = await scaffold({ connector_id: "walk-mcp" });
  const connector = await load(files["server.js"]);
  assert.deepEqual(await answer(connector, "walk-mcp.echo", { message: "hi" }, { _adas_actor: "alice", _adas_skill: "walk-mcp" }),
    { ok: true, echo: "hi", actor: "alice" });
  // Identity sent as an ARGUMENT is not the caller.
  const noCaller = await answer(connector, "walk-mcp.echo", { message: "hi", _adas_actor: "mallory" }, {});
  assert.equal(noCaller.code, "MISSING_CALLER", JSON.stringify(noCaller));
});

test("ui_capable: ui.listPlugins and ui.getPlugin are TOOLS, actor:\"optional\", reading ui-dist at call time", async () => {
  const { files } = await scaffold({ connector_id: "walk-mcp", ui_capable: true });
  const src = files["server.js"];
  for (const tool of ["ui.listPlugins", "ui.getPlugin"]) {
    const at = src.indexOf(`"${tool}": {`);
    assert.ok(at > -1, `${tool} is not a defineConnector tool`);
    assert.match(src.slice(at, src.indexOf("},\n", src.indexOf("async handler", at))), /actor: "optional"/, `${tool} is not actor:"optional"`);
  }
  const manifest = { name: "Walk", version: "1.0.0", render: { mode: "adaptive", iframeUrl: "/ui/walk/index.html" } };
  const connector = await load(src, { manifests: { walk: manifest } });
  // Core's discovery call has no user behind it.
  assert.deepEqual(await answer(connector, "ui.listPlugins", {}, {}),
    { plugins: [{ id: "walk", name: "Walk", version: "1.0.0", description: "" }] });
  assert.deepEqual(await answer(connector, "ui.getPlugin", { id: "walk" }, {}), { ...manifest, id: "walk" });
  assert.match((await answer(connector, "ui.getPlugin", { id: "nope" }, {})).error, /Plugin nope not found/);
});

test("the tool description and the README say the same", async () => {
  const desc = tools.find((t) => t.name === "ateam_create_connector").description;
  assert.match(desc, /defineConnector skeleton \(@ateam-ai\/sdk\/serve\): you write handlers; caller identity arrives as ctx/);
  assert.match(desc, /storage_decision/);
  assert.doesNotMatch(desc, /stdio transport\)/, "the description still sells the raw stdio boilerplate");
  const { out, files } = await scaffold({ connector_id: "walk-mcp" });
  const readme = files["README.md"];
  assert.match(readme, /defineConnector/);
  assert.match(readme, /storage_decision/);
  assert.doesNotMatch(readme, /getActorId|toolSchemas/, "the README describes the deleted raw form");
  assert.ok(out.next_steps.some((s) => s.includes("storage_decision")), "next_steps do not say where data goes");
});

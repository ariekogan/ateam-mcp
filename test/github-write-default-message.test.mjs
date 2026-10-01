// ateam_github_write / ateam_github_patch must document the commit message a
// write without `message` actually gets.
//
// Both tools post to the Builder's /deploy/solutions/:id/github/patch, and the
// message there defaults to "Update <path>" (githubService patchFile, since the
// route was written in db2a316, 2026-03-10) — "Edit <path> (N replacements)" in
// search/replace mode. ateam_github_write was born (261597f, 2026-03-21) saying
// "default: 'Write <path>'", a message no commit has ever had. An agent that
// greps the log for its own "Write server.js" finds nothing, and anyone tracing
// a commit back to the call that made it (BUILDER-6: the root server.js /
// ui-dist/ commits on ateam-mcp-test, all "Update <path>") is pointed at the
// wrong text.
//
// Checked where a client sees it — tools/list over the real MCP server — and
// against what the handler sends, with a local stand-in that answers the way
// the Builder does: no `message` in the body, so the Builder's default applies.
//
// Run: node --test test/github-write-default-message.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { setSessionCredentials } from "../src/api.js";
import { handleToolCall } from "../src/tools.js";
import { createServer } from "../src/server.js";

const SID = "sess-github-write-default-message";
const KEY = "adas_tenanta_00000000000000000000000000000000";
const bodies = [];
const SOURCE = {
  ok: true, connector_id: "invoice-mcp", provenance: "authored_fs", authored_source_of_record: true,
  files: [{ path: "server.js", content: "// v3" }],
  nested_copies: [{ path: "connectors/invoice-mcp/server.js", copy_of: "server.js", identical: false }],
  nested_copies_note: "connectors/invoice-mcp/server.js is a copy nested under this connector's own repo prefix, left out of files",
};
let api;
let listed;

before(async () => {
  // A stand-in answering as the Builder does. github/patch replies with the
  // commit (no message field: the message is the Builder's, in the commit);
  // the connector-source route leaves a nested copy out of files and names it.
  api = createHttpServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url.includes("/connectors/invoice-mcp/source")) {
        res.end(JSON.stringify(SOURCE));
        return;
      }
      const body = JSON.parse(raw || "{}");
      bodies.push(body);
      res.end(JSON.stringify({ ok: true, mode: body.delete ? "delete" : "full_content", branch: "dev", path: body.path, commit_sha: "abc1234" }));
    });
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, { apiKey: KEY, apiUrl: `http://127.0.0.1:${api.address().port}`, explicit: true });

  const server = createServer("sess-github-write-default-message-list");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "github-write-default-message", version: "1" });
  await client.connect(clientT);
  listed = (await client.listTools()).tools;
  await client.close();
});
after(() => api.close());

const messageDescription = (name) => {
  const t = listed.find((x) => x.name === name);
  assert.ok(t, `${name} is not listed`);
  return t.inputSchema.properties.message.description;
};

test("ateam_github_write: the default it names is the one a commit gets — 'Update <path>'", () => {
  const d = messageDescription("ateam_github_write");
  assert.doesNotMatch(d, /Write <path>/, "the description still promises a 'Write <path>' message no commit has");
  assert.match(d, /default: 'Update <path>'/);
});

test("ateam_github_patch: both modes' defaults are named", () => {
  const d = messageDescription("ateam_github_patch");
  assert.match(d, /default: 'Update <path>'/);
  assert.match(d, /search\/replace mode: 'Edit <path> \(N replacements\)'/);
});

test("ateam_github_write: a write without message sends none, so the Builder's default is the message", async () => {
  bodies.length = 0;
  const r = await handleToolCall("ateam_github_write", { solution_id: "s", path: "connectors/c/server.js", content: "x" }, SID);
  assert.ok(!r.isError, r.content?.[0]?.text);
  assert.equal(bodies.length, 1);
  assert.equal("message" in bodies[0], false, "the handler chose a message itself — the Builder's 'Update <path>' would not apply");
});

test("ateam_github_patch delete:true reaches the Builder — declared, so MCP does not strip it, and forwarded", async () => {
  const t = listed.find((x) => x.name === "ateam_github_patch");
  assert.equal(t.inputSchema.properties.delete?.type, "boolean", "delete is not declared: an undeclared argument is dropped");
  assert.match(t.description, /DELETE A STRAY/);
  // CORE on #111: a stray delete writes the working branch only; main moves by promote.
  for (const text of [t.description, t.inputSchema.properties.delete.description]) {
    assert.doesNotMatch(text, /production and dev/, "the text still says a delete lands on production");
    assert.match(text, /working branch \(`dev`\) only/);
  }
  bodies.length = 0;
  const r = await handleToolCall("ateam_github_patch", { solution_id: "s", path: "server.js", delete: true }, SID);
  assert.ok(!r.isError, r.content?.[0]?.text);
  assert.equal(bodies[0].delete, true, "the handler did not forward delete");
  assert.equal(bodies[0].path, "server.js");
});

test("ateam_get_connector_source passes nested_copies through — manifest and single-file answers (CORE B111-4)", async () => {
  const manifest = JSON.parse((await handleToolCall("ateam_get_connector_source", { solution_id: "s", connector_id: "invoice-mcp" }, SID)).content[0].text);
  assert.deepEqual(manifest.nested_copies, SOURCE.nested_copies, "the manifest dropped nested_copies");
  assert.equal(manifest.nested_copies_note, SOURCE.nested_copies_note);
  const missing = JSON.parse((await handleToolCall("ateam_get_connector_source",
    { solution_id: "s", connector_id: "invoice-mcp", path: "connectors/invoice-mcp/server.js" }, SID)).content[0].text);
  assert.deepEqual(missing.nested_copies, SOURCE.nested_copies, "asking for the nested path did not say why it is absent");
});

test("ateam_github_write: says where connector files go — a root server.js is refused", () => {
  const t = listed.find((x) => x.name === "ateam_github_write");
  assert.match(t.description, /under connectors\/<connector-id>\//);
  assert.match(t.description, /CONNECTOR_FILE_OUTSIDE_CONNECTOR/);
});

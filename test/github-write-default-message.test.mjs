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
let api;
let listed;

before(async () => {
  // The Builder's rule (deploy.js github/patch → githubService patchFile /
  // searchReplacePatchFile): the caller's message, else the writer's default.
  api = createHttpServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      bodies.push(body);
      const message = body.message ?? (body.search !== undefined ? `Edit ${body.path} (1 replacement)` : `Update ${body.path}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, branch: "dev", path: body.path, commit_sha: "abc1234", message }));
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
  assert.equal("message" in bodies[0], false, "the handler chose a message itself");
  assert.equal(JSON.parse(r.content[0].text).message, "Update connectors/c/server.js");
});

test("ateam_github_write: says where connector files go — a root server.js is refused", () => {
  const t = listed.find((x) => x.name === "ateam_github_write");
  assert.match(t.description, /under connectors\/<connector-id>\//);
  assert.match(t.description, /CONNECTOR_FILE_OUTSIDE_CONNECTOR/);
});

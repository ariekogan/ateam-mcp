// ateam_github_read / ateam_github_log must document the branch a read without
// `ref` actually gets.
//
// c8dd459 (2026-05-19) documented "Default reads from `main`" and declared
// `default: "main"` in both schemas — true of the Builder then. The Builder
// moved the default to where the writes go: /github/read in 1489d4d (#35,
// 2026-09-24) and /github/log with #44 (f0e6da6), both through resolveBranch
// kind 'iterative' → `dev`, created if the repo has none. The handlers here
// send no branch when none is given, so the Builder's answer is the answer;
// only the text and the schema kept saying `main`.
//
// The schema default was the worse half. A default is something an MCP client
// may fill in by itself: such a client would have sent ref:"main" and read
// production while every iteration it had made sat on dev.
//
// Checked where a client sees it — tools/list over the real MCP server — and
// against what the handler actually sends, with a local stand-in that answers
// the way the Builder does.
//
// Run: node --test test/github-read-default.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { setSessionCredentials } from "../src/api.js";
import { handleToolCall } from "../src/tools.js";
import { createServer } from "../src/server.js";

const SID = "sess-github-read-default";
const KEY = "adas_tenanta_00000000000000000000000000000000";
const asked = [];
let api;
let listed;

before(async () => {
  // The Builder's rule (deploy.js /github/read and /github/log on dev):
  // an explicit branch is honoured; none resolves to the working branch.
  api = createHttpServer((req, res) => {
    const u = new URL(req.url, "http://x");
    asked.push({ path: u.pathname, branch: u.searchParams.get("branch") });
    const branch = u.searchParams.get("branch") || u.searchParams.get("ref") || "dev";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, branch, content: "{}", commits: [] }));
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, { apiKey: KEY, apiUrl: `http://127.0.0.1:${api.address().port}`, explicit: true });

  const server = createServer("sess-github-read-default-list");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "github-read-default", version: "1" });
  await client.connect(clientT);
  listed = (await client.listTools()).tools;
  await client.close();
});
after(() => api.close());

const CASES = [
  ["ateam_github_read", { path: "solution.json" }],
  ["ateam_github_log", {}],
];

for (const [name, args] of CASES) {
  test(`${name}: a read with no ref asks for no branch, and gets dev`, async () => {
    asked.length = 0;
    const r = await handleToolCall(name, { solution_id: "s", ...args }, SID);
    assert.ok(!r.isError, r.content?.[0]?.text);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].branch, null, "the handler chose a branch itself instead of leaving it to the Builder");
    assert.equal(JSON.parse(r.content[0].text).branch, "dev");
  });

  test(`${name}: ref:"main" still reads production`, async () => {
    asked.length = 0;
    await handleToolCall(name, { solution_id: "s", ...args, ref: "main" }, SID);
    assert.equal(asked[0].branch, "main");
  });

  test(`${name}: what a client is told matches what it gets`, () => {
    const t = listed.find((x) => x.name === name);
    assert.ok(t, `${name} is not listed`);
    const ref = t.inputSchema.properties.ref;
    assert.notEqual(ref.default, "main",
      "the schema declares default main — a client that fills in defaults reads production");
    assert.doesNotMatch(t.description, /Default reads from `main`/, "the description still says main");
    assert.doesNotMatch(ref.description, /Default: 'main'/, "the ref description still says main");
    assert.match(t.description, /Default reads `dev`/, "the description does not say what a read without ref gets");
    assert.match(t.description, /ref: 'main'/, "the description no longer says how to read production");
  });
}

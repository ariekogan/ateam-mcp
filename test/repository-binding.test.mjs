// ateam_get_repository_binding: listed as a read-only core tool, asks the
// Builder's binding route for the solution, adds the platform's two branch
// names, and carries no credential.
//
// Run: node --test test/repository-binding.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { setSessionCredentials } from "../src/api.js";
import { handleToolCall, coreTools, TOOL_SAFETY } from "../src/tools.js";
import { BRANCH_WORKFLOW } from "../src/branchWorkflow.js";

const SID = "sess-repository-binding";
const KEY = "adas_tenanta_00000000000000000000000000000000";
const asked = [];
let api;
let reply;

before(async () => {
  api = createHttpServer((req, res) => {
    asked.push(new URL(req.url, "http://x").pathname);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply));
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, { apiKey: KEY, apiUrl: `http://127.0.0.1:${api.address().port}`, explicit: true });
});
after(() => api.close());

test("it is a listed core tool and a read", () => {
  assert.ok(coreTools.some((t) => t.name === "ateam_get_repository_binding"));
  assert.ok(TOOL_SAFETY.read.includes("ateam_get_repository_binding"));
});

test("it asks the Builder's binding route and adds the two branch names", async () => {
  asked.length = 0;
  reply = { ok: true, binding: { provider: "github", solution_id: "sol-1", repository_id: 4242, status: "linked", visibility: "unknown" } };
  const r = await handleToolCall("ateam_get_repository_binding", { solution_id: "sol-1" }, SID);
  assert.ok(!r.isError, r.content?.[0]?.text);
  assert.deepEqual(asked, ["/deploy/solutions/sol-1/github/binding"]);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.binding.repository_id, 4242);
  assert.equal(out.binding.production_branch, BRANCH_WORKFLOW.deploy_branch);
  assert.equal(out.binding.development_branch, BRANCH_WORKFLOW.write_branch);
});

test("a disconnected workspace is passed on as it is", async () => {
  reply = { ok: true, binding: { provider: "github", status: "disconnected", reason: "No GitHub repository is linked (local mode).", repo: null } };
  const r = await handleToolCall("ateam_get_repository_binding", { solution_id: "sol-1" }, SID);
  assert.equal(JSON.parse(r.content[0].text).binding.status, "disconnected");
});

test("its text promises only what Core emits", () => {
  const d = coreTools.find((t) => t.name === "ateam_get_repository_binding").description;
  assert.ok(d.length < 800, `description is ${d.length} characters`);
  assert.match(d, /not recorded yet/);
  assert.doesNotMatch(d, /private \/ public|private or public/);
});

test("GitHub switched off is passed on as it is", async () => {
  reply = { ok: true, enabled: false };
  const r = await handleToolCall("ateam_get_repository_binding", { solution_id: "sol-1" }, SID);
  assert.deepEqual(JSON.parse(r.content[0].text), { ok: true, enabled: false });
});

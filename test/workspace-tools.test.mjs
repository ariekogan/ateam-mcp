// The session workspace tools (Phase C, branch C3c): ateam_workspace_open / exec / status / save / close.
//
// Checked where an agent meets them: tools/list and tools/call over the real MCP server, against a stand-in for
// the Builder's POST /workspace/:method that answers the way Core's facade does (summary + details, a refusal as
// data with `fallback`). The properties:
//   - the five tools are listed, signed-in only, and carry no tenant/person/solution in their schema;
//   - an unsigned session is refused at the gate, nothing sent;
//   - workspace_id is remembered per MCP session and used when omitted; a refusal or a close forgets it;
//   - while a workspace is open the old writers of `dev` are not listed and are refused in the call, and come back
//     on close and on a refused open (and tools/list_changed is sent);
//   - results put `summary` first and `details` last; a refusal carries use_instead; "still going" says to poll;
//   - a tenant/actor/chain argument is refused before anything acts on it.
//
// Run: node --test test/workspace-tools.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { setSessionCredentials, getWorkspaceId } from "../src/api.js";
import { handleToolCall, tools, coreTools, listedTools } from "../src/tools.js";
import { PUBLIC_TOOLS } from "../src/publicTools.js";
import { createServer } from "../src/server.js";
import { WORKSPACE_TOOL_NAMES, WORKSPACE_WITHHELD } from "../src/workspaceTools.js";

const KEY = "adas_tenanta_00000000000000000000000000000000";
const FALLBACK = ["ateam_github_patch", "ateam_github_write"];
let api;
let baseUrl;
let calls; // what the Builder was asked: { method, path, headers, body }
let answer; // (method, body) => object, set per test

before(async () => {
  api = createHttpServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const method = req.url.replace(/^\/workspace\//, "");
      calls.push({ http: req.method, path: req.url, headers: req.headers, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(answer(method, body.params || {})));
    });
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${api.address().port}`;
});
after(() => api.close());

let n = 0;
const signedIn = () => {
  const sid = `ws-tools-${++n}`;
  setSessionCredentials(sid, { apiKey: KEY, apiUrl: baseUrl, explicit: true });
  calls = [];
  return sid;
};
const OPEN_OK = { ok: true, workspace_id: "ws-0123456789ab", state: "open", summary: "Your workspace is ready.", details: { branch: "dev", head: "abc" } };
const happy = (method, p) => {
  if (method === "open") return OPEN_OK;
  if (method === "close") return { ok: true, workspace_id: p.workspace_id, state: "closed", summary: "Closed. Nothing was left unsaved.", details: {} };
  return { ok: true, workspace_id: p.workspace_id, summary: "ok", details: {} };
};
const text = (r) => r.content[0].text;
const json = (r) => JSON.parse(text(r));

test("the five tools are listed with teaching text, no tenant/person/solution argument, and are not public", () => {
  const listed = coreTools.map((t) => t.name);
  for (const name of WORKSPACE_TOOL_NAMES) {
    assert.ok(listed.includes(name), `${name} is not listed`);
    assert.ok(!PUBLIC_TOOLS.has(name), `${name} must need a sign-in`);
    const t = tools.find((x) => x.name === name);
    for (const bad of ["tenant", "tenant_id", "actor_id", "solution_id", "chainId", "chain_id"]) {
      assert.ok(!(bad in t.inputSchema.properties), `${name} declares ${bad}`);
    }
    assert.equal(t._meta.agent_exposure, "outside_only", `${name} must be hidden from Core's own Builder jobs`);
    assert.ok(t.description.length <= 1200, `${name}: ${t.description.length} chars; an in-app agent sees only 1200`);
    assert.match(t.description, /summary/, `${name} does not say to show the summary`);
  }
  const d = (n) => tools.find((t) => t.name === n).description;
  assert.match(d("ateam_workspace_open"), /\/workspace/);
  assert.match(d("ateam_workspace_open"), /cannot see your edits until you call ateam_workspace_save/);
  assert.match(d("ateam_workspace_open"), /never any branch, commit|never pass a workspace/);
  assert.match(d("ateam_workspace_exec"), /100 seconds/);
  assert.match(d("ateam_workspace_exec"), /run_in_background/);
  assert.match(d("ateam_workspace_exec"), /ateam_workspace_status/);
  assert.match(d("ateam_workspace_save"), /still going/);
  assert.match(d("ateam_workspace_save"), /ateam_workspace_status/);
  assert.match(d("ateam_workspace_open"), /use_instead/);
  assert.deepEqual(tools.find((t) => t.name === "ateam_workspace_exec").inputSchema.required, ["command"]);
});

test("an unsigned session is refused at the gate and nothing is sent", async () => {
  calls = [];
  for (const name of WORKSPACE_TOOL_NAMES) {
    const r = await handleToolCall(name, { command: "ls" }, "ws-tools-unsigned");
    assert.equal(r.isError, true, name);
    assert.equal(r.structuredContent.stage, "auth_gate", name);
  }
  assert.equal(calls.length, 0);
});

test("open sends no arguments, via the Builder route, and remembers the id; later calls use it", async () => {
  answer = happy;
  const sid = signedIn();
  const o = await handleToolCall("ateam_workspace_open", {}, sid);
  assert.ok(!o.isError, text(o));
  assert.equal(calls[0].path, "/workspace/open");
  assert.deepEqual(calls[0].body, { params: {} });
  assert.equal(getWorkspaceId(sid), "ws-0123456789ab");

  await handleToolCall("ateam_workspace_exec", { command: "ls", workingDir: "src", timeout: 5000, run_in_background: true }, sid);
  assert.deepEqual(calls[1].body.params, { workspace_id: "ws-0123456789ab", command: "ls", workingDir: "src", timeout: 5000, run_in_background: true });
  await handleToolCall("ateam_workspace_status", {}, sid);
  assert.equal(calls[2].body.params.workspace_id, "ws-0123456789ab");
  await handleToolCall("ateam_workspace_save", { message: "Add a field" }, sid);
  assert.deepEqual(calls[3].body.params, { workspace_id: "ws-0123456789ab", message: "Add a field" });
  // An id the agent passes wins.
  await handleToolCall("ateam_workspace_status", { workspace_id: "ws-aaaaaaaaaaaa" }, sid);
  assert.equal(calls[4].body.params.workspace_id, "ws-aaaaaaaaaaaa");
});

test("a call with no remembered or given id says to open first and sends nothing", async () => {
  answer = happy;
  const sid = signedIn();
  const r = await handleToolCall("ateam_workspace_exec", { command: "ls" }, sid);
  assert.equal(r.isError, true);
  assert.match(json(r).summary, /ateam_workspace_open/);
  assert.equal(calls.length, 0);
});

test("close forgets the id; a refused open forgets it; a transient refusal keeps it", async () => {
  const sid = signedIn();
  answer = happy;
  await handleToolCall("ateam_workspace_open", {}, sid);
  // a transient refusal (a save running) keeps the workspace
  answer = () => ({ ok: false, code: "WORKSPACE_SAVE_RUNNING", summary: "A save of this workspace is still running.", fallback: FALLBACK });
  await handleToolCall("ateam_workspace_close", {}, sid);
  assert.equal(getWorkspaceId(sid), "ws-0123456789ab");
  // "saving" on close keeps it too
  answer = (m, p) => ({ ok: true, workspace_id: p.workspace_id, state: "saving", summary: "The save is still going.", details: {} });
  await handleToolCall("ateam_workspace_close", { save: true }, sid);
  assert.equal(getWorkspaceId(sid), "ws-0123456789ab");
  assert.equal(calls.at(-1).body.params.save, true);
  // the workspace is gone on the server
  answer = () => ({ ok: false, code: "WORKSPACE_NOT_FOUND", summary: "No such workspace.", fallback: FALLBACK });
  await handleToolCall("ateam_workspace_status", {}, sid);
  assert.equal(getWorkspaceId(sid), null);

  answer = happy;
  await handleToolCall("ateam_workspace_open", {}, sid);
  await handleToolCall("ateam_workspace_close", {}, sid);
  assert.equal(getWorkspaceId(sid), null);

  await handleToolCall("ateam_workspace_open", {}, sid);
  answer = () => ({ ok: false, code: "WORKSPACES_SWITCHED_OFF", summary: "Workspaces are switched off for this workspace.", fallback: FALLBACK });
  const refused = await handleToolCall("ateam_workspace_open", {}, sid);
  assert.equal(getWorkspaceId(sid), null);
  assert.equal(refused.isError, true);
});

test("old writers are withheld from tools/list and refused in the call while open, restored after close and after a refused open", async () => {
  const sid = signedIn();
  answer = happy;
  const server = createServer(sid);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "ws", version: "1" });
  let changed = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { changed++; });
  await server.connect(serverT);
  await client.connect(clientT);
  const names = async () => (await client.listTools()).tools.map((t) => t.name);

  let before = await names();
  for (const w of WORKSPACE_WITHHELD) if (coreTools.some((t) => t.name === w)) assert.ok(before.includes(w), `${w} should be listed before`);

  await client.callTool({ name: "ateam_workspace_open", arguments: {} });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(changed, 1, "no tools/list_changed after open");
  const during = await names();
  for (const w of WORKSPACE_WITHHELD) assert.ok(!during.includes(w), `${w} is still listed while a workspace is open`);
  for (const keep of ["ateam_workspace_exec", "ateam_workspace_save", "ateam_github_read", "ateam_github_promote", "ateam_test_skill", "ateam_status_all"]) {
    assert.ok(during.includes(keep), `${keep} must stay`);
  }

  calls = [];
  for (const w of ["ateam_github_patch", "ateam_github_write", "ateam_build_and_run", "ateam_write_agent_doc", "ateam_sync_all", "ateam_delete_skill"]) {
    const r = await handleToolCall(w, { solution_id: "s", path: "a", content: "x", skill_id: "k" }, sid);
    assert.equal(r.isError, true, w);
    assert.equal(r.structuredContent.code, "WORKSPACE_OPEN");
    assert.match(text(r), /ateam_workspace_save/);
    assert.match(text(r), /ateam_workspace_close/);
    assert.doesNotMatch(text(r), /\b(git|branch|commit|dev)\b/i, "a git word reached the agent");
  }
  assert.equal(calls.length, 0, "a withheld tool still reached the Builder");

  await client.callTool({ name: "ateam_workspace_close", arguments: {} });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(changed, 2, "no tools/list_changed after close");
  assert.deepEqual(await names(), before);

  // A refused open restores them as well.
  await client.callTool({ name: "ateam_workspace_open", arguments: {} });
  assert.ok(!(await names()).includes("ateam_github_patch"));
  answer = () => ({ ok: false, code: "WORKSPACE_BOX_FULL", summary: "No room right now.", fallback: FALLBACK });
  await client.callTool({ name: "ateam_workspace_open", arguments: {} });
  assert.ok((await names()).includes("ateam_github_patch"));
  assert.equal(listedTools(sid).length, coreTools.length);
  await client.close();
});

test("results put summary first and details last; a refusal carries use_instead", async () => {
  const sid = signedIn();
  answer = (m, p) => m === "open" ? OPEN_OK : ({
    ok: true, workspace_id: p.workspace_id, details: { branch: "dev", head: "abc" }, stdout: "hi", exit_code: 0, summary: "The command finished.",
  });
  await handleToolCall("ateam_workspace_open", {}, sid);
  const r = await handleToolCall("ateam_workspace_exec", { command: "echo hi" }, sid);
  const keys = Object.keys(json(r));
  assert.equal(keys[0], "ok");
  assert.equal(keys[1], "summary");
  assert.equal(keys.at(-1), "details");
  assert.ok(keys.indexOf("stdout") < keys.indexOf("details"));

  answer = () => ({ ok: false, code: "WORKSPACE_TRIAL_TENANT", summary: "Workspaces are not available on a trial.", fallback: FALLBACK, details: { x: 1 } });
  const refused = await handleToolCall("ateam_workspace_open", {}, sid);
  const body = json(refused);
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.code, "WORKSPACE_TRIAL_TENANT");
  assert.deepEqual(Object.keys(body).slice(0, 2), ["ok", "summary"]);
  assert.deepEqual(body.use_instead.tools, FALLBACK);
  assert.match(body.use_instead.how, /ateam_github_patch/);
  assert.equal(body.fallback, undefined, "the raw fallback should be folded into use_instead");
});

test("save: 'still going' says to poll; a finished status says done; background exec says how to follow", async () => {
  const sid = signedIn();
  answer = happy;
  await handleToolCall("ateam_workspace_open", {}, sid);

  answer = (m, p) => ({ ok: true, workspace_id: p.workspace_id, state: "saving", summary: "The save is still going; ask for the status in a minute.", save: { state: "running", started_at: 1 } });
  const saving = json(await handleToolCall("ateam_workspace_save", {}, sid));
  assert.match(saving.next_step, /ateam_workspace_status/);
  assert.match(saving.next_step, /Do not tell the user it is live/);
  assert.equal(Object.keys(saving)[1], "summary");

  answer = (m, p) => ({ ok: true, workspace_id: p.workspace_id, state: "open", summary: "Your workspace is open and everything in it is saved.", save: { state: "done", started_at: 1, finished_at: 2 }, details: {} });
  const done = json(await handleToolCall("ateam_workspace_status", {}, sid));
  assert.equal(done.next_step, undefined);
  assert.equal(done.save.state, "done");

  answer = (m, p) => ({ ok: true, workspace_id: p.workspace_id, summary: "The command is running in the background.", details: { task_id: "t1", output_file: "/tmp/t1.out" } });
  const bg = json(await handleToolCall("ateam_workspace_exec", { command: "npm test", run_in_background: true }, sid));
  assert.match(bg.next_step, /output file/);
  assert.match(bg.next_step, /ateam_workspace_status/);

  answer = (m, p) => ({ ok: false, code: "DEV_TIMEOUT", workspace_id: p.workspace_id, error: "The command was stopped after 100s.", exit_code: null, fallback: FALLBACK });
  const slow = json(await handleToolCall("ateam_workspace_exec", { command: "npm ci" }, sid));
  assert.equal(slow.summary, "The command was stopped after 100s.");
  assert.match(slow.next_step, /run_in_background/);
});

test("a tenant, person or chain argument is refused before anything acts on it, and is never forwarded", async () => {
  answer = happy;
  const sid = signedIn();
  for (const bad of [{ tenant: "tenantb" }, { tenant_id: "x" }, { actor_id: "admin-1" }, { chain_id: "job_1" }, { chainId: "job_1" }]) {
    calls = [];
    const r = await handleToolCall("ateam_workspace_exec", { command: "ls", workspace_id: "ws-0123456789ab", ...bad }, sid);
    assert.equal(r.isError, true, JSON.stringify(bad));
    assert.equal(r.structuredContent.code, "BAD_ARGS");
    assert.equal(calls.length, 0, "the Builder was reached");
  }
  // And no tool sends one in the body: the body is {params} with only the declared fields.
  await handleToolCall("ateam_workspace_open", { solution_id: "other" }, sid);
  assert.deepEqual(calls[0].body, { params: {} });
  assert.deepEqual(Object.keys(calls[0].body), ["params"]);
});

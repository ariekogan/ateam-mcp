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
import { waitCommand } from "../src/workspaceTools.js";
import { renderAgentDocHeader } from "../src/agentDoc.js";
import { workspaceFailure } from "../src/workspaceTools.js";
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
      const out = answer(method, body.params || {});
      res.writeHead(out?.__status || 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
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
  assert.match(d("ateam_workspace_exec"), /40 seconds/);
  assert.match(d("ateam_workspace_exec"), /output_file/);
  assert.match(d("ateam_workspace_exec"), /status does not show it/);
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
  assert.deepEqual(calls[3].body.params, { workspace_id: "ws-0123456789ab", message: "Add a field", wait_ms: 40_000 });
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
  assert.equal((await listedTools(sid)).length, coreTools.length);
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
  assert.match(bg.next_step, /output_file/);
  assert.match(bg.next_step, /ateam_workspace_exec/);

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

// ── availability: tools and teaching appear only where the platform says workspaces work ──────────────────
const listedNames = async (sid) => (await listedTools(sid)).map((t) => t.name);
const withWorkspaceTools = (names) => WORKSPACE_TOOL_NAMES.every((n) => names.includes(n));
const withoutWorkspaceTools = (names) => WORKSPACE_TOOL_NAMES.every((n) => !names.includes(n));

test("signed in: the five tools are listed whatever Core says or fails to say; not signed in: they are not (and Core is never asked)", async () => {
  // A failing probe used to hide them for a whole chat (a client lists once): Core restarting during a deploy, a 502, a switch off.
  for (const a of [
    () => ({ ok: true, available: false, summary: "Workspaces are switched off for this tenant." }),
    () => ({ __status: 502, ok: false, code: "CORE_TOOL_FAILED" }),
    () => ({ ok: false, code: "WORKSPACE_KEY_HAS_NO_PERSON", summary: "This key is not tied to a person." }),
  ]) {
    const sid = signedIn();
    answer = a;
    calls = [];
    const names = await listedNames(sid);
    assert.ok(withWorkspaceTools(names));
    assert.ok(names.includes("ateam_github_patch"), "the single-file tools stay");
    assert.equal(calls.length, 0, "listing asks Core nothing");
  }
  calls = [];
  assert.ok(withoutWorkspaceTools(await listedNames("never-signed-in")));
  assert.equal(calls.length, 0, "a session that is not signed in is not asked");
});

test("a refused call is answered plainly by the call itself (switch off): the single-file tools are named", async () => {
  const sid = signedIn();
  answer = () => ({ ok: false, code: "WORKSPACES_SWITCHED_OFF", summary: "Workspaces are switched off.", fallback: FALLBACK });
  const r = json(await handleToolCall("ateam_workspace_open", {}, sid));
  assert.equal(r.ok, false);
  assert.deepEqual(r.use_instead.tools, FALLBACK);
});

test("open and close tell a client that honours list_changed; a first listing does not", async () => {
  const sid = signedIn();
  answer = happy;
  const server = createServer(sid);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "ws", version: "1" });
  let changed = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { changed++; });
  await server.connect(serverT);
  await client.connect(clientT);
  assert.ok(withWorkspaceTools((await client.listTools()).tools.map((t) => t.name)));
  assert.equal(changed, 0, "a first listing is not a change");
  await handleToolCall("ateam_workspace_open", {}, sid);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(changed, 1, "list_changed when the old writers are withheld");
  await client.close();
});

test("the teaching text about workspaces is given to a signed-in session, and the agent doc header", async () => {
  const on = signedIn(); answer = happy;
  assert.match(JSON.stringify(await handleToolCall("ateam_bootstrap", {}, on)), /ateam_workspace_open/);
  const base = { solution: { id: "s", name: "S" }, skills: [], connectors: [] };
  assert.match(renderAgentDocHeader(base), /ateam_workspace_open/);
});

// ── a call that fails before Core answers is plain data, never the generic hint text ──────────────────────
test("a Builder error on a workspace call comes back as plain data; a failed open forgets the workspace; other calls keep it and do not point at withheld tools", async () => {
  const sid = signedIn();
  answer = happy;
  await handleToolCall("ateam_workspace_open", {}, sid);
  assert.ok(getWorkspaceId(sid));
  answer = (m) => m === "exec" ? { __status: 500, ok: false, code: "CORE_TOOL_FAILED", error: "Core unreachable (hint: check docker git branch)" } : happy(m, {});
  const r = await handleToolCall("ateam_workspace_exec", { command: "ls" }, sid);
  const body = json(r);
  assert.equal(body.ok, false);
  assert.match(body.summary, /could not be reached just now/);
  assert.doesNotMatch(JSON.stringify(body), /hint|docker|CORE_TOOL_FAILED|git|branch|unreachable/i, "no transport or hint text");
  assert.equal(body.use_instead, undefined, "the single-file tools are withheld while the workspace is remembered");
  assert.ok(getWorkspaceId(sid), "a failed exec keeps the workspace");
  answer = (m) => m === "open" ? { __status: 500, ok: false } : happy(m, {});
  const o = json(await handleToolCall("ateam_workspace_open", {}, sid));
  assert.equal(o.ok, false);
  assert.equal(getWorkspaceId(sid), null, "a failed open leaves nothing remembered");
  assert.deepEqual(o.use_instead.tools, FALLBACK, "now the single-file tools are the way on");
  assert.ok((await listedNames(sid)).includes("ateam_github_patch"));
});

test("a refusal from Core that keeps the workspace does not name the withheld tools; one that clears it does", async () => {
  const sid = signedIn();
  answer = happy;
  await handleToolCall("ateam_workspace_open", {}, sid);
  answer = (m) => m === "save" ? { ok: false, code: "WORKSPACE_SAVE_RUNNING", summary: "A save is still running.", fallback: FALLBACK } : happy(m, {});
  const kept = json(await handleToolCall("ateam_workspace_save", {}, sid));
  assert.equal(kept.use_instead, undefined);
  assert.equal(kept.summary, "A save is still running.");
  answer = (m) => m === "status" ? { ok: false, code: "WORKSPACE_EXPIRED", summary: "This workspace reached its maximum age.", fallback: FALLBACK } : happy(m, {});
  const gone = json(await handleToolCall("ateam_workspace_status", {}, sid));
  assert.deepEqual(gone.use_instead.tools, FALLBACK);
});

test("a timeout says it may still be running, not that it failed; the long calls wait 140 s", async (t) => {
  assert.match(workspaceFailure("save", true, true).summary, /may still be running.*ateam_workspace_status/);
  assert.match(workspaceFailure("open", true, false).summary, /did not answer in time/);
  assert.equal(workspaceFailure("save", true, true).use_instead, undefined);
  assert.deepEqual(workspaceFailure("open", false, false).use_instead.tools, FALLBACK);
  const sid = signedIn();
  answer = happy;
  const delays = [];
  const real = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...rest) => { delays.push(ms); return real(fn, ms, ...rest); });
  await handleToolCall("ateam_workspace_open", {}, sid);
  await handleToolCall("ateam_workspace_status", {}, sid);
  await handleToolCall("ateam_workspace_exec", { command: "ls" }, sid);
  assert.equal(delays.filter((d) => d === 140_000).length, 3, `open, status and exec wait 140 s (saw ${delays})`);
});

test("a workspace that is open keeps its tools, the old writers stay withheld; after close the writers return", async () => {
  const sid = signedIn();
  answer = happy;
  await handleToolCall("ateam_workspace_open", {}, sid);
  let names = await listedNames(sid);
  assert.ok(withWorkspaceTools(names), "the open workspace keeps its tools");
  assert.ok(!names.includes("ateam_github_patch"), "the old writers stay withheld while it is open");
  await handleToolCall("ateam_workspace_close", {}, sid);
  names = await listedNames(sid);
  assert.ok(withWorkspaceTools(names) && names.includes("ateam_github_patch"), "after close: both sets");
  // Core says the switch is off on the next call: the workspace is forgotten and the writers return.
  const sid2 = signedIn();
  await handleToolCall("ateam_workspace_open", {}, sid2);
  answer = () => ({ ok: false, code: "WORKSPACES_SWITCHED_OFF", summary: "Workspaces are switched off.", fallback: FALLBACK });
  await handleToolCall("ateam_workspace_status", {}, sid2);
  names = await listedNames(sid2);
  assert.ok(names.includes("ateam_github_patch"));
});

test("exec: no foreground choice -> started in the background and waited for; a quick command answers like a foreground one", async () => {
  answer = happy;
  const sid = signedIn();
  await handleToolCall("ateam_workspace_open", {}, sid);
  const seen = [];
  answer = (m, p) => {
    if (m !== "exec") return happy(m, p);
    seen.push(p);
    if (p.run_in_background === true) return { ok: true, workspace_id: p.workspace_id, summary: "bg", details: { task_id: "t1", output_file: "/tmp/devtasks/t1/out" } };
    return { ok: true, workspace_id: p.workspace_id, summary: "ok", exit_code: 0, stdout: "__EXIT__ 3\nhello\n", stderr: "" };
  };
  const r = json(await handleToolCall("ateam_workspace_exec", { command: "ls" }, sid));
  assert.equal(seen[0].run_in_background, true);
  assert.equal(seen[0].command, "ls");
  assert.match(seen[1].command, /devtasks\/t1/);
  assert.equal(seen[1].run_in_background, false);
  assert.equal(r.ok, true);
  assert.equal(r.exit_code, 3);
  assert.equal(r.stdout, "hello\n");
  assert.match(r.summary, /exit code 3/);
});

test("exec: a command still running after the wait answers with the background handle and how to follow it", async () => {
  answer = happy;
  const sid = signedIn();
  await handleToolCall("ateam_workspace_open", {}, sid);
  answer = (m, p) => {
    if (m !== "exec") return happy(m, p);
    if (p.run_in_background === true) return { ok: true, workspace_id: p.workspace_id, summary: "bg", details: { task_id: "t1", output_file: "/tmp/devtasks/t1/out" } };
    return { ok: true, workspace_id: p.workspace_id, summary: "ok", exit_code: 0, stdout: "__RUNNING__\n", stderr: "" };
  };
  const r = json(await handleToolCall("ateam_workspace_exec", { command: "npm ci", timeout: 250000 }, sid));
  assert.equal(r.details.output_file, "/tmp/devtasks/t1/out");
  assert.match(r.next_step, /dirname/);
});

test("exec: an explicit run_in_background, or a timeout of 40 s or less, is passed through untouched (one call)", async () => {
  const sid = signedIn();
  await handleToolCall("ateam_workspace_open", {}, sid);
  answer = happy;
  const n = calls.length;
  await handleToolCall("ateam_workspace_exec", { command: "a", run_in_background: false }, sid);
  await handleToolCall("ateam_workspace_exec", { command: "b", run_in_background: true }, sid);
  await handleToolCall("ateam_workspace_exec", { command: "c", timeout: 30000 }, sid);
  assert.equal(calls.length, n + 3);
  assert.equal(calls[n].body.params.run_in_background, false);
  assert.equal(calls[n + 1].body.params.run_in_background, true);
  assert.ok(!("run_in_background" in calls[n + 2].body.params));
});

test("exec: the waiting command refuses an output path it cannot quote", () => {
  assert.equal(waitCommand("/tmp/devtasks/t1/out; rm -rf /"), null);
  assert.equal(waitCommand(undefined), null);
  assert.match(waitCommand("/tmp/devtasks/t1/out"), /sleep 0\.25/);
});

test("background commands are followed with exec and the exit file, never with status", async () => {
  answer = (m, p) => m === "exec" ? { ok: true, workspace_id: "ws-0123456789ab", summary: "x", details: { task_id: "t1", output_file: "/tmp/t1/out" } } : happy(m, p);
  const sid = signedIn();
  await handleToolCall("ateam_workspace_open", {}, sid);
  const r = json(await handleToolCall("ateam_workspace_exec", { command: "npm ci", timeout: 200000 }, sid));
  assert.match(r.next_step, /ateam_workspace_exec/);
  assert.match(r.next_step, /dirname/);
  assert.match(r.next_step, /exit/);
  assert.doesNotMatch(r.next_step, /poll ateam_workspace_status/);
  const tools = (await import("../src/tools.js")).tools;
  const d = (n) => tools.find((t) => t.name === n).description;
  assert.match(d("ateam_workspace_exec"), /dirname <output_file>\)\/exit/);
  assert.match(d("ateam_workspace_exec"), /pass a timeout/);
  assert.doesNotMatch(d("ateam_workspace_status"), /background command is going|after run_in_background/);
});

test("exec: a background start with no timeout gets 100 s, an asked-for timeout is kept (a hung command cannot hold a task slot for an hour)", async () => {
  answer = happy;
  const sid = signedIn();
  await handleToolCall("ateam_workspace_open", {}, sid);
  const seen = [];
  answer = (m, p) => {
    if (m !== "exec") return happy(m, p);
    seen.push(p);
    if (p.run_in_background === true) return { ok: true, workspace_id: p.workspace_id, summary: "bg", details: { task_id: "t1", output_file: "/tmp/devtasks/t1/out" } };
    return { ok: true, workspace_id: p.workspace_id, summary: "ok", stdout: "__RUNNING__\n" };
  };
  await handleToolCall("ateam_workspace_exec", { command: "x" }, sid);
  await handleToolCall("ateam_workspace_exec", { command: "y", timeout: 250000 }, sid);
  const starts = seen.filter((p) => p.run_in_background === true);
  assert.equal(starts[0].timeout, 100000);
  assert.equal(starts[1].timeout, 250000);
});

test("exec: the quick answer keeps the draft-recovery message and details of the start call, and has no stderr key", async () => {
  answer = happy;
  const sid = signedIn();
  await handleToolCall("ateam_workspace_open", {}, sid);
  answer = (m, p) => {
    if (m !== "exec") return happy(m, p);
    if (p.run_in_background === true) return {
      ok: true, workspace_id: p.workspace_id,
      summary: "The command is running in the background; read its output file with another command to follow it. Earlier unsaved work came back: fix src/a.js and save.",
      details: { task_id: "t1", output_file: "/tmp/devtasks/t1/out", recovered: ["src/b.js"], conflicts: ["src/a.js"], failed: [] },
    };
    return { ok: true, workspace_id: p.workspace_id, summary: "ok", stdout: "__EXIT__ 0\nfine\n" };
  };
  const r = json(await handleToolCall("ateam_workspace_exec", { command: "ls" }, sid));
  assert.match(r.summary, /^The command finished\. Earlier unsaved work came back: fix src\/a\.js and save\.$/);
  assert.deepEqual(r.details, { recovered: ["src/b.js"], conflicts: ["src/a.js"], failed: [] });
  assert.ok(!("stderr" in r));
  assert.equal(r.stdout, "fine\n");
});

test("exec: a timeout of 0, negative or not a number is treated as missing (100 s), and the follow text says a killed command leaves no exit file", async () => {
  answer = happy;
  const sid = signedIn();
  await handleToolCall("ateam_workspace_open", {}, sid);
  const seen = [];
  answer = (m, p) => {
    if (m !== "exec") return happy(m, p);
    seen.push(p);
    if (p.run_in_background === true) return { ok: true, workspace_id: p.workspace_id, summary: "bg", details: { task_id: "t1", output_file: "/tmp/devtasks/t1/out" } };
    return { ok: true, workspace_id: p.workspace_id, summary: "ok", stdout: "__RUNNING__\n" };
  };
  let last;
  for (const bad of [0, -5, "abc"]) last = json(await handleToolCall("ateam_workspace_exec", { command: "x", timeout: bad }, sid));
  const starts = seen.filter((p) => p.run_in_background === true);
  assert.deepEqual(starts.map((p) => p.timeout), [100000, 100000, 100000]);
  assert.match(last.next_step, /never appears if the command was killed/);
});

test("open passes Core's environment text through, and exec points at it", async () => {
  const sid = signedIn();
  answer = (m, p) => m === "open" ? { ...OPEN_OK, environment: "a Linux container with git, node" } : happy(m, p);
  const r = json(await handleToolCall("ateam_workspace_open", {}, sid));
  assert.equal(r.environment, "a Linux container with git, node");
  assert.match(tools.find((t) => t.name === "ateam_workspace_exec").description, /`environment` in ateam_workspace_open/);
});

// ── a save deploys and takes over a minute; the chat client gives up near 60 s ───────────────────────────────
test("save and close(save:true) ask Core to answer 'still saving' after 40 s; a close without save asks for nothing of the kind", async () => {
  answer = happy;
  const sid = signedIn();
  await handleToolCall("ateam_workspace_open", {}, sid);
  calls = [];
  await handleToolCall("ateam_workspace_save", {}, sid);
  assert.equal(calls[0].body.params.wait_ms, 40_000);
  await handleToolCall("ateam_workspace_close", { save: true }, sid);
  assert.equal(calls[1].body.params.wait_ms, 40_000);
  assert.equal(calls[1].body.params.save, true);
  await handleToolCall("ateam_workspace_open", {}, sid);
  await handleToolCall("ateam_workspace_close", {}, sid);
  assert.ok(!("wait_ms" in calls[3].body.params), JSON.stringify(calls[3].body.params));
});

test("a save Core says is still going comes back as a handle: not done, nothing lost, poll status in 20-30 s", async () => {
  answer = (method, p) => method === "save"
    ? { ok: true, workspace_id: p.workspace_id, state: "saving", summary: "The save is still going and nothing is lost; ask for the status in about half a minute to see how it ended.", save: { state: "running" } }
    : happy(method, p);
  const sid = signedIn();
  await handleToolCall("ateam_workspace_open", {}, sid);
  const r = json(await handleToolCall("ateam_workspace_save", {}, sid));
  assert.equal(r.ok, true);
  assert.equal(r.save.state, "running");
  assert.match(r.next_step, /20-30 seconds.*ateam_workspace_status.*save field/s);
  assert.match(r.next_step, /Do not tell the user it is live/);
});

// ── deploy and test while a session is open ─────────────────────────────────────────────────────────────────
test("while a workspace is open: ateam_upload_connector with github:true and no files (a redeploy of what was saved) goes through; any form that writes files is refused with the way out", async () => {
  answer = happy;
  const sid = signedIn();
  await handleToolCall("ateam_workspace_open", {}, sid);
  assert.ok((await listedTools(sid)).some((t) => t.name === "ateam_upload_connector"), "listed while a workspace is open");
  for (const args of [
    { solution_id: "s", connector_id: "c", files: [{ path: "a.js", content: "x" }] },
    { solution_id: "s", connector_id: "c", github: true, files: [{ path: "a.js", content: "x" }] },
    { solution_id: "s", connector_id: "c", github: true, replace: true },
    { solution_id: "s", connector_id: "c" },
  ]) {
    const r = await handleToolCall("ateam_upload_connector", args, sid);
    assert.equal(r.structuredContent?.code, "WORKSPACE_OPEN", JSON.stringify(args));
    assert.match(text(r), /ateam_workspace_save/);
    assert.match(text(r), /github:true and no files/);
  }
  const ok = await handleToolCall("ateam_upload_connector", { solution_id: "s", connector_id: "c", github: true }, sid);
  assert.notEqual(ok.structuredContent?.code, "WORKSPACE_OPEN", "a redeploy of the saved work was refused");
  const wait = await handleToolCall("ateam_upload_connector", { solution_id: "s", connector_id: "c", resume: true, job_id: "j1" }, sid);
  assert.notEqual(wait.structuredContent?.code, "WORKSPACE_OPEN", "waiting for an upload already started writes nothing");
  const noJob = await handleToolCall("ateam_upload_connector", { solution_id: "s", connector_id: "c", resume: true }, sid);
  assert.equal(noJob.structuredContent?.code, "WORKSPACE_OPEN", "resume without a job_id is no resume");
  const empty = await handleToolCall("ateam_upload_connector", { solution_id: "s", connector_id: "c", github: true, files: [] }, sid);
  assert.notEqual(empty.structuredContent?.code, "WORKSPACE_OPEN", "an empty files list writes nothing");
});

test("while a workspace is open, the refusal of the shipped-version deploy says saving already deploys and that testing works; ateam_test_skill and ateam_conversation are not withheld", async () => {
  answer = happy;
  const sid = signedIn();
  await handleToolCall("ateam_workspace_open", {}, sid);
  const r = await handleToolCall("ateam_build_and_run", { solution_id: "s" }, sid);
  assert.equal(r.structuredContent.code, "WORKSPACE_OPEN");
  assert.match(text(r), /Saving already deploys.*ateam_workspace_save/s);
  assert.match(text(r), /ateam_test_skill and ateam_conversation work while the workspace is open/);
  const listed = (await listedTools(sid)).map((t) => t.name);
  for (const t of ["ateam_test_skill", "ateam_conversation", "ateam_redeploy", "ateam_upload_connector"]) assert.ok(listed.includes(t), t);
  assert.ok(!WORKSPACE_WITHHELD.has("ateam_test_skill") && !WORKSPACE_WITHHELD.has("ateam_conversation"));
});

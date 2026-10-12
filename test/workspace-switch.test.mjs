// Switching workspace inside one connection: ateam_list_workspaces and
// ateam_switch_workspace.
//
// The platform decides (Core utils/keyWorkspaces.js, through the validator's
// /auth/workspaces). What this server must get right is carrying it:
//   - the question is asked with the session's HOME key — the bearer the person
//     signed in with — not whichever workspace's key the session holds NOW, so
//     listing still works after a switch;
//   - a switch signs in exactly like ateam_auth does (kept per bearer, checked
//     against the API) and leaves the home key alone;
//   - a refusal changes nothing, and no key reaches the tool's result;
//   - a platform session, a master-key session and a signed-out one cannot use it.
//
// Run: node --test test/workspace-switch.test.mjs
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bindSessionBearer, bindSessionPlatform, clearAuthOverride, getAuthOverride, getCredentials, setSessionCredentials, runToolCall } from "../src/api.js";
import { handleToolCall } from "../src/tools.js";

const HEX = "0".repeat(32);
const HOME = `adas_prod_home_${HEX}`;   // the key the person signed in with
const BETA = `adas_prod_beta_${HEX}`;   // beta's own key, handed over by the API
const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });

let calls;
let api;
beforeEach(() => {
  calls = [];
  clearAuthOverride(HOME);
  api = {
    list: () => [200, { ok: true, current: "home", workspaces: [{ tenant: "home", name: "Home", role: "owner", current: true }, { tenant: "beta", name: "Beta", role: "admin", current: false }] }],
    swtch: (body) => body.tenant === "beta"
      ? [200, { ok: true, tenant: "beta", name: "Beta", env: "prod", api_key: BETA }]
      : [403, { ok: false, code: "NOT_YOUR_WORKSPACE", error: `"${body.tenant}" is not a workspace this key's person owns or administers. Nothing changed.` }],
    deploy: () => [200, { solutions: [] }],
  };
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ path: u.pathname, method: opts.method || "GET", key: opts.headers?.["X-API-KEY"] || opts.headers?.["x-api-key"] || null, body });
    let r;
    if (u.pathname === "/auth/workspaces") r = api.list();
    else if (u.pathname === "/auth/workspaces/switch") r = api.swtch(body);
    else if (u.pathname.startsWith("/deploy/solutions")) r = api.deploy();
    else r = [404, { error: "unexpected" }];
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r[1]), { status: r[0], headers: { "Content-Type": "application/json" } });
  };
});

const run = async (sid, name, args = {}, transport = "http") =>
  JSON.parse((await runToolCall(sid, () => handleToolCall(name, args, sid), { transport })).content[0].text);
const asked = (path) => calls.filter((c) => c.path === path);
const hosted = (sid) => { bindSessionBearer(sid, HOME); setSessionCredentials(sid, { tenant: "home", apiKey: HOME, explicit: true }); };

test("a hosted session lists the workspaces, asking with the bearer it signed in with", async () => {
  hosted("ws-list");
  const r = await run("ws-list", "ateam_list_workspaces");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.workspaces.map((w) => w.tenant), ["home", "beta"]);
  assert.equal(asked("/auth/workspaces")[0].key, HOME);
});

test("switching moves the session, is kept per bearer, and asks with the home key even from the new workspace", async () => {
  hosted("ws-switch");
  const r = await run("ws-switch", "ateam_switch_workspace", { tenant: "beta" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.switched_to, "beta");
  assert.equal(r.switched_from, "home");
  assert.equal(getCredentials("ws-switch").tenant, "beta");
  assert.equal(getCredentials("ws-switch").apiKey, BETA);
  assert.equal(getAuthOverride(HOME)?.tenant, "beta", "a later session of this bearer must come back on beta");
  assert.equal(asked("/auth/workspaces/switch")[0].key, HOME);
  assert.ok(!JSON.stringify(r).includes(BETA), "the new workspace's key must not reach the tool result");

  // Now on beta: listing still asks with the HOME key, not beta's.
  calls.length = 0;
  await run("ws-switch", "ateam_list_workspaces");
  assert.equal(asked("/auth/workspaces")[0].key, HOME);
  // …and the way back works the same.
  api.swtch = (b) => (b.tenant === "home" ? [200, { ok: true, tenant: "home", same: false, name: "Home", env: "prod", api_key: HOME }] : [403, { ok: false, code: "NOT_YOUR_WORKSPACE", error: "no" }]);
  const back = await run("ws-switch", "ateam_switch_workspace", { tenant: "home" });
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal(getCredentials("ws-switch").tenant, "home");
});

test("a workspace the API refuses changes nothing and says why; no key in the result", async () => {
  hosted("ws-refused");
  const r = await run("ws-refused", "ateam_switch_workspace", { tenant: "omega" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "NOT_YOUR_WORKSPACE");
  assert.match(r.message, /Nothing changed/);
  assert.equal(getCredentials("ws-refused").tenant, "home");
  assert.equal(getAuthOverride(HOME), null);
  assert.ok(!JSON.stringify(r).includes("adas_"));
});

test("if the new workspace's key is not accepted, the session stays where it was", async () => {
  hosted("ws-badkey");
  api.deploy = () => [401, { error: "Invalid or unconfigured API key" }];
  const r = await run("ws-badkey", "ateam_switch_workspace", { tenant: "beta" });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(getCredentials("ws-badkey").tenant, "home");
  assert.equal(getCredentials("ws-badkey").apiKey, HOME);
  assert.equal(getAuthOverride(HOME), null);
});

test("no workspace named is refused without asking the API: there is no default", async () => {
  hosted("ws-none");
  for (const args of [{}, { tenant: "" }, { tenant: "  " }]) {
    const r = await run("ws-none", "ateam_switch_workspace", args);
    assert.equal(r.code, "WORKSPACE_REQUIRED");
  }
  assert.equal(calls.length, 0);
});

test("the API not answering is said, and nothing changes", async () => {
  hosted("ws-down");
  api.swtch = () => new Error("connect ECONNREFUSED");
  const r = await run("ws-down", "ateam_switch_workspace", { tenant: "beta" });
  assert.equal(r.code, "WORKSPACE_API_UNREACHABLE");
  assert.equal(getCredentials("ws-down").tenant, "home");
});

test("a local (stdio) session keeps the key it was signed in with as its home across a switch", async () => {
  const sid = "ws-stdio";
  const signIn = await run(sid, "ateam_auth", { api_key: HOME }, "stdio");
  assert.equal(signIn.ok, true, JSON.stringify(signIn));
  const r = await run(sid, "ateam_switch_workspace", { tenant: "beta" }, "stdio");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(getCredentials(sid).tenant, "beta");
  calls.length = 0;
  await run(sid, "ateam_list_workspaces", {}, "stdio");
  assert.equal(asked("/auth/workspaces")[0].key, HOME, "home is still the key given to ateam_auth, not beta's");
  // A key the caller gives ateam_auth on purpose IS the new home.
  const OTHER = `adas_prod_other_${HEX}`;
  await run(sid, "ateam_auth", { api_key: OTHER }, "stdio");
  calls.length = 0;
  await run(sid, "ateam_list_workspaces", {}, "stdio");
  assert.equal(asked("/auth/workspaces")[0].key, OTHER);
});

test("a platform session (the A-Team app's builder) cannot list or switch: no request is made", async () => {
  const sid = "ws-platform";
  bindSessionPlatform(sid);
  setSessionCredentials(sid, { tenant: "acme", apiKey: HOME, explicit: true });
  for (const [name, args] of [["ateam_list_workspaces", {}], ["ateam_switch_workspace", { tenant: "beta" }]]) {
    const r = await run(sid, name, args);
    assert.equal(r.code, "PLATFORM_SESSION", name);
  }
  assert.equal(calls.length, 0);
});

test("a master-key session has no person to list for", async () => {
  const sid = "ws-master";
  setSessionCredentials(sid, { tenant: "acme", apiKey: null, explicit: true, masterKey: "m" });
  const r = await run(sid, "ateam_list_workspaces");
  assert.equal(r.code, "MASTER_SESSION");
  assert.equal(calls.length, 0);
});

test("a session that never signed in is refused at the gate, before anything runs", async () => {
  const res = await runToolCall("ws-signed-out", () => handleToolCall("ateam_switch_workspace", { tenant: "beta" }, "ws-signed-out"), { transport: "http" });
  assert.equal(res.isError, true);
  assert.equal(res.structuredContent.stage, "auth_gate");
  assert.equal(calls.length, 0);
});

test("a session that signed in with a key and then a master key has no person to list for", async () => {
  const sid = "ws-key-then-master";
  hosted(sid);
  setSessionCredentials(sid, { tenant: "acme", apiKey: null, explicit: true, masterKey: "m" });
  assert.equal((await run(sid, "ateam_list_workspaces")).code, "MASTER_SESSION");
  assert.equal(calls.length, 0);
});

test("a failed switch does not name the target as the session's tenant", async () => {
  hosted("ws-fail-tenant");
  api.deploy = () => [401, { error: "Invalid or unconfigured API key" }];
  const r = await run("ws-fail-tenant", "ateam_switch_workspace", { tenant: "beta" });
  assert.equal(r.ok, false);
  assert.equal(r.tenant, undefined);
});

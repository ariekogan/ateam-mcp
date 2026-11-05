// PERSONAL SIGN-IN (grantAuth.js, grantSession.js): the person approves this client in the A-Team app,
// and the client holds an opaque atg_ token. This server asks Core who it is and which workspaces the
// person owns or administers, and keeps the chosen workspace's key in its own memory.
//
// What must hold:
//   - ateam-mcp's value at Core's door is HMAC-SHA256(CORE_MCP_SECRET, "ateam-mcp/agent-auth/v1"), the
//     same vector Core's own test pins (ai-dev-assistant apps/backend/security/tests/browserServiceSecret);
//   - an atg_ token Core refuses is a 401; Core unreachable is a 5xx, never a 401 (a 401 signs out);
//   - a session belongs to the GRANT, so a refreshed token keeps it and another grant's token is refused;
//   - a new chat starts on the person's last workspace, or the only one; never a guess between several;
//   - switching is asking; a PROD workspace is switched to only with the user's yes (confirm_prod);
//   - the workspace key never reaches a tool result; ateam_auth takes no key on such a session;
//   - every answer leads with "Workspace: <name> (<env>)".
//
// Run: node --test test/personal-signin.test.mjs
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import express from "express";
import { deriveServiceSecret, _setCoreFetch } from "../src/grantAuth.js";
import { seedGrantSession } from "../src/grantSession.js";
import {
  grantOwner, getSessionOwner, sessionOwnershipOk, getCredentials, isExplicitlyAuthenticated, getAuthOverride,
  KEY_ENVIRONMENTS, clearSession,
} from "../src/api.js";
import { handleToolCall, openingFor } from "../src/tools.js";
import { mountOAuth } from "../src/oauth.js";

process.env.CORE_MCP_SECRET = "test-master";
process.env.ADAS_CORE_URL = "http://core.test:4000";
after(() => _setCoreFetch(null));

const HEX = "0".repeat(32);
const KEY = { home: `adas_prod_home_${HEX}`, other: `adas_prod_other_${HEX}` };
const NAMES = { home: "Home", other: "Other Co" };

/** A stand-in Core: answers cp.agent_auth_api calls, records them, and checks the door. */
function fakeCore({ env = "prod", lastTenant = null, workspaces = ["home", "other"], gid = "g1", down = false, refuseToken = false } = {}) {
  const calls = [];
  _setCoreFetch(async (url, init) => {
    if (down) throw new Error("connect ECONNREFUSED");
    assert.equal(url, "http://core.test:4000/mcp");
    assert.equal(init.headers["x-adas-token"], deriveServiceSecret("test-master"));
    assert.equal(init.headers["x-adas-service"], "ateam-mcp");
    const { method, params } = JSON.parse(init.body).params.arguments;
    calls.push({ method, params });
    let out;
    if (refuseToken) out = { ok: false, status: 401, body: { code: "invalid_token", error: "unknown sign-in token" } };
    else if (method === "resolve") {
      out = { ok: true, gid, userId: "u1", email: "p@x.com", name: "P", env, exp: Math.floor(Date.now() / 1000) + 900, lastTenant };
      if (params.tenant) out.workspace = { tenant: params.tenant, allowed: workspaces.includes(params.tenant) };
    } else if (method === "listWorkspaces") {
      out = { ok: true, env, current: lastTenant, workspaces: workspaces.map((t) => ({ tenant: t, name: NAMES[t], role: "owner" })) };
    } else if (method === "workspaceKey") {
      out = workspaces.includes(params.tenant)
        ? { ok: true, tenant: params.tenant, name: NAMES[params.tenant], env, api_key: KEY[params.tenant], key_minted_by: "act_1", person: { email: "p@x.com" } }
        : { ok: false, status: 403, body: { code: "NOT_YOUR_WORKSPACE", error: "not yours" } };
    } else out = { ok: true };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: out } }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return calls;
}

const req = (token, extra) => ({ auth: { token, extra: { grant: "g1", env: "prod", lastTenant: null, ...extra } } });
const textOf = (r) => r.content.map((c) => c.text).join("\n");
let n = 0;
const sid = () => `grant-sess-${++n}`;
beforeEach(() => _setCoreFetch(null));

test("the door value is HMAC-SHA256(master, 'ateam-mcp/agent-auth/v1') — the vector Core pins too", () => {
  const want = createHmac("sha256", "test-master").update("ateam-mcp/agent-auth/v1").digest("hex");
  assert.equal(deriveServiceSecret("test-master"), want);
  assert.throws(() => deriveServiceSecret(""), /master secret is required/);
});

test("bearer gate: an atg_ token Core knows is accepted with its grant; one Core refuses is a 401; Core down is a 5xx", async () => {
  const mw = mountOAuth(express(), KEY_ENVIRONMENTS).bearerMiddlewareFor("/mcp");
  const verify = async (token) => {
    let status = 200, auth = null;
    const r = { headers: { authorization: `Bearer ${token}`, host: "mcp.ateam-ai.com" }, hostname: "mcp.ateam-ai.com", protocol: "https", get: () => "mcp.ateam-ai.com" };
    const s = { status(c) { status = c; return this; }, set() { return this; }, setHeader() { return this; }, json() { return this; }, end() { return this; } };
    await mw(r, s, () => { auth = r.auth; });
    return { status, auth };
  };
  fakeCore();
  const ok = await verify("atg_good");
  assert.equal(ok.auth?.extra?.grant, "g1", JSON.stringify(ok));
  fakeCore({ refuseToken: true });
  assert.equal((await verify("atg_refused")).status, 401);
  fakeCore({ down: true });
  const down = await verify("atg_core_down");
  assert.ok(down.status >= 500, `Core down must not sign the person out: ${JSON.stringify(down)}`);
});

test("a session belongs to the grant: a refreshed token keeps it, another grant's token does not", () => {
  assert.equal(sessionOwnershipOk(grantOwner("g1"), grantOwner("g1")), true);
  assert.equal(sessionOwnershipOk(grantOwner("g1"), grantOwner("g2")), false);
  assert.equal(sessionOwnershipOk(grantOwner("g1"), "atg_some_token"), false);
  assert.equal(sessionOwnershipOk(`adas_prod_x_${HEX}`, grantOwner("g1")), false);
});

test("a new chat starts on the person's last workspace", async () => {
  fakeCore({ lastTenant: "other" });
  const s = sid();
  await seedGrantSession(req("atg_t1", { lastTenant: "other" }), s);
  assert.equal(getSessionOwner(s), grantOwner("g1"));
  assert.equal(getCredentials(s).tenant, "other");
  assert.equal(isExplicitlyAuthenticated(s), true);
  clearSession(s);
});

test("the only workspace is chosen by itself; with several and none remembered nothing is guessed", async () => {
  fakeCore({ workspaces: ["home"], gid: "g-one" });
  const one = sid();
  await seedGrantSession({ auth: { token: "atg_one", extra: { grant: "g-one", env: "prod" } } }, one);
  assert.equal(getCredentials(one).tenant, "home");

  fakeCore({ workspaces: ["home", "other"], gid: "g-many" });
  const many = sid();
  await seedGrantSession({ auth: { token: "atg_many", extra: { grant: "g-many", env: "prod" } } }, many);
  assert.equal(getCredentials(many).tenant, null);
  assert.equal(isExplicitlyAuthenticated(many), false);
  const opening = openingFor(many, { transport: "http" });
  assert.match(opening, /Workspace: none chosen yet/);
  assert.match(opening, /ateam_switch_workspace/);
  // A workspace tool is refused until one is chosen; choosing passes the gate.
  const refused = await handleToolCall("ateam_list_solutions", {}, many);
  assert.equal(refused.isError, true);
  const listed = JSON.parse((await handleToolCall("ateam_switch_workspace", {}, many)).content[1].text);
  assert.deepEqual(listed.workspaces.map((w) => w.tenant), ["home", "other"]);
  clearSession(one); clearSession(many);
});

test("switching into a PROD workspace waits for the user's yes; then the key goes in and never into the answer", async () => {
  const calls = fakeCore({ lastTenant: "home", gid: "g-sw" });
  const s = sid();
  await seedGrantSession({ auth: { token: "atg_sw", extra: { grant: "g-sw", env: "prod", lastTenant: "home" } } }, s);
  assert.equal(getCredentials(s).tenant, "home");

  const ask = await handleToolCall("ateam_switch_workspace", { tenant: "other" }, s);
  const asked = JSON.parse(ask.content[1].text);
  assert.equal(asked.code, "CONFIRM_PROD");
  assert.equal(getCredentials(s).tenant, "home", "a prod switch happened without the user's yes");
  assert.equal(calls.filter((c) => c.method === "workspaceKey" && c.params.tenant === "other").length, 0, "the key was asked for before the yes");

  const yes = await handleToolCall("ateam_switch_workspace", { tenant: "other", confirm_prod: true }, s);
  const text = textOf(yes);
  assert.equal(getCredentials(s).tenant, "other");
  assert.doesNotMatch(text, /adas_/, "a workspace key reached the tool result");
  assert.match(JSON.parse(yes.content[1].text).message, /Switched to workspace "Other Co" \(prod\)/);
  assert.match(text, /^Workspace: Other Co \(prod\)/, "the answer does not lead with where the work happens");

  const notMine = JSON.parse((await handleToolCall("ateam_switch_workspace", { tenant: "nope", confirm_prod: true }, s)).content[1].text);
  assert.equal(notMine.code, "NOT_YOUR_WORKSPACE");
  assert.equal(getCredentials(s).tenant, "other");
  clearSession(s);
});

test("a dev workspace switches with no confirmation", async () => {
  fakeCore({ env: "dev", gid: "g-dev", lastTenant: "home" });
  const s = sid();
  await seedGrantSession({ auth: { token: "atg_dev", extra: { grant: "g-dev", env: "dev", lastTenant: "home" } } }, s);
  const r = JSON.parse((await handleToolCall("ateam_switch_workspace", { tenant: "other" }, s)).content[1].text);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(getCredentials(s).tenant, "other");
  clearSession(s);
});

test("ateam_auth takes no key on a personal sign-in session, and no override is kept for a grant", async () => {
  fakeCore({ lastTenant: "home", gid: "g-auth" });
  const s = sid();
  await seedGrantSession({ auth: { token: "atg_auth", extra: { grant: "g-auth", env: "prod", lastTenant: "home" } } }, s);
  const r = JSON.parse((await handleToolCall("ateam_auth", { api_key: KEY.other }, s)).content[1].text);
  assert.equal(r.ok, false);
  assert.match(r.message, /takes no key/);
  assert.equal(getCredentials(s).tenant, "home");
  assert.equal(getAuthOverride(grantOwner("g-auth")), null);
  clearSession(s);
});

test("when the person is no longer owner or admin, the key is dropped at the next check", async () => {
  const mine = ["home", "other"];
  fakeCore({ lastTenant: "home", gid: "g-drop", workspaces: mine });
  const s = sid();
  const r = { auth: { token: "atg_drop", extra: { grant: "g-drop", env: "prod", lastTenant: "home" } } };
  await seedGrantSession(r, s);
  assert.equal(getCredentials(s).tenant, "home");
  mine.splice(0, mine.length, "other"); // an owner removed them from "home"
  await seedGrantSession(r, s);
  assert.equal(getCredentials(s).tenant, "home", "(within 60 s the last check stands)");
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  try {
    await seedGrantSession(r, s);
    assert.notEqual(getCredentials(s).tenant, "home", "a workspace the person lost kept its key");
  } finally { Date.now = realNow; }
  clearSession(s);
});

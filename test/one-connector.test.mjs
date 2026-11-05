// ONE CONNECTOR FOR PROD AND DEV (src/envLink.js, personal sign-in slice 8): the production connector reaches the
// person's DEV workspaces by passing their calls on to the DEV connector, with a DEV grant it got through the device code.
//
// What must hold:
//   - linking DEV starts only when asked for DEV (environment "dev"); a mistyped name never opens a DEV request;
//   - no device code, DEV token or workspace key ever reaches a tool result;
//   - in a DEV workspace every call goes to DEV, answered as DEV answered; only the switch stays here;
//   - NEVER SILENTLY INTO PROD: a restart, a new chat, an ended link, the switch turned off, DEV down — every one of
//     them refuses the call; none runs it in a PROD workspace. Only the person's own confirmed switch leaves DEV;
//   - "in DEV" is saved on the grant BEFORE DEV is asked to switch;
//   - DEV must be approved by the same person (email);
//   - one renewal of the DEV token at a time, saved over the token it replaced;
//   - a production grant only, on the address this server knows (never a dev or self-hosted grant).
//
// Run: node --test test/one-connector.test.mjs
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { _setCoreFetch } from "../src/grantAuth.js";
import { _setPeerFetch, remoteOf, offerOf } from "../src/envLink.js";
import { seedGrantSession } from "../src/grantSession.js";
import { getCredentials, clearSession, mcpUrlForEnv, KEY_ENVIRONMENTS } from "../src/api.js";
import { handleToolCall, listedTools } from "../src/tools.js";

process.env.CORE_MCP_SECRET = "test-master";
process.env.ADAS_CORE_URL = "http://core.test:4000";
after(() => { _setCoreFetch(null); _setPeerFetch(null); });

const HEX = "0".repeat(32);
const DEV_URL = mcpUrlForEnv("dev", KEY_ENVIRONMENTS);
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const parse = (r) => JSON.parse(r.content[0].text);
const textOf = (r) => r.content.map((c) => c.text).join("\n");
let n = 0;
const sid = () => `link-sess-${++n}`;

/** Production Core: the grant, its workspaces, and the link fields Core keeps (services/agentAuth.js). */
function prodCore({ linkOn = true, remote = null, devRefresh = null, email = "arie@x.com" } = {}) {
  const g = { remote, devRefresh, lastTenant: null };
  const calls = [];
  _setCoreFetch(async (_url, init) => {
    const { method, params } = JSON.parse(init.body).params.arguments;
    calls.push({ method, params });
    let out;
    if (method === "resolve") {
      out = { ok: true, gid: "g1", userId: "u1", email, env: "prod", exp: Math.floor(Date.now() / 1000) + 900, lastTenant: g.lastTenant,
        remote: g.remote, link: linkOn ? { env: "dev", linked: !!g.devRefresh } : null };
      if (params.tenant) out.workspace = { tenant: params.tenant, allowed: true };
    } else if (method === "listWorkspaces") {
      out = { ok: true, env: "prod", current: g.lastTenant, workspaces: [{ tenant: "jaisos", name: "JAISOS", role: "owner" }, { tenant: "both", name: "Both P", role: "owner" }] };
    } else if (method === "workspaceKey") {
      if (g.remote && params.leave_remote !== true) out = { ok: false, status: 409, body: { code: "REMOTE_ACTIVE", error: "in DEV" } };
      else { g.remote = null; g.lastTenant = params.tenant; out = { ok: true, tenant: params.tenant, name: params.tenant.toUpperCase(), env: "prod", api_key: `adas_prod_${params.tenant}_${HEX}`, key_minted_by: null, person: { email } }; }
    } else if (method === "linkGet") {
      out = { ok: true, env: "dev", refresh_token: linkOn ? g.devRefresh : null, remote: g.remote };
    } else if (method === "linkSet") {
      if (params.refresh_token !== undefined) {
        if (params.previous_refresh_token && params.previous_refresh_token !== g.devRefresh) out = { ok: true, stale: true };
        else { g.devRefresh = params.refresh_token; out = { ok: true }; }
      }
      if (params.remote !== undefined) { g.remote = params.remote ? { env: "dev", ...params.remote } : null; if (params.remote) g.lastTenant = null; out = { ok: true }; }
    } else out = { ok: true };
    return json(200, { jsonrpc: "2.0", id: 1, result: { structuredContent: out } });
  });
  return { g, calls };
}

/** The DEV connector: device code, token renewal, and an MCP endpoint that answers like a DEV personal sign-in. */
function devConnector({ approvedAs = "arie@x.com", workspaces = [{ tenant: "vc-ai", name: "VC AI" }, { tenant: "both", name: "Both D" }] } = {}) {
  const st = { approved: false, denied: false, refreshes: 0, revoked: false, current: null, calls: [], authz: [], deviceStarts: 0, access: "atg_dev_1", refresh: "atr_dev_1", down: false };
  _setPeerFetch(async (url, init = {}) => {
    if (st.down) throw new Error("connect ECONNREFUSED");
    const u = new URL(url);
    assert.equal(u.origin, DEV_URL, "a DEV token went somewhere other than A-Team's DEV connector");
    if (u.pathname === "/device_authorization") {
      st.deviceStarts++;
      return json(200, { device_code: "atd_secret_device_code", user_code: "ABCD-EFGH", verification_uri: "https://dev-app.example/device", verification_uri_complete: "https://dev-app.example/device?code=ABCD-EFGH", expires_in: 600, interval: 5 });
    }
    if (u.pathname === "/token") {
      const f = new URLSearchParams(init.body);
      if (f.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code") {
        if (st.denied) return json(400, { error: "access_denied" });
        if (!st.approved) return json(400, { error: "authorization_pending" });
        return json(200, { access_token: st.access, refresh_token: st.refresh, expires_in: 900 });
      }
      if (f.get("grant_type") === "refresh_token") {
        if (st.revoked || f.get("refresh_token") !== st.refresh) return json(400, { error: "invalid_grant", error_description: "approve again" });
        st.refreshes++;
        st.access = `atg_dev_${st.refreshes + 1}`;
        st.refresh = `atr_dev_${st.refreshes + 1}`;
        await new Promise((r) => setTimeout(r, 20));
        return json(200, { access_token: st.access, refresh_token: st.refresh, expires_in: 900 });
      }
    }
    if (u.pathname === "/mcp") {
      const auth = new Headers(init.headers).get("authorization");
      st.authz.push(auth);
      if (st.revoked || auth !== `Bearer ${st.access}`) return json(401, { error: "invalid_token" });
      const msg = JSON.parse(init.body);
      if (msg.method === "initialize") {
        return json(200, { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "dev", version: "1" } } }, { "mcp-session-id": "dev-sess" });
      }
      if (!("id" in msg)) return new Response(null, { status: 202 });
      if (msg.method === "tools/call") {
        const { name, arguments: a } = msg.params;
        st.calls.push({ name, args: a });
        let out;
        if (name === "ateam_switch_workspace" && !a.tenant) {
          out = { workspace: "Workspace: none chosen yet", ok: true, environment: "dev", signed_in_as: { email: approvedAs }, workspaces: workspaces.map((w) => ({ ...w, role: "owner", environment: "dev", current: w.tenant === st.current })) };
        } else if (name === "ateam_switch_workspace") {
          const w = workspaces.find((x) => x.tenant === a.tenant);
          if (w) st.current = w.tenant;
          out = w ? { workspace: `Workspace: ${w.name} (dev)`, ok: true, tenant: w.tenant, name: w.name, environment: "dev", message: `Switched to workspace "${w.name}" (dev). Signed in as ${approvedAs}.` }
            : { ok: false, code: "NOT_YOUR_WORKSPACE", message: "no" };
        } else {
          out = { workspace: `Workspace: ${st.current} (dev)`, ok: true, ran_on: "dev", tool: name };
        }
        return json(200, { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(out) }] } });
      }
      return json(200, { jsonrpc: "2.0", id: msg.id, result: {} });
    }
    return json(404, { error: "not found" });
  });
  return st;
}

const req = (token, extra = {}) => ({ auth: { token, extra: { grant: "g1", env: "prod", email: "arie@x.com", ...extra } } });
/** One request of the connection: production Core's resolve gives extra (link, remote) as the bearer gate would. */
async function request(token, core, s) {
  const extra = { lastTenant: core.g.lastTenant, remote: core.g.remote, link: { env: "dev", linked: !!core.g.devRefresh } };
  await seedGrantSession(req(token, extra), s);
}
const switchTo = async (s, args) => parse(await handleToolCall("ateam_switch_workspace", args, s));

beforeEach(() => { _setPeerFetch(null); _setCoreFetch(null); });

test("linking DEV starts only when asked for DEV; the list says how", async () => {
  const core = prodCore();
  const dev = devConnector();
  const s = sid();
  await request("atg_p1", core, s);
  const list = await switchTo(s, {});
  assert.deepEqual(list.workspaces.map((w) => w.tenant), ["jaisos", "both"]);
  assert.equal(list.dev.linked, false);
  assert.match(list.dev.how, /environment "dev"/);
  const typo = await switchTo(s, { tenant: "vc-aj" });
  assert.equal(typo.code, "NOT_YOUR_WORKSPACE");
  assert.match(typo.message, /environment "dev"/);
  assert.equal(dev.deviceStarts, 0, "a name that is not in PROD opened a DEV request");
  clearSession(s);
});

test("approve DEV once, then switch into DEV: saved as DEV first, and no code or token in any answer", async () => {
  const core = prodCore();
  const dev = devConnector();
  const s = sid();
  await request("atg_p2", core, s);
  const ask = await handleToolCall("ateam_switch_workspace", { tenant: "vc-ai", environment: "dev" }, s);
  const asked = parse(ask);
  assert.equal(asked.code, "APPROVE_DEV");
  assert.equal(asked.user_code, "ABCD-EFGH");
  assert.match(asked.approve_url, /dev-app\.example\/device\?code=ABCD-EFGH/);
  assert.doesNotMatch(textOf(ask), /atd_|atr_|atg_|adas_/);
  const waiting = parse(await handleToolCall("ateam_switch_workspace", { tenant: "vc-ai", environment: "dev" }, s));
  assert.equal(waiting.code, "APPROVE_DEV");
  assert.match(waiting.message, /not approved yet/);
  assert.equal(dev.deviceStarts, 1, "a second DEV request was opened while one waits");

  dev.approved = true;
  const done = await handleToolCall("ateam_switch_workspace", { tenant: "vc-ai", environment: "dev" }, s);
  const moved = parse(done);
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.equal(moved.workspace, "Workspace: VC AI (dev)");
  assert.match(moved.message, /approved as arie@x\.com/);
  assert.doesNotMatch(textOf(done), /atd_|atr_|atg_|adas_/);
  assert.equal(core.g.devRefresh, "atr_dev_1", "the DEV refresh token is kept on the grant (sealed by Core)");
  // "In DEV" reached Core before DEV was asked to switch.
  const remoteSaved = core.calls.findIndex((c) => c.method === "linkSet" && c.params.remote);
  assert.ok(remoteSaved >= 0);
  assert.equal(core.g.remote.tenant, "vc-ai");
  assert.equal(dev.calls.at(-1).name, "ateam_switch_workspace");
  assert.equal(getCredentials(s).tenant, null, "the session still held a PROD workspace");

  // Every call now goes to DEV, answered as DEV answered.
  const r = await handleToolCall("ateam_list_solutions", {}, s);
  assert.equal(parse(r).ran_on, "dev");
  assert.equal(dev.calls.at(-1).name, "ateam_list_solutions");
  assert.ok(dev.authz.every((a) => a === "Bearer atg_dev_1"));
  // The session lists the workspace tools (they run in DEV).
  assert.ok((await listedTools(s)).some((t) => t.name === "ateam_workspace_open"));

  // A new chat of the same connection is in DEV too, and never picks a PROD workspace.
  const s2 = sid();
  await request("atg_p2", core, s2);
  assert.equal(getCredentials(s2).tenant, null);
  assert.equal(parse(await handleToolCall("ateam_get_solution", { solution_id: "x" }, s2)).ran_on, "dev");
  assert.equal(core.calls.filter((c) => c.method === "workspaceKey").length, 0, "a PROD key was asked for while in DEV");
  clearSession(s); clearSession(s2);
});

async function linkedInDev(token) {
  const core = prodCore();
  const dev = devConnector();
  dev.approved = true;
  const s = sid();
  await request(token, core, s);
  await switchTo(s, { tenant: "vc-ai", environment: "dev" });
  const moved = await switchTo(s, { tenant: "vc-ai", environment: "dev" });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  return { core, dev, s };
}

test("after a restart the connection is still in DEV, with no new approval and no PROD workspace", async () => {
  const { core, dev, s } = await linkedInDev("atg_p3");
  clearSession(s);
  // A restart: this server's memory is gone; Core still holds "in DEV" and the sealed refresh token.
  const st = { ...dev };
  const dev2 = devConnector();
  Object.assign(dev2, { approved: true, refresh: st.refresh, access: "atg_dev_new" });
  const s2 = sid();
  await request("atg_p3", core, s2);
  assert.ok(remoteOf("g1"), "the restart forgot the DEV workspace");
  assert.equal(getCredentials(s2).tenant, null);
  const r = parse(await handleToolCall("ateam_list_solutions", {}, s2));
  assert.equal(r.ran_on, "dev");
  assert.equal(dev2.refreshes, 1, "the stored refresh token was not used");
  assert.equal(core.g.devRefresh, dev2.refresh, "the renewed refresh token was not saved over the old one");
  assert.equal(dev2.deviceStarts, 0);
  assert.equal(core.calls.filter((c) => c.method === "workspaceKey").length, 0);
  clearSession(s2);
});

test("many calls with an expired DEV token make one renewal", async () => {
  const { core, dev, s } = await linkedInDev("atg_p4");
  dev.access = "atg_dev_expired_on_dev"; // DEV no longer accepts the one this server holds
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => handleToolCall("ateam_list_solutions", {}, s)));
  for (const r of rs) assert.equal(parse(r).ran_on, "dev", textOf(r));
  assert.equal(dev.refreshes, 1, `renewed ${dev.refreshes} times`);
  assert.equal(core.g.devRefresh, dev.refresh);
  clearSession(s);
});

test("an ended DEV link refuses the call and stays in DEV: never into PROD", async () => {
  const { core, dev, s } = await linkedInDev("atg_p5");
  dev.revoked = true;
  const r = await handleToolCall("ateam_list_solutions", {}, s);
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.code, "DEV_LINK_ENDED");
  assert.match(textOf(r), /did not run/);
  assert.equal(core.g.devRefresh, null, "the ended link was not forgotten on the grant");
  assert.ok(remoteOf("g1"), "the connection left DEV on its own");
  assert.equal(getCredentials(s).tenant, null);
  assert.equal(core.calls.filter((c) => c.method === "workspaceKey").length, 0);
  // A new chat: still refused, still not in PROD.
  const s2 = sid();
  await request("atg_p5", core, s2);
  assert.equal(getCredentials(s2).tenant, null);
  assert.equal((await handleToolCall("ateam_get_solution", {}, s2)).isError, true);
  // The refusal names the call that approves DEV again, and that call does start a new approval.
  assert.match(textOf(r), /tenant "vc-ai" and environment "dev"/);
  const again = await switchTo(s, { tenant: "vc-ai", environment: "dev" });
  assert.equal(again.code, "APPROVE_DEV", JSON.stringify(again));
  clearSession(s); clearSession(s2);
});

test("a kept DEV client renews and saves with the newest production token, not the one it started with", async () => {
  const { core, dev, s } = await linkedInDev("atg_p7_old");
  // The production access token rotates (every 15 min) while this session's DEV client lives on.
  await request("atg_p7_new", core, s);
  dev.access = "atg_dev_expired_on_dev";
  const r = parse(await handleToolCall("ateam_list_solutions", {}, s));
  assert.equal(r.ran_on, "dev");
  assert.equal(dev.refreshes, 1);
  const saves = core.calls.filter((c) => c.method === "linkSet" && c.params.refresh_token === dev.refresh);
  assert.equal(saves.length, 1, "the renewed DEV refresh token was not saved");
  assert.equal(saves[0].params.access_token, "atg_p7_new", "saved with an old production token");
  assert.equal(core.g.devRefresh, dev.refresh);
  clearSession(s);
});

test("DEV down or the switch turned off: refused with the reason, never run in PROD", async () => {
  const { core, dev, s } = await linkedInDev("atg_p6");
  dev.down = true;
  const down = await handleToolCall("ateam_list_solutions", {}, s);
  assert.equal(down.structuredContent.code, "DEV_UNAVAILABLE");
  dev.down = false;
  // SysAdmin switched the link off: Core's resolve gives no link; the DEV workspace is still reported.
  await seedGrantSession(req("atg_p6", { remote: core.g.remote, link: null }), s);
  const off = await handleToolCall("ateam_list_solutions", {}, s);
  assert.equal(off.structuredContent.code, "DEV_LINK_OFF");
  assert.equal(getCredentials(s).tenant, null);
  assert.equal(core.calls.filter((c) => c.method === "workspaceKey").length, 0);
  clearSession(s);
});

test("leaving DEV is the person's own confirmed switch to a PROD workspace", async () => {
  const { core, s } = await linkedInDev("atg_p7");
  const ask = await switchTo(s, { tenant: "jaisos" });
  assert.equal(ask.code, "CONFIRM_PROD");
  assert.ok(remoteOf("g1"));
  const yes = await switchTo(s, { tenant: "jaisos", confirm_prod: true });
  assert.equal(yes.ok, true, JSON.stringify(yes));
  assert.equal(yes.workspace, "Workspace: JAISOS (prod)");
  const asked = core.calls.find((c) => c.method === "workspaceKey");
  assert.equal(asked.params.leave_remote, true);
  assert.equal(remoteOf("g1"), null);
  assert.equal(getCredentials(s).tenant, "jaisos");
  // Calls run here again.
  const listed = await switchTo(s, {});
  assert.ok(listed.workspaces.some((w) => w.tenant === "vc-ai" && w.environment === "dev"), "the list lost the DEV workspaces");
  assert.ok(listed.workspaces.find((w) => w.tenant === "jaisos").current);
  clearSession(s);
});

test("a name in PROD and DEV is asked about, never guessed", async () => {
  const { s } = await linkedInDev("atg_p8");
  const both = await switchTo(s, { tenant: "both" });
  assert.equal(both.code, "WHICH_ENVIRONMENT");
  const dev = await switchTo(s, { tenant: "both", environment: "dev" });
  assert.equal(dev.ok, true);
  assert.equal(dev.workspace, "Workspace: Both D (dev)");
  clearSession(s);
});

test("DEV approved by another account: the link is dropped and nothing changes", async () => {
  const core = prodCore();
  const dev = devConnector({ approvedAs: "someone@else.com" });
  dev.approved = true;
  const s = sid();
  await request("atg_p9", core, s);
  await switchTo(s, { tenant: "vc-ai", environment: "dev" });
  const r = await switchTo(s, { tenant: "vc-ai", environment: "dev" });
  assert.equal(r.code, "DEV_OTHER_PERSON");
  assert.equal(core.g.devRefresh, null);
  assert.equal(core.g.remote, null);
  assert.equal(remoteOf("g1"), null);
  clearSession(s);
});

test("only a production grant gets the link, and only to the address this server knows", async () => {
  prodCore();
  devConnector();
  const s = sid();
  await seedGrantSession(req("atg_d1", { env: "dev", link: { env: "dev", linked: false } }), s);
  assert.equal(offerOf("g1"), null, "a dev grant was offered a link onwards");
  await seedGrantSession(req("atg_d1", { link: { env: "dev", linked: false, mcp_url: "https://evil.example" } }), s);
  assert.equal(offerOf("g1").mcp_url, DEV_URL, "an address from outside was used");
  clearSession(s);
});

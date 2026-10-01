// THE BROWSER SIGN-IN BELONGS TO THE HOST THE REQUEST ADDRESSED.
//
// Every URL the OAuth surface publishes (the 401 challenge's resource_metadata,
// the protected-resource and authorization-server metadata, and the sign-in
// page's link to the key) came from ONE process-wide value, ATEAM_BASE_URL,
// since OAuth was added (293c43b). The Dockerfile baked
// https://mcp.ateam-ai.com into it, and mac1's dev MCP runs that image, so a
// browser sign-in started on the dev MCP was sent to PRODUCTION's issuer and
// bound a production workspace.
//
// Now the addressed host (X-Forwarded-Host, else Host) decides, classified by
// the one table of environments (api.js KEY_ENVIRONMENTS): a host it names gets
// that environment's URLs, built from the table, never echoed from the
// request. A host it cannot name gets no sign-in and no URL at all — not
// production's.
//
// Hostnames below are request INPUT only, and the dev MCP's is derived from
// the one table of environments at run time: no non-production host is written
// in this file. Nothing reaches a real host: no request here carries a key that
// would be looked up.
// Run: node --test test/oauth-addressed-host.test.mjs   (npm test runs it too)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";

process.env.ADAS_API_URL = "http://127.0.0.1:9"; // nothing here may reach a real API
const { KEY_ENVIRONMENTS } = await import("../src/api.js");

const PROD_HOST = "mcp.ateam-ai.com";
// The dev MCP's host: the dev API host of KEY_ENVIRONMENTS with its "api" label
// read as "mcp". Derived here, independently of src/, so the test checks it.
const DEV_ENV = "dev";
const DEV_HOST = new URL(KEY_ENVIRONMENTS[DEV_ENV]).hostname.replace(/^([a-z0-9]+-)?api\./, "$1mcp.");
if (DEV_HOST === PROD_HOST || !DEV_HOST.includes("mcp.")) throw new Error(`could not derive the dev MCP host (${DEV_HOST})`);
const PROD = `https://${PROD_HOST}`;
const DEV = `https://${DEV_HOST}`;
// A production URL of any A-Team service; the dev MCP's URL does not match.
const PROD_URL = /https:\/\/(?:mcp|app|api)\.ateam-ai\.com/;

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

delete process.env.ATEAM_OAUTH_DISABLED;
const PORT = await freePort();
const { startHttpServer } = await import("../src/http.js");
const listener = startHttpServer(PORT);
await new Promise((r) => listener.listening ? r() : listener.once("listening", r));
after(() => { listener.closeAllConnections?.(); listener.close(); });

// node:http, so the Host header is exactly what the test says.
function send(method, path, { host, xfh, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (host) h.host = host;
    if (xfh) h["x-forwarded-host"] = xfh;
    const r = http.request({ host: "127.0.0.1", port: PORT, method, path, headers: h, timeout: 5000 }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error(`${method} ${path} timed out`)));
    if (body) r.write(body);
    r.end();
  });
}

const INIT = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
const JSON_RPC = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const AUTHORIZE = `/authorize?${new URLSearchParams({
  response_type: "code", client_id: "ateam-public", redirect_uri: CLAUDE, state: "st",
  code_challenge: CHALLENGE, code_challenge_method: "S256",
})}`;
const DEV_KEY = `adas_${DEV_ENV}_acme_${"c3".repeat(16)}`;

/** Everything the sign-in surface publishes to a request addressed this way. */
async function published(addr) {
  const out = {};
  for (const mount of ["/", "/mcp"]) {
    const r = await send("POST", mount, { ...addr, headers: JSON_RPC, body: INIT });
    out[`401 ${mount}`] = { status: r.status, www: r.headers["www-authenticate"] || "", text: r.text };
  }
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server"]) {
    const r = await send("GET", path, addr);
    out[path] = { status: r.status, text: r.text, json: (() => { try { return JSON.parse(r.text); } catch { return null; } })() };
  }
  const page = await send("GET", AUTHORIZE, addr);
  out["/authorize"] = { status: page.status, text: page.text, location: page.headers.location || "" };
  return out;
}
const everything = (p) => JSON.stringify(p);

/** The URLs a client follows, as a client reads them. */
function urlsOf(p) {
  const prm = p["/.well-known/oauth-protected-resource"].json || {};
  const prmMcp = p["/.well-known/oauth-protected-resource/mcp"].json || {};
  const as = p["/.well-known/oauth-authorization-server"].json || {};
  return {
    challenge: ["/", "/mcp"].map((m) => /resource_metadata="([^"]+)"/.exec(p[`401 ${m}`].www)?.[1]),
    resource: [prm.resource, prmMcp.resource],
    authorization_servers: [...(prm.authorization_servers || []), ...(prmMcp.authorization_servers || [])],
    issuer: as.issuer,
    authorization_endpoint: as.authorization_endpoint,
    token_endpoint: as.token_endpoint,
    registration_endpoint: as.registration_endpoint,
  };
}

function assertNamesOnly(p, origin) {
  const u = urlsOf(p);
  const named = (what, v) => `${what} names ${JSON.stringify(v)}`;
  assert.deepEqual(u.challenge, [`${origin}/.well-known/oauth-protected-resource`, `${origin}/.well-known/oauth-protected-resource/mcp`], named("the 401 challenge", u.challenge));
  assert.deepEqual(u.resource, [`${origin}/`, `${origin}/mcp`], named("resource", u.resource));
  assert.deepEqual(u.authorization_servers, [`${origin}/`, `${origin}/`], named("authorization_servers", u.authorization_servers));
  assert.equal(u.issuer, `${origin}/`, named("issuer", u.issuer));
  assert.equal(u.authorization_endpoint, `${origin}/authorize`, named("authorization_endpoint", u.authorization_endpoint));
  assert.equal(u.token_endpoint, `${origin}/token`, named("token_endpoint", u.token_endpoint));
  assert.equal(u.registration_endpoint, `${origin}/register`, named("registration_endpoint", u.registration_endpoint));
  assert.equal(p["/authorize"].status, 200, `/authorize answered ${p["/authorize"].status}`);
  assert.match(p["/authorize"].text, /action="\/authorize-submit"/, "/authorize did not serve the sign-in page");
}

// ─── The dev host ────────────────────────────────────────────────────────────
for (const [how, addr] of [["Host", { host: DEV_HOST }], ["X-Forwarded-Host", { xfh: DEV_HOST }], ["Host, any case", { host: DEV_HOST.toUpperCase() }]]) {
  test(`dev host (${how}): every sign-in URL is the dev MCP's, and nothing names production`, async () => {
    const p = await published(addr);
    assertNamesOnly(p, DEV);
    const hit = everything(p).match(PROD_URL);
    assert.ok(!hit, `a dev-host request was served a production URL: ${hit?.[0]}`);
  });
}

test("dev host: the sign-in page sends no one to production for the key, and names no dev host either", async () => {
  const page = (await send("GET", AUTHORIZE, { host: DEV_HOST })).text;
  assert.ok(!PROD_URL.test(page), "the dev sign-in page links the production app for the key");
  assert.match(page, /your environment&#039;s own A-Team app/, "the dev sign-in page does not say where the key is");
  assert.ok(!/dev-/.test(page), "the sign-in page is served text: it names no dev host");
});

// ─── The prod host ───────────────────────────────────────────────────────────
for (const [how, addr] of [["Host", { host: PROD_HOST }], ["X-Forwarded-Host", { xfh: PROD_HOST }]]) {
  test(`prod host (${how}): every sign-in URL is production's, and nothing names a dev host`, async () => {
    const p = await published(addr);
    assertNamesOnly(p, PROD);
    const s = everything(p);
    assert.ok(!/dev-/.test(s), `a prod-host request was served a dev host: …${s.slice(Math.max(0, s.indexOf("dev-") - 60), s.indexOf("dev-") + 40)}…`);
    assert.ok(p["/authorize"].text.includes("https://app.ateam-ai.com/connect"), "the prod sign-in page lost its key link");
  });
}

// ─── A code belongs to the host that issued it ───────────────────────────────
test("a sign-in completed on the dev host is redeemed there, and on no other host", async () => {
  const page = await send("GET", AUTHORIZE, { host: DEV_HOST });
  const pending = /name="pending_id" value="([^"]+)"/.exec(page.text)?.[1];
  assert.ok(pending, `no pending id on the dev sign-in page (${page.status})`);
  const submit = await send("POST", "/authorize-submit", {
    host: DEV_HOST,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ pending_id: pending, api_key: DEV_KEY }).toString(),
  });
  assert.equal(submit.status, 302, `/authorize-submit answered ${submit.status}`);
  const code = new URL(submit.headers.location).searchParams.get("code");
  const redeem = (host) => send("POST", "/token", {
    host,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: "ateam-public", redirect_uri: CLAUDE }).toString(),
  });
  const elsewhere = await redeem(PROD_HOST);
  assert.ok(!elsewhere.text.includes(DEV_KEY), `the production host redeemed a dev sign-in (${elsewhere.status})`);
  const home = await redeem(DEV_HOST);
  assert.equal(home.status, 200, `the dev host did not redeem its own code: ${home.status} ${home.text.slice(0, 120)}`);
  assert.equal(JSON.parse(home.text).access_token, DEV_KEY);
});

// ─── A host this server cannot name ──────────────────────────────────────────
const FORGED = [
  ["X-Forwarded-Host evil.example", { xfh: "evil.example" }, "evil.example"],
  ["Host evil.example", { host: "evil.example" }, "evil.example"],
  ["X-Forwarded-Host mcp.ateam-ai.com.evil.example", { xfh: "mcp.ateam-ai.com.evil.example" }, "evil.example"],
  ["X-Forwarded-Host x-mcp.ateam-ai.com", { xfh: "x-mcp.ateam-ai.com" }, "x-mcp"],
  ["X-Forwarded-Host api.ateam-ai.com (not an MCP host)", { xfh: "api.ateam-ai.com" }, "api.ateam-ai.com"],
  ["the bare address 127.0.0.1", {}, "127.0.0.1"],
];
for (const [how, addr, echo] of FORGED) {
  test(`unknown host (${how}): no sign-in, no URL, not echoed, not production by default`, async () => {
    const p = await published(addr);
    for (const mount of ["/", "/mcp"]) {
      const c = p[`401 ${mount}`];
      assert.equal(c.status, 401, `${mount} let an anonymous request through (${c.status})`);
      assert.match(c.www, /^Bearer /, `${mount} sent no Bearer challenge`);
      assert.ok(!/resource_metadata/.test(c.www), `${mount} named metadata for a host it cannot name: ${c.www}`);
    }
    for (const key of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server", "/authorize"]) {
      assert.equal(p[key].status, 421, `${key} answered ${p[key].status}, not 421: ${p[key].text.slice(0, 160)}`);
    }
    const form = { "content-type": "application/x-www-form-urlencoded" };
    for (const [path, body, headers] of [
      ["/register", JSON.stringify({ redirect_uris: [CLAUDE], token_endpoint_auth_method: "none" }), { "content-type": "application/json" }],
      ["/token", new URLSearchParams({ grant_type: "refresh_token", refresh_token: `rt_${DEV_KEY}`, client_id: "ateam-public" }).toString(), form],
      ["/authorize-submit", new URLSearchParams({ pending_id: "x", api_key: DEV_KEY }).toString(), form],
    ]) {
      const r = await send("POST", path, { ...addr, headers, body });
      assert.equal(r.status, 421, `${path} answered ${r.status}, not 421: ${r.text.slice(0, 160)}`);
      p[path] = { status: r.status, text: r.text, location: r.headers.location || "" };
    }
    const s = everything(p);
    assert.ok(!/https?:\/\//.test(s), `served a URL: …${s.match(/https?:\/\/[^"\\ ]+/)?.[0]}…`);
    assert.ok(!s.includes(echo), `echoed "${echo}"`);
  });
}

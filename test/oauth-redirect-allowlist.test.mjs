// OAuth redirects go only to known clients (BUILDER-SEC-SIGNIN-P0, part A).
//
// The code this server issues is exchanged for the tenant key a person types
// on the consent page, so whoever owns redirect_uri gets that key. Until P0:
//   - registerClient merged ANY redirect_uris a caller sent into its record,
//     and getClient accepted any client_id;
//   - the consent page named the requester by client_name, which the caller
//     chooses ("Claude" with an attacker's callback read as Claude).
// Now a redirect must be on the allowlist in src/oauth.js (exact Claude,
// ChatGPT and VS Code https callbacks, loopback http on any port, Cursor's app
// scheme), at /register AND at /authorize, and the page names the requester by
// the redirect's host.
//
// Boot mirrors oauth-edges.test.mjs: a fake validator on 127.0.0.1 is the
// process default and the server is its own issuer, so nothing reaches a real
// host. Plain script with a checklist; it ends with process.exit.
//
// Run: node test/oauth-redirect-allowlist.test.mjs   (npm test runs it too)

import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";

const fake = http.createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end("{}"); });
fake.unref();
async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
process.env.ADAS_API_URL = `http://127.0.0.1:${fake.address().port}`;
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
process.env.ATEAM_BASE_URL = BASE;
delete process.env.ATEAM_OAUTH_DISABLED;
const { startHttpServer } = await import("../src/http.js");
startHttpServer(PORT);
await new Promise((r) => setTimeout(r, 400));

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.error(`  ✗ ${name}\n      ${String(e.message).split("\n")[0]}`); }
}

// The SDK limits /register to 20 an hour per client IP, and this file registers
// more than that. trust proxy is 1, so each registration comes from its own
// X-Forwarded-For address.
let registrations = 0;
async function register(redirect_uris, client_name = "t") {
  const n = ++registrations;
  const r = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.77.${n >> 8}.${n & 255}` },
    body: JSON.stringify({ redirect_uris, client_name, token_endpoint_auth_method: "none" }),
    signal: AbortSignal.timeout(5000),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
async function authorize(client_id, redirect_uri) {
  const q = new URLSearchParams({
    response_type: "code", client_id, redirect_uri, state: "st",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256",
  });
  const r = await fetch(`${BASE}/authorize?${q}`, { redirect: "manual", signal: AbortSignal.timeout(5000) });
  return { status: r.status, location: r.headers.get("location"), text: await r.text() };
}
const isConsentPage = (r) => r.status === 200 && r.text.includes('action="/authorize-submit"');

const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const EVIL = "https://evil.example/cb";

// ─── registration ────────────────────────────────────────────────────────────
await test("register with a non-allowlisted redirect → 400 invalid_client_metadata", async () => {
  const r = await register([EVIL]);
  assert.equal(r.status, 400, `registering ${EVIL} answered ${r.status}: ${JSON.stringify(r.json)}`);
  assert.equal(r.json.error, "invalid_client_metadata");
});

await test("an allowlisted redirect does not carry a bad one in with it (no merging)", async () => {
  const r = await register([CLAUDE, EVIL]);
  assert.equal(r.status, 400, `registering [claude.ai, ${EVIL}] answered ${r.status}: ${JSON.stringify(r.json)}`);
});

for (const bad of [
  "http://localhost.evil.example/cb",                 // loopback lookalike host
  "http://127.0.0.1@evil.example/cb",                 // userinfo that reads as loopback
  "https://claude.ai.evil.example/api/mcp/auth_callback",
  "https://claude.ai/api/mcp/auth_callback?next=https://evil.example", // not the exact callback
  "http://claude.ai/api/mcp/auth_callback",           // not https
  "http://10.0.0.5:8080/cb",                           // a LAN host is not loopback
  "cursor://evil.example/oauth/callback",             // Cursor's scheme, not Cursor's host
  "javascript:alert(1)",
  // ChatGPT's per-connection prefix admits ONE segment on chatgpt.com, nothing else
  "https://chatgpt.com.evil.example/connector/oauth/cb123",
  "https://www.chatgpt.com/connector/oauth/cb123",
  "https://chatgpt.com:8443/connector/oauth/cb123",
  "http://chatgpt.com/connector/oauth/cb123",
  "https://chatgpt.com/connector/oauth/",
  "https://chatgpt.com/connector/oauth/a/b",
  "https://chatgpt.com/connector/oauth/../x",
  "https://chatgpt.com/connector/oauth/..",
  "https://chatgpt.com/connector/oauth/cb123?next=https://evil.example",
  "https://chatgpt.com/connector/oauth/cb123#frag",
  "https://chatgpt.com/connector/oauth/a%2Fb",
]) {
  await test(`register refuses ${bad}`, async () => {
    const r = await register([bad]);
    assert.equal(r.status, 400, `registering ${bad} answered ${r.status}: ${JSON.stringify(r.json)}`);
  });
}

const good = {};
for (const [label, uri] of [
  ["claude.ai", CLAUDE],
  ["vscode.dev", "https://vscode.dev/redirect"],
  ["loopback localhost, any port", "http://localhost:49152/callback"],
  ["loopback 127.0.0.1, another port", "http://127.0.0.1:33418/"],
]) {
  await test(`register accepts ${label} (${uri}), and records exactly what was sent`, async () => {
    const r = await register([uri]);
    assert.equal(r.status, 201, `registering ${uri} answered ${r.status}: ${JSON.stringify(r.json)}`);
    assert.deepEqual(r.json.redirect_uris, [uri], `the record holds ${JSON.stringify(r.json.redirect_uris)}`);
    good[uri] = r.json.client_id;
  });
}

// ─── the supported clients, end to end ──────────────────────────────────────
// Each registers exactly as the client does, then completes /authorize: the
// consent page, a well-formed key submitted, and a 302 to ITS redirect carrying
// the code and the state. Claude.ai (both hosts), ChatGPT (the old exact
// callback and the per-connection one), and Cursor (its https callback,
// registered together with cursor://, and the cursor:// one itself).
const KEY = `adas_acme_${"c3".repeat(16)}`;
async function complete(clientId, uri) {
  const page = await authorize(clientId, uri);
  assert.ok(isConsentPage(page), `/authorize with ${uri} answered ${page.status}: ${page.text.slice(0, 160)}`);
  const pending = /name="pending_id" value="([^"]+)"/.exec(page.text)?.[1];
  const r = await fetch(`${BASE}/authorize-submit`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ pending_id: pending, api_key: KEY }),
    redirect: "manual",
  });
  assert.equal(r.status, 302, `/authorize-submit answered ${r.status}`);
  const to = new URL(r.headers.get("location"));
  assert.equal(`${to.origin === "null" ? `${to.protocol}//${to.host}` : to.origin}${to.pathname}`, uri, `the code went to ${to.href}, not ${uri}`);
  assert.ok(to.searchParams.get("code"), "no code on the redirect");
  assert.equal(to.searchParams.get("state"), "st");
}
const CHATGPT_PER_CONNECTION = "https://chatgpt.com/connector/oauth/cb_8f3KzQ2-x.y~Z";
const CURSOR_HTTPS = "https://www.cursor.com/agents/mcp/oauth/callback";
const CURSOR_APP = "cursor://anysphere.cursor-mcp/oauth/callback";
for (const [client, uris, authorizeWith] of [
  ["Claude (claude.ai)", [CLAUDE], [CLAUDE]],
  ["Claude (claude.com)", ["https://claude.com/api/mcp/auth_callback"], ["https://claude.com/api/mcp/auth_callback"]],
  ["ChatGPT (exact callback)", ["https://chatgpt.com/connector_platform_oauth_redirect"], ["https://chatgpt.com/connector_platform_oauth_redirect"]],
  ["ChatGPT (per-connection callback)", [CHATGPT_PER_CONNECTION], [CHATGPT_PER_CONNECTION]],
  ["Cursor (https + cursor://)", [CURSOR_HTTPS, CURSOR_APP], [CURSOR_HTTPS, CURSOR_APP]],
]) {
  await test(`client matrix: ${client} registers ${uris.join(" + ")} and completes /authorize with ${authorizeWith.join(" and ")}`, async () => {
    const reg = await register(uris);
    assert.equal(reg.status, 201, `registering ${uris.join(", ")} answered ${reg.status}: ${JSON.stringify(reg.json)}`);
    assert.deepEqual(reg.json.redirect_uris, uris, `the record holds ${JSON.stringify(reg.json.redirect_uris)}`);
    for (const uri of authorizeWith) await complete(reg.json.client_id, uri);
  });
}

// ─── /authorize ──────────────────────────────────────────────────────────────
for (const uri of ["http://localhost:49152/callback", "http://127.0.0.1:33418/", CLAUDE]) {
  await test(`/authorize with the registered allowlisted redirect ${uri} → the consent page`, async () => {
    const r = await authorize(good[uri], uri);
    assert.ok(isConsentPage(r), `/authorize answered ${r.status}: ${r.text.slice(0, 200)}`);
  });
}

for (const [who, clientId] of [["an unknown client_id (restart fallback)", "unknown-client-xyz"], ["the public client", "ateam-public"]]) {
  await test(`/authorize for ${who} with a non-allowlisted redirect → 400, no page, no redirect`, async () => {
    const r = await authorize(clientId, EVIL);
    assert.equal(r.status, 400, `/authorize to ${EVIL} answered ${r.status} (location ${r.location})`);
    assert.ok(!isConsentPage(r), "the consent page was served for a non-allowlisted redirect");
  });
}

await test("/authorize for a registered client with a redirect it did not register → 400", async () => {
  const r = await authorize(good[CLAUDE], EVIL);
  assert.equal(r.status, 400, `/authorize to ${EVIL} answered ${r.status}`);
  assert.ok(!isConsentPage(r));
});

// ─── the consent page names the redirect host, never client_name ────────────
await test('client_name "Claude" with a loopback redirect → "an app on this computer", the host, and no "Claude"', async () => {
  const uri = "http://localhost:5173/callback";
  const reg = await register([uri], "Claude");
  assert.equal(reg.status, 201);
  const r = await authorize(reg.json.client_id, uri);
  assert.ok(isConsentPage(r), `/authorize answered ${r.status}`);
  assert.ok(r.text.includes("an app on this computer"), "the page does not say the code goes to an app on this computer");
  assert.ok(r.text.includes("localhost:5173"), "the page does not show the redirect host");
  assert.ok(!r.text.includes("Claude"), "the consent page shows the caller-chosen client_name \"Claude\"");
});

await test("a caller-chosen client_name never appears, on the page or on its error re-render", async () => {
  const NAME = "Totally Legit Bank ZQX";
  const reg = await register([CLAUDE], NAME);
  assert.equal(reg.status, 201);
  const r = await authorize(reg.json.client_id, CLAUDE);
  assert.ok(isConsentPage(r), `/authorize answered ${r.status}`);
  assert.ok(r.text.includes("claude.ai"), "the page does not show the redirect host claude.ai");
  assert.ok(!r.text.includes(NAME), "the consent page shows the caller-chosen client_name");

  const pending = /name="pending_id" value="([^"]+)"/.exec(r.text)?.[1];
  assert.ok(pending, "no pending_id on the page");
  const again = await fetch(`${BASE}/authorize-submit`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ pending_id: pending, api_key: "not-a-key" }),
    redirect: "manual",
  });
  const text = await again.text();
  assert.equal(again.status, 400);
  assert.ok(text.includes("claude.ai"), "the error re-render does not show the redirect host");
  assert.ok(!text.includes(NAME), "the error re-render shows the caller-chosen client_name");
});

fake.close();
if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log("\nALL CHECKS PASSED");
process.exit(0);

// EVERY URL THE HTTP TRANSPORT PUBLISHES IS THE ADDRESSED ENVIRONMENT'S — a
// self-hosted box's too, and on the two pages outside the sign-in.
//
// #51 made the sign-in answer by the host a request addressed, from the one
// table of environments (api.js KEY_ENVIRONMENTS). Three things were left:
//   - a SELF-HOSTED box's MCP (mcp.<DOMAIN>) is not in that table, so its
//     browser sign-in answered 421;
//   - /get-api-key redirected to production's key page on every host
//     (c61e60b, eb8e2c2);
//   - /connect-github linked ATEAM_APP_URL || production's app on every host
//     (e52fa0b).
// Now DOMAIN (the variable a self-hosted box's setup page writes) adds that
// box to the table as one more derived environment, and both pages answer by
// the addressed host: production's or the box's own app, and on any other
// environment or a host this server cannot name, the words with no link.
//
// Hostnames are request INPUT only; the dev ones are derived from
// KEY_ENVIRONMENTS at run time, so no non-production A-Team host is written in
// this file. Nothing reaches a real host.
// Run: node --test test/host-derived-pages.test.mjs   (npm test runs it too)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";

process.env.ADAS_API_URL = "http://127.0.0.1:9"; // nothing here may reach a real API
delete process.env.ATEAM_OAUTH_DISABLED;
const { KEY_ENVIRONMENTS } = await import("../src/api.js");
const { startHttpServer } = await import("../src/http.js");

const sibling = (apiBase, label) => new URL(apiBase).hostname.replace(/^([a-z0-9]+-)?api\./, `$1${label}.`);
const PROD_HOST = "mcp.ateam-ai.com";
const DEV_HOST = sibling(KEY_ENVIRONMENTS.dev, "mcp");
const DEV_APP_HOST = sibling(KEY_ENVIRONMENTS.dev, "app");
if (DEV_HOST === PROD_HOST || !DEV_HOST.includes("mcp.")) throw new Error("could not derive the dev MCP host");
const PROD_KEY_PAGE = "https://app.ateam-ai.com/connect";
const PROD_URL = /https:\/\/(?:mcp|app|api)\.ateam-ai\.com/; // the dev MCP's URL does not match
const ANY_URL = /https?:\/\//;
const OWN_APP = /your environment(?:'|&#039;)s own A-Team app/;

const SELF_DOMAIN = "Acme-Box.example"; // as an operator might type it
const SELF_HOST = "mcp.acme-box.example";
const SELF = `https://${SELF_HOST}`;
const SELF_APP = "https://app.acme-box.example";

// ─── Servers: one per DOMAIN ─────────────────────────────────────────────────
async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
const listeners = [];
/** Start a server with DOMAIN = `domain` (undefined: unset); returns its port and what it logged to stderr. */
async function serve(domain) {
  const port = await freePort();
  if (domain === undefined) delete process.env.DOMAIN; else process.env.DOMAIN = domain;
  const errors = [];
  const consoleError = console.error;
  console.error = (...a) => { errors.push(a.join(" ")); };
  let listener;
  try { listener = startHttpServer(port); } finally { console.error = consoleError; delete process.env.DOMAIN; }
  listeners.push(listener);
  await new Promise((r) => listener.listening ? r() : listener.once("listening", r));
  return { port, errors };
}
after(() => { for (const l of listeners) { l.closeAllConnections?.(); l.close(); } });

const PLAIN = await serve(undefined);
const SELFHOSTED = await serve(SELF_DOMAIN);
const MALFORMED = ["https://evil.example", "evil.example:8443", "evil.example/x?y=1"];
const BAD = [];
for (const domain of MALFORMED) BAD.push({ domain, ...(await serve(domain)) });

function send(port, method, path, { host, xfh, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (host) h.host = host;
    if (xfh) h["x-forwarded-host"] = xfh;
    const r = http.request({ host: "127.0.0.1", port, method, path, headers: h, timeout: 5000 }, (res) => {
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
const AUTHORIZE = `/authorize?${new URLSearchParams({
  response_type: "code", client_id: "ateam-public", redirect_uri: "https://claude.ai/api/mcp/auth_callback", state: "st",
  code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256",
})}`;

/** What a host is served: the sign-in's URLs, its page, /get-api-key and /connect-github. */
async function servedTo(port, addr) {
  const challenge = (await send(port, "POST", "/mcp", { ...addr, headers: JSON_RPC, body: INIT })).headers["www-authenticate"] || "";
  const as = await send(port, "GET", "/.well-known/oauth-authorization-server", addr);
  const prm = await send(port, "GET", "/.well-known/oauth-protected-resource/mcp", addr);
  const page = await send(port, "GET", AUTHORIZE, addr);
  const key = await send(port, "GET", "/get-api-key", addr);
  const github = await send(port, "GET", "/connect-github", addr);
  const json = (r) => { try { return JSON.parse(r.text); } catch { return null; } };
  return {
    metadata: /resource_metadata="([^"]+)"/.exec(challenge)?.[1] ?? null,
    as: { status: as.status, json: json(as), text: as.text },
    prm: { status: prm.status, json: json(prm), text: prm.text },
    page: { status: page.status, text: page.text },
    key: { status: key.status, location: key.headers.location ?? null, text: key.text },
    github: { status: github.status, text: github.text },
    all: [challenge, as.text, prm.text, page.text, key.headers.location ?? "", key.text, github.text].join("\n"),
  };
}

// ─── 1. A self-hosted box signs in on its own MCP host ───────────────────────
test("self-hosted box (DOMAIN set): its MCP host gets its own sign-in, key page and app; production and dev keep theirs", async () => {
  for (const addr of [{ host: SELF_HOST }, { xfh: SELF_HOST }]) {
    const s = await servedTo(SELFHOSTED.port, addr);
    assert.equal(s.metadata, `${SELF}/.well-known/oauth-protected-resource/mcp`, `the challenge named ${s.metadata}`);
    assert.equal(s.as.status, 200, `the authorization-server metadata answered ${s.as.status}: ${s.as.text.slice(0, 120)}`);
    assert.deepEqual([s.as.json.issuer, s.as.json.authorization_endpoint, s.as.json.token_endpoint],
      [`${SELF}/`, `${SELF}/authorize`, `${SELF}/token`], `the metadata named ${JSON.stringify(s.as.json)}`);
    assert.equal(s.prm.json?.resource, `${SELF}/mcp`);
    assert.ok(s.page.text.includes(`href="${SELF_APP}/connect"`), "the sign-in page does not link the box's own key page");
    assert.equal(s.key.location, `${SELF_APP}/connect`, `/get-api-key sent the person to ${s.key.location}`);
    assert.ok(s.github.text.includes(`href="${SELF_APP}"`), "/connect-github does not link the box's own app");
    assert.ok(!PROD_URL.test(s.all), `a self-hosted request was served a production URL: ${s.all.match(PROD_URL)?.[0]}`);
    assert.ok(!s.all.includes(DEV_HOST) && !s.all.includes(DEV_APP_HOST), "a self-hosted request was served a dev host");
  }
  // Production and dev are what they were.
  const prod = await servedTo(SELFHOSTED.port, { host: PROD_HOST });
  assert.equal(prod.as.json?.issuer, `https://${PROD_HOST}/`, `production's issuer is ${prod.as.json?.issuer}`);
  assert.equal(prod.key.location, PROD_KEY_PAGE, `production's /get-api-key went to ${prod.key.location}`);
  const dev = await servedTo(SELFHOSTED.port, { host: DEV_HOST });
  assert.equal(dev.as.json?.issuer, `https://${DEV_HOST}/`, `dev's issuer is ${dev.as.json?.issuer}`);
  assert.equal(dev.key.location, null, `/get-api-key redirected a dev-host request to ${dev.key.location}`);
});

// ─── 2. No DOMAIN, no self-hosted host ───────────────────────────────────────
test("DOMAIN unset: a self-hosted MCP host is one this server cannot name — 421, no URL, nothing echoed", async () => {
  const s = await servedTo(PLAIN.port, { host: SELF_HOST });
  assert.equal(s.metadata, null, `the challenge named ${s.metadata}`);
  assert.equal(s.as.status, 421, `the metadata answered ${s.as.status}`);
  assert.equal(s.key.location, null, `/get-api-key redirected to ${s.key.location}`);
  assert.ok(!ANY_URL.test(s.all), `served a URL: ${s.all.match(/https?:\/\/[^"\s<]+/)?.[0]}`);
  assert.ok(!s.all.includes("acme-box"), "echoed the addressed host");
  assert.match(s.key.text, OWN_APP);
});

// ─── 3. A malformed DOMAIN is refused, and never becomes a URL ───────────────
for (const bad of BAD) {
  test(`malformed DOMAIN ${JSON.stringify(bad.domain)}: refused at startup with a log line that does not repeat it, and never served`, async () => {
    const said = bad.errors.join("\n");
    assert.match(said, /DOMAIN is set but is not a bare hostname/, `startup said: ${said || "(nothing)"}`);
    assert.ok(!said.includes("evil"), "the log line repeats the malformed value");
    for (const addr of [{ host: "mcp.evil.example" }, { xfh: "mcp.evil.example" }, { host: "evil.example" }, {}]) {
      const s = await servedTo(bad.port, addr);
      assert.equal(s.metadata, null, `the challenge named ${s.metadata}`);
      assert.equal(s.as.status, 421, `the metadata answered ${s.as.status}`);
      assert.ok(!ANY_URL.test(s.all), `served a URL: ${s.all.match(/https?:\/\/[^"\s<]+/)?.[0]}`);
      assert.ok(!s.all.includes("evil"), "served the malformed value or the addressed host");
    }
  });
}

// ─── 4. /get-api-key and /connect-github answer by the addressed host ────────
test("dev host: /get-api-key and /connect-github name no URL at all — not production's, not dev's", async () => {
  for (const addr of [{ host: DEV_HOST }, { xfh: DEV_HOST }]) {
    const s = await servedTo(PLAIN.port, addr);
    assert.equal(s.key.location, null, `/get-api-key redirected a dev-host request to ${s.key.location}`);
    assert.equal(s.key.status, 200);
    assert.match(s.key.text, OWN_APP);
    assert.ok(!ANY_URL.test(s.key.text), `/get-api-key served a URL: ${s.key.text.match(/https?:\/\/\S+/)?.[0]}`);
    assert.ok(!ANY_URL.test(s.github.text), `/connect-github linked ${s.github.text.match(/https?:\/\/[^"\s<]+/)?.[0]}`);
    assert.match(s.github.text, OWN_APP);
  }
});

test("unknown host: /get-api-key and /connect-github name no URL and echo nothing", async () => {
  for (const addr of [{ xfh: "evil.example" }, { host: "mcp.ateam-ai.com.evil.example" }, {}]) {
    const s = await servedTo(PLAIN.port, addr);
    assert.equal(s.key.location, null, `/get-api-key redirected to ${s.key.location}`);
    const both = `${s.key.text}\n${s.github.text}`;
    assert.ok(!ANY_URL.test(both), `served a URL: ${both.match(/https?:\/\/[^"\s<]+/)?.[0]}`);
    assert.ok(!both.includes("evil"), "echoed the addressed host");
  }
});

test("(control) prod host: /get-api-key goes to production's key page and /connect-github links production's app; no dev host", async () => {
  const s = await servedTo(PLAIN.port, { host: PROD_HOST });
  assert.equal(s.key.status, 302);
  assert.equal(s.key.location, PROD_KEY_PAGE);
  assert.ok(s.github.text.includes('href="https://app.ateam-ai.com"'), "/connect-github lost production's app link");
  assert.ok(!s.all.includes("dev-"), "a prod-host request was served a dev host");
});

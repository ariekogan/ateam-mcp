// DEVICE CODE (RFC 8628) on the hosted connector: an app with no browser asks /device_authorization for
// a link and a code, the person approves in the A-Team app, and the app's /token poll gets the tokens.
// Core holds every rule (services/agentAuth.js deviceOpen/devicePoll); this server only speaks the
// protocol, on the host whose environment is its Core's. A Core outage is a 503, never a sign-out.
//
// Run: node --test test/device-code.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { mountOAuth, DEVICE_GRANT } from "../src/oauth.js";
import { _setCoreFetch } from "../src/grantAuth.js";
import { KEY_ENVIRONMENTS } from "../src/api.js";

process.env.CORE_MCP_SECRET = "test-master";
process.env.ADAS_CORE_URL = "http://core.test:4000";

const app = express();
mountOAuth(app, KEY_ENVIRONMENTS);
const srv = http.createServer(app);
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const PORT = srv.address().port;
after(() => { srv.close(); _setCoreFetch(null); });

let core = {}; const calls = [];
_setCoreFetch(async (_url, init) => {
  const { method, params } = JSON.parse(init.body).params.arguments;
  calls.push({ method, params });
  if (core.down) throw new Error("ECONNREFUSED");
  const out = core[method] ? core[method](params) : { ok: false, status: 400, body: { code: "x", error: "x" } };
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: out } }), { status: 200 });
});

function post(path, form, host = "mcp.ateam-ai.com") {
  const body = new URLSearchParams(form).toString();
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, method: "POST", path, headers: { Host: host, "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => resolve({ status: res.statusCode, json: t ? JSON.parse(t) : null }));
    });
    r.on("error", reject); r.end(body);
  });
}

const OPENED = { ok: true, env: "prod", device_code: "atd_x", user_code: "KQ7M-4XRT", verification_uri: "https://app.ateam-ai.com/device", verification_uri_complete: "https://app.ateam-ai.com/device?code=KQ7M-4XRT", expires_in: 600, interval: 5 };

test("an app gets a link and a code; the requester is named by what it is, never by the client", async () => {
  core = { deviceOpen: () => OPENED };
  const r = await post("/device_authorization", { client_id: "c-term", client_name: "Claude (honest)" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.user_code, "KQ7M-4XRT");
  assert.equal(r.json.interval, 5);
  assert.equal(r.json.verification_uri, "https://app.ateam-ai.com/device");
  assert.equal(calls.at(-1).params.requester.name, "An app using a sign-in code");
});

test("the poll: pending is an OAuth error the app waits on; approved gives the tokens", async () => {
  core = { devicePoll: () => ({ ok: false, status: 400, body: { code: "authorization_pending", error: "waiting" } }) };
  const wait = await post("/token", { grant_type: DEVICE_GRANT, device_code: "atd_x", client_id: "c-term" });
  assert.equal(wait.status, 400);
  assert.equal(wait.json.error, "authorization_pending");
  core = { devicePoll: () => ({ ok: true, access_token: "atg_a", refresh_token: "atr_r", token_type: "Bearer", expires_in: 900 }) };
  const ok = await post("/token", { grant_type: DEVICE_GRANT, device_code: "atd_x", client_id: "c-term" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.access_token, "atg_a");
});

test("another environment's Core is refused, and a Core outage is a 503, not a sign-out", async () => {
  core = { deviceOpen: () => ({ ...OPENED, env: "dev" }) };
  assert.equal((await post("/device_authorization", { client_id: "c-term" })).status, 400);
  core = { down: true };
  assert.equal((await post("/token", { grant_type: DEVICE_GRANT, device_code: "atd_x", client_id: "c-term" })).status, 503);
});

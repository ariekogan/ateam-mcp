// MGAP-A1 (interim text) and MGAP-A31: what the texts say about signing in and
// about which environment a session is on is what the code does.
//
// A1. ateam_auth's description (94b9bc0) and the auth gate's refusal (c61e60b)
// sent an agent to have the user "get their API key" and hand it over. Since
// 9f84856 a session the user authorized in the browser through the hosted
// connector is signed in with no key in the chat (http.js seedCredentials);
// neither text said so. The device-code sign-in is a separate design: this
// checks the interim text only.
//
// A31. Since bff5934 the key's adas_<env>_ prefix picks the environment, yet
// the texts still taught the model before it: `url` "to target a different
// environment" (57007d3), keys "adas_xxxxx" / "adas_<tenant>_<32hex>", the
// bootstrap's base "as set by ateam_auth's `url`" (af5e366), and on_connect
// "Derive environment from the authed api url" (dbd38f7) while ateam_auth
// returns `environment` itself.
//
// Environments are checked against KEY_ENVIRONMENTS, the one map of them, and
// on_connect's field names against the results they are read from. Since
// 2026-10-01 a served text names the production environment only (Arie: the
// package is public); the steps themselves are pinned by
// test/sign-in-and-switch.test.mjs.
//
// Run: node --test test/sign-in-texts.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { KEY_ENVIRONMENTS } from "../src/api.js";
import { tools, handleToolCall } from "../src/tools.js";

const HOSTED = "https://mcp.ateam-ai.com";
const HEX = "0".repeat(32);
const realFetch = globalThis.fetch;
before(() => {
  // ateam_auth verifies the key with one GET /deploy/solutions; answer it here.
  globalThis.fetch = async () => new Response(JSON.stringify({ solutions: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
});
after(() => { globalThis.fetch = realFetch; });

const tool = (n) => tools.find((t) => t.name === n);
const gateText = async () => {
  const r = await handleToolCall("ateam_list_solutions", {}, "sess-signin-none");
  assert.equal(r.structuredContent?.stage, "auth_gate", "not the auth gate's refusal");
  return r.content[0].text;
};

// The environments a text names, as "adas_<env>_… → <base>".
const namedEnvironments = (text) => Object.fromEntries([...text.matchAll(/adas_([a-z]+)_… → (\S+?)[,)]/g)].map((m) => [m[1], m[2]]));

test("A1: the gate's refusal sends the user to the browser sign-in, not to fetch a key", async () => {
  const text = await gateText();
  assert.ok(text.includes(HOSTED), `no hosted connector in:\n${text}`);
  assert.match(text, /The A-Team sign-in page opens in the browser/);
  assert.doesNotMatch(text, /get-api-key/, "still tells the user to go get a key");
  assert.doesNotMatch(text, /adas_<tenant>_<32hex>/, "still teaches the key format bff5934 replaced");
});

test("A1: the refusal keeps the contract a proxy replays on", async () => {
  const r = await handleToolCall("ateam_list_solutions", {}, "sess-signin-none-2");
  assert.equal(r.isError, true);
  assert.deepEqual(r.structuredContent, { ok: false, code: "UNAUTHENTICATED", stage: "auth_gate" });
  assert.match(r.content[0].text, /^Authentication required/);
});

test("A1: ateam_auth's description names the browser sign-in and no key page", () => {
  const d = tool("ateam_auth").description;
  assert.ok(d.includes(HOSTED), d);
  assert.match(d, /The A-Team sign-in page opens in the browser/);
  assert.doesNotMatch(d, /get-api-key/);
});

test("A31: a text that names an environment names production only, with its host", async () => {
  const t = tool("ateam_auth");
  for (const [where, text] of [
    ["ateam_auth.description", t.description],
    ["ateam_auth.api_key", t.inputSchema.properties.api_key.description],
  ]) {
    assert.deepEqual(namedEnvironments(text), { prod: KEY_ENVIRONMENTS.prod }, `${where}: ${text}`);
  }
  // The gate gives the sign-in steps, which pick no environment by name.
  assert.deepEqual(namedEnvironments(await gateText()), {});
});

test("A31: `url` is not taught as the way to reach an A-Team environment", () => {
  const d = tool("ateam_auth").inputSchema.properties.url.description;
  for (const base of Object.values(KEY_ENVIRONMENTS)) {
    assert.ok(!d.includes(base), `url's description offers ${base}, which the key already selects: ${d}`);
  }
  assert.match(d, /neither A-Team environment|self-hosted/);
});

test("A31: on_connect reads fields that exist in the results it names", async () => {
  const auth = await handleToolCall("ateam_auth", { api_key: `adas_dev_tenanta_${HEX}` }, "sess-signin-dev");
  const authed = JSON.parse(auth.content[0].text);
  assert.equal(authed.ok, true, auth.content[0].text);
  assert.equal(authed.environment, "dev");
  const boot = JSON.parse((await handleToolCall("ateam_bootstrap", {}, "sess-signin-dev")).content[0].text);
  const onConnect = boot.assistant_behavior_contract.environment_transparency.on_connect;
  const fields = [...onConnect.matchAll(/`(\w+)`/g)].map((m) => m[1]);
  assert.ok(fields.length > 0, `on_connect names no field to read — it derives the environment instead: ${onConnect}`);
  for (const f of fields) {
    assert.ok(f in authed || f in boot, `on_connect reads \`${f}\`, which neither ateam_auth nor ateam_bootstrap returns`);
  }
  assert.doesNotMatch(onConnect, /[Dd]erive environment from the authed api url/);
  assert.equal(boot.served_by, authed.environment, "bootstrap and ateam_auth disagree on the environment");
});

test("A31: bootstrap's note does not say the environment is set by `url`", async () => {
  const boot = JSON.parse((await handleToolCall("ateam_bootstrap", {}, "sess-signin-none-3")).content[0].text);
  assert.doesNotMatch(boot.runtime._note, /as set by ateam_auth's `url`/);
  assert.match(boot.runtime._note, /adas_<env>_/);
});

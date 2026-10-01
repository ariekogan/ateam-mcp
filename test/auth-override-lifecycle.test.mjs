// An ateam_auth override is kept for a bearer only when the key was accepted,
// and a new sign-in on the A-Team page drops it.
//
// The override (8fc71af) is per bearer and re-applied to every new session of
// that bearer (http.js seedCredentials) for SESSION_TTL. It was stored BEFORE
// the key was checked, so even a refused key stuck: a reconnect or a new chat
// came back on it. And nothing dropped it when the person signed in again on
// the A-Team page with their own key, so "the key decides the workspace" was
// false for an hour after any ateam_auth.
//
// Run: node --test test/auth-override-lifecycle.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { bindSessionBearer, getAuthOverride, getCredentials, getBaseUrl, isExplicitlyAuthenticated, runToolCall } from "../src/api.js";
import { handleToolCall, openingFor } from "../src/tools.js";
const steps = await import("../src/signInSteps.js").catch(() => ({}));
import { mountOAuth } from "../src/oauth.js";

const HEX = "0".repeat(32);
const BEARER = `adas_prod_home_${HEX}`;      // the key the person signed in with
const OTHER = `adas_prod_other_${HEX}`;      // a key an ateam_auth call was given
const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });
const answer = (status, body) => { globalThis.fetch = async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); };

test("a refused key leaves no override for the bearer", async () => {
  bindSessionBearer("sess-ov-refused", BEARER);
  answer(401, { error: "Invalid or rotated key" });
  const r = JSON.parse((await handleToolCall("ateam_auth", { api_key: OTHER }, "sess-ov-refused")).content[0].text);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(getAuthOverride(BEARER), null, "the refused key was kept for every later session of this bearer");
});

test("(control) an accepted key is kept for the bearer", async () => {
  bindSessionBearer("sess-ov-accepted", BEARER);
  answer(200, { solutions: [] });
  const r = JSON.parse((await handleToolCall("ateam_auth", { api_key: OTHER }, "sess-ov-accepted")).content[0].text);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(getAuthOverride(BEARER)?.tenant, "other");
});

test("a new sign-in on the A-Team page drops the bearer's override", async () => {
  bindSessionBearer("sess-ov-reauth", BEARER);
  answer(200, { solutions: [] });
  await handleToolCall("ateam_auth", { api_key: OTHER }, "sess-ov-reauth");
  assert.equal(getAuthOverride(BEARER)?.tenant, "other", "no override to drop — this would prove nothing");

  // The person signs in again on /authorize with their own key: the code the
  // page issued is exchanged for the token (exactly what the SDK's /token does).
  const { providers: { prod: provider } } = mountOAuth(express());
  const client = { client_id: "ateam-public" };
  provider.codes.set("code-1", { client, params: { codeChallenge: "c", redirectUri: "http://localhost/cb" }, apiKey: BEARER, expiresAt: Date.now() + 60_000 });
  const tokens = await provider.exchangeAuthorizationCode(client, "code-1");
  assert.equal(tokens.access_token, BEARER);
  assert.equal(getAuthOverride(BEARER), null, "the new sign-in kept the workspace an earlier ateam_auth had moved this bearer to");
});

// Review round 2 (R2-2): the session's OWN record. ateam_auth wrote the new
// key into the session before checking it, and left it there when the API
// refused it: a stdio session stayed on the refused key, and its opening said
// it was signed in to that key's workspace.
const stdio = (sid, fn) => runToolCall(sid, fn, { transport: "stdio" });
const state = (sid) => ({ creds: getCredentials(sid), base: getBaseUrl(sid), signedIn: isExplicitlyAuthenticated(sid), opening: openingFor(sid, { transport: "stdio" }) });

test("a refused key leaves a signed-in session exactly as it was", async () => {
  answer(200, { solutions: [] });
  await stdio("sess-own-in", () => handleToolCall("ateam_auth", { api_key: BEARER }, "sess-own-in"));
  const before = state("sess-own-in");
  assert.equal(before.creds.tenant, "home");
  answer(401, { error: "Invalid or rotated key" });
  const r = JSON.parse((await stdio("sess-own-in", () => handleToolCall("ateam_auth", { api_key: OTHER }, "sess-own-in"))).content[0].text);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.deepEqual(state("sess-own-in"), before, "the refused key changed the session");
});

test("a refused key leaves a session that never signed in signed out", async () => {
  const before = state("sess-own-out");
  assert.equal(before.signedIn, false);
  answer(401, { error: "Invalid or rotated key" });
  await stdio("sess-own-out", () => handleToolCall("ateam_auth", { api_key: OTHER }, "sess-own-out"));
  const after = state("sess-own-out");
  assert.equal(after.signedIn, false, `the refused key signed the session in; it now opens: ${after.opening.split("\n")[0]}`);
  assert.deepEqual(after, before);
});

// Review round 3: the master-key path rolls back the same way. Removing its
// refused() kept the whole suite green.
test("a refused master key leaves a signed-in session exactly as it was", async () => {
  answer(200, { solutions: [] });
  await stdio("sess-own-master", () => handleToolCall("ateam_auth", { api_key: BEARER }, "sess-own-master"));
  const before = state("sess-own-master");
  answer(401, { error: "Invalid master key" });
  const r = JSON.parse((await stdio("sess-own-master", () => handleToolCall("ateam_auth", { master_key: "not-the-key", tenant: "elsewhere" }, "sess-own-master"))).content[0].text);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.deepEqual(state("sess-own-master"), before, "the refused master key changed the session");
});

// Review round 3: the refusal is described for the session as it stands after
// the rollback. Built before it, a session that had never signed in was told
// that "the key this session signed in with" may have been rotated, with
// switch steps.
test("a refused key's message describes the session as it now stands", async () => {
  answer(401, { error: "Invalid or rotated key" });
  const out = JSON.parse((await stdio("sess-own-msg-out", () => handleToolCall("ateam_auth", { api_key: OTHER }, "sess-own-msg-out"))).content[0].text);
  assert.doesNotMatch(out.message, /may have been rotated|HOW TO SWITCH/, `a session that never signed in was told about its own key:\n${out.message}`);
  assert.match(out.message, /Nothing changed: this session is still not signed in\./);
  assert.ok(typeof steps.connectSteps === "function" && out.message.includes(steps.connectSteps({ audience: "stdio" })), out.message);

  answer(200, { solutions: [] });
  await stdio("sess-own-msg-in", () => handleToolCall("ateam_auth", { api_key: BEARER }, "sess-own-msg-in"));
  answer(401, { error: "Invalid or rotated key" });
  const still = JSON.parse((await stdio("sess-own-msg-in", () => handleToolCall("ateam_auth", { api_key: OTHER }, "sess-own-msg-in"))).content[0].text);
  assert.doesNotMatch(still.message, /may have been rotated/, still.message);
  assert.match(still.message, /Nothing changed: this session is still signed in to workspace "home"\./);
});

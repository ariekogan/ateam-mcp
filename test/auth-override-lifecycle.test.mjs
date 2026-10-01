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
import { bindSessionBearer, getAuthOverride } from "../src/api.js";
import { handleToolCall } from "../src/tools.js";
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
  const { provider } = mountOAuth(express(), "http://127.0.0.1:9");
  const client = { client_id: "ateam-public" };
  provider.codes.set("code-1", { client, params: { codeChallenge: "c", redirectUri: "http://localhost/cb" }, apiKey: BEARER, expiresAt: Date.now() + 60_000 });
  const tokens = await provider.exchangeAuthorizationCode(client, "code-1");
  assert.equal(tokens.access_token, BEARER);
  assert.equal(getAuthOverride(BEARER), null, "the new sign-in kept the workspace an earlier ateam_auth had moved this bearer to");
});

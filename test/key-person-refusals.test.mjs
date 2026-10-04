// A PERSON THE PLATFORM WILL NOT ACT AS — what the agent is told.
//
// Core refuses by name since ai-dev-assistant 9f32bac37, each a 401 with a
// top-level code: verify-agent-key answers KEY_OWNER_DELETED or
// KEY_OWNER_INACTIVE when the person an API key belongs to was deleted or is no
// longer active, and attachActor answers ACTOR_INACTIVE for a named person it
// will not act as. The Builder answers the same codes in its own words, with a
// hint and actor_id (Builder #117).
//
// Before: formatError answered each with the table's 401 — "the key this
// session signed in with may have been rotated", plus the sign-in steps — which
// sends the reader to sign in again with the very key that runs nothing. And
// Core's old answer for a deleted owner, `Actor "<id>" not found`, read here as
// "NOT an auth problem — your key is fine". Now:
//   - each code, in Core's shape and in the Builder's, gets its own way out,
//     naming the person; none says the key is fine, none is the rotated-key hint;
//   - none is an actor-not-found, so none unbinds the session's actor;
//   - ateam_auth given such a key is told the same, not "rotated, revoked";
//     driven through the real handleToolCall for an older key that names no
//     API (whose refusal was headed "WRONG API, most likely — not a bad key")
//     and a sealed key (whose whoami error kept 300 characters of the body,
//     cutting the Builder's hint, and appended "upgrade it or pass tenant")
//     (CORE review of #48, aa342968);
//
// Run: node --test test/key-person-refusals.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import * as API from "../src/api.js";
import { handleToolCall } from "../src/tools.js";

const { formatError, actorNotFound } = API;
const BASE = "https://api.ateam-ai.com";
const HOSTED = { audience: "hosted", signedIn: true, environment: "prod", tenant: "acme" };
const OWNER = "actor-key-owner";

// Core's shapes at 9f32bac37 (routes/auth.js verify-agent-key, middleware/
// attachActor.js inactiveActorRefusal) — the Builder's test
// personRefusalsAreNamed.test.js pins them to Core's source.
const CORE = {
  KEY_OWNER_DELETED: { ok: false, code: "KEY_OWNER_DELETED", actorId: OWNER, error: "The person this workspace key belongs to has been deleted — mint a new key in Tenant Admin → Tokens & Keys" },
  KEY_OWNER_INACTIVE: { ok: false, code: "KEY_OWNER_INACTIVE", actorId: OWNER, error: 'The person this workspace key belongs to is no longer active (status "inactive") — mint a new key in Tenant Admin → Tokens & Keys' },
  ACTOR_INACTIVE: { ok: false, code: "ACTOR_INACTIVE", actorId: OWNER, error: 'This person is no longer active in this workspace (status "inactive")' },
};
// The Builder's: its own words, a hint, actor_id (snake case), retryable:false.
const builder = (code) => ({ ok: false, code, retryable: false, actor_id: OWNER, error: `the Builder's sentence for ${code} (actor ${OWNER})`, hint: `the Builder's way out for ${code}` });

const WAY_OUT = {
  KEY_OWNER_DELETED: /This API key belongs to a person who has been deleted \(actor actor-key-owner\)[\s\S]*a workspace owner or admin rotates the key \(Tenant Admin → Tokens & Keys, in the A-Team app\)/,
  KEY_OWNER_INACTIVE: /This API key belongs to a person who is no longer active in this workspace \(actor actor-key-owner\)[\s\S]*reactivates or approves that person \(Tenant Admin → Users, in the A-Team app\), and the same key works again; or they rotate the key/,
  ACTOR_INACTIVE: /The platform will not act as the person \(actor actor-key-owner\): they are no longer active in this workspace, so the call did not run/,
};
const STALE = [
  [/NOT an auth problem/i, "the actor-not-found hint (\"your key is fine\")"],
  [/your key is fine/i, "\"your key is fine\""],
  [/may have been rotated/i, "the rotated-key 401 hint"],
  [/rotated, revoked, or not a key for this API/i, "ateam_auth's refused-key hint"],
  [/does not recognise the ACTOR/i, "the actor-not-found hint"],
];
const NO_DEV_HOST = /dev-api|dev-builder|dev-app|adas_dev_/i;

for (const code of Object.keys(CORE)) {
  for (const [shape, body] of [["Core's", CORE[code]], ["the Builder's", builder(code)]]) {
    test(`${code} in ${shape} shape: its own way out, naming the person — not the key-is-fine or rotated-key hint`, () => {
      const msg = formatError("POST", "/deploy/solutions/s/connectors/c/call", 401, JSON.stringify(body), BASE, { read: false, signIn: HOSTED });
      assert.match(msg, WAY_OUT[code]);
      for (const [rx, what] of STALE) assert.doesNotMatch(msg, rx, `${code} (${shape}) was answered with ${what}`);
      assert.doesNotMatch(msg, NO_DEV_HOST);
      assert.equal(actorNotFound(401, JSON.stringify(body)), null, `${code} read as an actor-not-found: the session's actor would be unbound`);
    });
  }
}

test("the key-owner codes end with how THIS session signs in with the new key; ACTOR_INACTIVE does not send it to sign in", () => {
  for (const code of ["KEY_OWNER_DELETED", "KEY_OWNER_INACTIVE"]) {
    assert.match(formatError("GET", "/deploy/solutions", 401, JSON.stringify(CORE[code]), BASE, { signIn: HOSTED }), /HOW TO SWITCH WORKSPACE/);
    assert.match(formatError("GET", "/deploy/solutions", 401, JSON.stringify(CORE[code]), BASE, { signIn: { audience: "stdio", signedIn: false } }), /HOW TO SIGN IN — this session is a local ateam-mcp process/);
  }
  assert.doesNotMatch(formatError("GET", "/deploy/solutions", 401, JSON.stringify(CORE.ACTOR_INACTIVE), BASE, { signIn: HOSTED }), /HOW TO (SWITCH|SIGN IN)/);
});

test("ateam_auth given a key whose person is gone is told so — not \"rotated, revoked, or not a key for this API\"", () => {
  const msg = formatError("GET", "/deploy/solutions", 401, JSON.stringify(builder("KEY_OWNER_DELETED")), BASE,
    { read: true, signIn: { audience: "hosted", signedIn: false, environment: "prod" }, refusedSignIn: true });
  assert.match(msg, WAY_OUT.KEY_OWNER_DELETED);
  assert.doesNotMatch(msg, /rotated, revoked, or not a key for this API/);
});

test("the code is read with its status, at the top level of the body only", () => {
  assert.equal(API.personRefused?.(403, CORE.KEY_OWNER_DELETED), null);
  assert.equal(API.personRefused?.(401, { ok: false, error: "x", detail: CORE.KEY_OWNER_DELETED }), null);
  assert.deepEqual(API.personRefused?.(401, JSON.stringify(CORE.ACTOR_INACTIVE)), { code: "ACTOR_INACTIVE", actor: OWNER });
  // On any other status the table's hint stands.
  assert.match(formatError("GET", "/deploy/solutions", 403, JSON.stringify(CORE.KEY_OWNER_DELETED), BASE, { signIn: HOSTED }), /This key is not allowed to do this here/);
});

// ─── ateam_auth, through the real dispatcher ─────────────────────────────────
//
// The Builder's bodies as #117 serves them (coreCredential.personRefusal):
// the hint is past the first 300 characters of the body.
const BUILDER_SAYS = {
  KEY_OWNER_DELETED: {
    ok: false, code: "KEY_OWNER_DELETED", retryable: false, actor_id: OWNER,
    error: `This API key belongs to a person who no longer exists: the account that minted it (actor ${OWNER}) was deleted. A key acts as the person who minted it, so nothing runs under this key, not as that person and not as the platform's service identity. The request did not run.`,
    hint: "Mint a new key as a person who exists: a workspace owner or admin rotates the key in Tenant Admin → Tokens & Keys at https://app.ateam-ai.com, and the new key belongs to them. Rotating replaces this key for every agent that uses it. Retrying with this key will not help.",
  },
  KEY_OWNER_INACTIVE: {
    ok: false, code: "KEY_OWNER_INACTIVE", retryable: false, actor_id: OWNER,
    error: `This API key belongs to a person who is no longer active in this workspace: the account that minted it (actor ${OWNER}) may not act (removed, suspended or not yet approved). A key acts as the person who minted it, so nothing runs under this key, not as that person and not as the platform's service identity. The request did not run.`,
    hint: "Either a workspace owner or admin reactivates or approves that person in Tenant Admin → Users at https://app.ateam-ai.com, or a workspace owner or admin rotates the key in Tenant Admin → Tokens & Keys at https://app.ateam-ai.com, and the new key belongs to them. Rotating replaces this key for every agent that uses it. Retrying with this key will not help until one of them is done.",
  },
};
const HEX = "0123456789abcdef0123456789abcdef";
const NO_ENV_KEY = `adas_acme_${HEX}`;
// A sealed key in the layout Core mints, built, not pasted (see
// key-environment.test.mjs): adas_<env>_ + base64url(version, iv, tenant, tag, secret).
const SEALED_KEY = "adas_prod_" + Buffer.concat([
  Buffer.from([1]), Buffer.alloc(8, 0xfb), Buffer.alloc(14, 0xff), Buffer.alloc(8, 0xef), Buffer.alloc(16, 0x00),
]).toString("base64url");
const realFetch = globalThis.fetch;
let sid = 0;

async function signInWith(key, body) {
  const asked = [];
  globalThis.fetch = async (u) => {
    asked.push(new URL(String(u)).pathname);
    return new Response(JSON.stringify(body), { status: 401, headers: { "Content-Type": "application/json" } });
  };
  try {
    const r = await handleToolCall("ateam_auth", { api_key: key }, `sess-key-person-${++sid}`);
    return { out: JSON.parse(r.content[0].text), asked };
  } finally {
    globalThis.fetch = realFetch;
  }
}

for (const [label, key, path] of [
  ["an older key that names no API (refused on /deploy/solutions)", NO_ENV_KEY, "/deploy/solutions"],
  ["a sealed key (refused on /auth/whoami)", SEALED_KEY, "/auth/whoami"],
]) {
  for (const code of Object.keys(BUILDER_SAYS)) {
    test(`ateam_auth, ${label}, ${code}: the API's own answer and its way out — not WRONG API, not "upgrade it or pass tenant"`, async () => {
      assert.equal(API.parseApiKey(key).sealed, path === "/auth/whoami", "the fixture is not the kind of key this case is about");
      const { out, asked } = await signInWith(key, BUILDER_SAYS[code]);
      assert.ok(asked.includes(path), `ateam_auth never asked ${path}: ${asked.join(", ")}`);
      assert.equal(out.ok, false, JSON.stringify(out));
      for (const [rx, what] of [
        [/WRONG API|not a bad key/, "the older-key wrong-environment headline"],
        [/upgrade it or pass tenant|could not tell me who you are/, "the sealed-key no-whoami text"],
        [/rotated, revoked, or not a key for this API/, "the refused-key hint"],
        ...STALE,
      ]) assert.doesNotMatch(out.message, rx, `${label} / ${code} was answered with ${what}`);
      assert.match(out.message, WAY_OUT[code], "ateam-mcp's way out for this session is missing");
      // The Builder's hint, WHOLE: it starts past the first 300 characters of the body.
      assert.ok(JSON.stringify(BUILDER_SAYS[code]).indexOf('"hint"') > 300, "the fixture's hint is not past the 300-character cut");
      assert.ok(out.message.includes(JSON.stringify(BUILDER_SAYS[code].hint).slice(1, -1)), "the Builder's own hint was cut");
      assert.equal(out.code, code);
      assert.doesNotMatch(out.message, NO_DEV_HOST);
    });
  }
}

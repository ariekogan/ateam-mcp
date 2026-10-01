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
//   - TEST_RUNS_AS carries KEY_OWNER_GONE, byte for byte the Builder's.
//
// Run: node --test test/key-person-refusals.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import * as API from "../src/api.js";
import * as RunsAs from "../src/testRunsAs.js";

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

test("TEST_RUNS_AS says a key whose person is gone runs nothing — byte for byte the Builder's KEY_OWNER_GONE", () => {
  assert.equal(RunsAs.KEY_OWNER_GONE,
    "A key whose person has since been deleted, or is no longer active in the workspace, runs nothing: it is refused " +
    "(401 KEY_OWNER_DELETED or KEY_OWNER_INACTIVE) and never run as anyone else, until a workspace owner or admin " +
    "rotates the key in Tokens & Keys (the new key belongs to whoever rotated it) or reactivates that person.");
  assert.ok(RunsAs.TEST_RUNS_AS.includes(RunsAs.KEY_OWNER_GONE + " " + RunsAs.RAN_AS_IN_REPLY), "KEY_OWNER_GONE is not a part of TEST_RUNS_AS");
});

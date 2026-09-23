// Session actor binding — entrance, exit, and the 401 that must not lie.
//
// A clean-tenant e2e had every call fail with `Actor "dev" not found` from an
// agent that never sent an actor, and the 401 told it the API key had expired.
// A PROD agent believed that hint and asked a human to paste a key.
//
// Three properties this file exists to hold:
//   1. only run-starting tools may bind an actor from a RESULT
//   2. a session CAN be unbound (nothing could, before — a bad bind was forever)
//   3. an actor-not-found 401 never says "your API key expired"
//
// Run: node test/actor-binding.test.mjs

import {
  setSessionCredentials,
  touchSession,
  clearSessionActor,
  getSessionContext,
  formatError,
} from "../src/api.js";

let failures = 0;
function check(name, cond) {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}`); failures++; }
}

const KEY = "adas_tenanta_00000000000000000000000000000000";
const SID = "sess-actor-test";

setSessionCredentials(SID, { apiKey: KEY, explicit: true });

// ─── The exit that did not exist ─────────────────────────────────────────────
console.log("unbinding");

touchSession(SID, { actorId: "dev" });
check("a session can bind an actor", getSessionContext?.(SID)?.actorId === "dev");

check("clearSessionActor reports it removed one", clearSessionActor(SID, "test") === true);
check("the actor is gone after unbinding", !getSessionContext?.(SID)?.actorId);
check("unbinding an unbound session is a no-op, not an error",
  clearSessionActor(SID, "test") === false);

// ─── The entrance is still open for real actors ──────────────────────────────
console.log("binding still works");

touchSession(SID, { actorId: "ebe3dd82-e609-456f-9277-72f0986f40ed" });
check("a real actor still binds",
  getSessionContext?.(SID)?.actorId === "ebe3dd82-e609-456f-9277-72f0986f40ed");

// A generated thread key must still be refused — the older rule this must keep.
touchSession(SID, { actorId: "test_1787398001214_ka1mtb" });
check("a generated thread key does NOT overwrite a real actor",
  getSessionContext?.(SID)?.actorId === "ebe3dd82-e609-456f-9277-72f0986f40ed");

clearSessionActor(SID, "cleanup");

// ─── The error must name the right cause ─────────────────────────────────────
//
// This section used to declare its OWN copy of the classifier regex and test
// that copy — so it proved a string in this file matched a string in this
// file, and production was never called. It passed while the real classifier
// missed the 400 form entirely. It now calls formatError.
console.log("actor-not-found classification");

const say = (status, body) => formatError("POST", "/solutions/x/skills/y/test", status, JSON.stringify(body), "https://api.ateam-ai.com");

for (const status of [401, 400]) {
  // BOTH codes carry this cause. Core answers 401 directly; the Builder's test
  // route classifies it correctly as 400 ACTOR_NOT_FOUND. Keying on 401 alone
  // meant the better-classified one got the key-is-invalid hint.
  const msg = say(status, { ok: false, connector_id: "invoice-mcp", error: 'Actor "dev" not found' });
  check(`${status}: names the ACTOR as the cause`, /does not recognise the ACTOR/i.test(msg));
  check(`${status}:   and names WHICH actor`, /"dev"/.test(msg));
  check(`${status}:   and says re-authenticating will not help`, /Re-authenticating will not help/i.test(msg));
  check(`${status}:   and does NOT blame the API key`, !/key may be invalid or expired/i.test(msg));
}

// The Builder emits a code rather than the actor's name in some shapes.
const coded = say(400, { ok: false, code: "ACTOR_NOT_FOUND", error: "Core does not recognize actor" });
check("the ACTOR_NOT_FOUND code alone is enough to reclassify", /does not recognise the ACTOR/i.test(coded));
check("  and it never prints empty quotes for the name", !/ACTOR ""/.test(coded));

// Narrowing, not replacement — a real auth failure must still say so.
const realAuth = say(401, { error: "Invalid or unconfigured API key" });
check("a genuine invalid-key 401 is NOT reclassified", !/does not recognise the ACTOR/i.test(realAuth));
check("  and still blames the key", /key/i.test(realAuth));
check("an unrelated 401 is NOT reclassified",
  !/does not recognise the ACTOR/i.test(say(401, { error: "Authentication required" })));
check("an unrelated 400 is NOT reclassified",
  !/does not recognise the ACTOR/i.test(say(400, { error: "message is required" })));

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

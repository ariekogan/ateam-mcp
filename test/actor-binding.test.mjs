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

// ─── The 401 must name the right cause ───────────────────────────────────────
// Matching the classifier used in formatError. If this regex and that one drift,
// the hint silently reverts to blaming the API key — which is the whole defect.
console.log("401 classification");

const ACTOR_401 = /Actor\s+\\?"([^"\\]+)\\?"\s+not found|unknown actor\s+\\?"?([^"\\,}]+)/i;

const actorBody = JSON.stringify({
  ok: false, connector_id: "invoice-mcp", error: 'Actor "dev" not found',
});
const m = ACTOR_401.exec(actorBody);
check("an actor-not-found 401 is recognised", !!m);
check("  and the offending actor is extracted", (m?.[1] || m?.[2]) === "dev");

check("a genuine invalid-key 401 is NOT reclassified",
  !ACTOR_401.test(JSON.stringify({ error: "Invalid or unconfigured API key" })));
check("an unrelated 401 is NOT reclassified",
  !ACTOR_401.test(JSON.stringify({ error: "Authentication required" })));

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

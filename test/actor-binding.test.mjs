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
  get,
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

// THE BUILDER'S OWN ACTOR_NOT_FOUND CARRIES code + hint. formatError drops the
// status-level hint whenever a body has both (5a6a9f5), and that silently
// removed this one on the one path it mattered — the Builder's test and job
// routes (d357b5c98d). This hint is not a guess about the status: it reports
// what request() just did to the session. Both are shown, and they must agree:
// the Builder says "Retrying will not help … OMIT the actor entirely".
const BUILDER_ACTOR_400 = {
  ok: false,
  code: "ACTOR_NOT_FOUND",
  error: 'Core does not recognize actor "bob": Actor "bob" not found',
  hint: "Retrying will not help. OMIT the actor entirely to read a job the tenant owns, or pass a real actor id.",
};
const both = say(400, BUILDER_ACTOR_400);
check("code+hint: the actor hint survives the endpoint's own hint", /Hint: NOT an auth problem/.test(both));
check("  and names the actor", /does not recognise the ACTOR "bob"/.test(both));
check("  and the Builder's hint is still there, in the body", /Retrying will not help\. OMIT the actor/.test(both));
check("  and they agree: re-sending THAT actor will not help", /neither will sending that actor again/.test(both));
check("  and the tenant path is the same call WITHOUT an actor, not a bare retry",
  /sent again without an actor, now acts as the tenant/.test(both) && !/retrying the same call now acts/i.test(both));
check("(control) any other code+hint body still drops the status-level hint",
  !/Hint:/.test(say(404, { code: "NO_MATCH", hint: "copy the exact bytes" })));

// Narrowing, not replacement — a real auth failure must still say so.
const realAuth = say(401, { error: "Invalid or unconfigured API key" });
check("a genuine invalid-key 401 is NOT reclassified", !/does not recognise the ACTOR/i.test(realAuth));
check("  and still blames the key", /key/i.test(realAuth));
check("an unrelated 401 is NOT reclassified",
  !/does not recognise the ACTOR/i.test(say(401, { error: "Authentication required" })));
check("an unrelated 400 is NOT reclassified",
  !/does not recognise the ACTOR/i.test(say(400, { error: "message is required" })));

// ─── The self-heal must key on a VERDICT, not a token ────────────────────────
//
// The hint and the self-heal used to carry two different regexes. The
// self-heal's made the quotes optional and matched ACTOR_NOT_FOUND as a bare
// substring anywhere in the body, so a 400 that merely ECHOED the token — or
// Core's own "unknown actor_skills plugin" — unbound a valid session actor and
// every later call quietly ran as the tenant. This drives the REAL request()
// against a local server, so it tests what production does, not a copy.
console.log("self-heal fires on the verdict, never on an echo");

const { createServer } = await import("node:http");
let nextReply = { status: 200, body: {} };
const server = createServer((req, res) => {
  res.writeHead(nextReply.status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(nextReply.body));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const API = `http://127.0.0.1:${server.address().port}`;
const HEAL_SID = "sess-actor-heal";
setSessionCredentials(HEAL_SID, { apiKey: KEY, apiUrl: API, explicit: true });

const REAL_ACTOR = "ebe3dd82-e609-456f-9277-72f0986f40ed";
async function actorAfter(status, body) {
  touchSession(HEAL_SID, { actorId: REAL_ACTOR });
  nextReply = { status, body };
  try { await get("/deploy/solutions/s/logs", HEAL_SID); } catch { /* the error is expected */ }
  return getSessionContext(HEAL_SID)?.actorId;
}

// Must NOT unbind — none of these says the actor is unknown.
const ECHO = { error: "validation failed", echo: { code_sample: "if (e.code === 'ACTOR_NOT_FOUND') retry()" } };
check("a 400 that only ECHOES the token keeps the actor", (await actorAfter(400, ECHO)) === REAL_ACTOR);
check("  and its hint does not blame the actor", !/does not recognise the ACTOR/i.test(say(400, ECHO)));
check("Core's 'unknown actor_skills plugin' 400 keeps the actor",
  (await actorAfter(400, { error: "unknown actor_skills plugin: weather" })) === REAL_ACTOR);
check("unquoted prose that happens to contain 'Actor … not found' keeps the actor",
  (await actorAfter(400, { error: "Actor cannot be resolved because the skill test_x was not found" })) === REAL_ACTOR);
check("a nested code field is not a top-level verdict",
  (await actorAfter(400, { ok: false, details: { code: "ACTOR_NOT_FOUND" } })) === REAL_ACTOR);

// MUST unbind — the two shapes that really mean it. Without these the
// narrowing could over-shoot into never healing at all.
check("the Builder's structured 400 ACTOR_NOT_FOUND unbinds",
  (await actorAfter(400, { ok: false, code: "ACTOR_NOT_FOUND", error: 'Core does not recognize actor "dev": Actor "dev" not found' })) === undefined);
check("Core's 401 Actor \"X\" not found unbinds",
  (await actorAfter(401, { ok: false, error: 'Actor "dev" not found' })) === undefined);
check("a genuine invalid-key 401 does NOT unbind",
  (await actorAfter(401, { error: "Invalid or unconfigured API key" })) === REAL_ACTOR);

// ─── The hint says only what the code does ───────────────────────────────────
//
// It ended "call ateam_auth again to reset the session binding" (35e68ab).
// ateam_auth never did: setSessionCredentials carries the session's context,
// actor included, across a sign-in. What drops the binding is request() itself,
// on the same response, with the same classifier — so by the time the caller
// reads this, it is already gone, and the remedy is to retry. (Codex c0e497b0ce)
console.log("the actor-not-found hint prescribes only what actually happens");
{
  touchSession(HEAL_SID, { actorId: REAL_ACTOR });
  nextReply = { status: 401, body: { ok: false, error: `Actor "${REAL_ACTOR}" not found` } };
  let msg = "";
  try { await get("/deploy/solutions/s/logs", HEAL_SID); } catch (e) { msg = e.message; }
  check("the error is classified as the actor", /does not recognise the ACTOR/.test(msg));
  check("it does not send the caller to ateam_auth to reset the binding",
    !/ateam_auth/.test(msg) && !/reset the session binding/i.test(msg));
  check("it says the stale binding was dropped", /has been dropped/.test(msg));
  check("  …and it was: the session no longer carries the actor", getSessionContext(HEAL_SID)?.actorId === undefined);
}

// ─── Only a tool that STARTS a run may bind an actor from its result ─────────
//
// The dispatcher accepted `actor_id` off ANY tool's result, so one unrelated
// payload carrying that field repointed the whole session (every later call
// 401'd with `Actor "dev" not found`). ACTOR_MINTING_TOOLS narrowed it, and
// nothing tested the gate: a future edit dropping `.has(name)` passed green
// (Codex b40deae29d, ateam-mcp #13). These go through handleToolCall, the one
// place the gate lives.
console.log("only run-starting tools bind an actor from a result");
{
  const { handleToolCall } = await import("../src/tools.js");
  const MINT_SID = "sess-actor-mint";
  setSessionCredentials(MINT_SID, { apiKey: KEY, apiUrl: API, explicit: true });
  const INTRUDER = "0b6c1f3e-0000-4000-8000-00000000dead";
  const MINTED = "7f3a2c10-1111-4111-8111-000000000abc";

  nextReply = { status: 200, body: { ok: true, repo_url: "https://github.com/x/y", actor_id: INTRUDER } };
  const read = await handleToolCall("ateam_github_status", { solution_id: "s" }, MINT_SID);
  check("(the non-minting call itself succeeded)", !read.isError);
  check("a non-minting tool's actor_id does NOT bind an unbound session", getSessionContext(MINT_SID)?.actorId === undefined);

  touchSession(MINT_SID, { actorId: REAL_ACTOR });
  await handleToolCall("ateam_github_status", { solution_id: "s" }, MINT_SID);
  check("  …nor displace a real actor already bound", getSessionContext(MINT_SID)?.actorId === REAL_ACTOR);

  nextReply = { status: 200, body: { ok: true, job_id: "job_1", actor_id: MINTED } };
  const run = await handleToolCall("ateam_test_pipeline", { solution_id: "s", skill_id: "k", message: "hi" }, MINT_SID);
  check("(the run-starting call itself succeeded)", !run.isError);
  check("a run-starting tool's actor_id DOES bind — the follow-up reads need it",
    getSessionContext(MINT_SID)?.actorId === MINTED);
}

server.close();

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

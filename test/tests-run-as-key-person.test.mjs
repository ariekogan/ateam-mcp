// WHO A TEST RUNS AS (Builder #103, D7) — every ateam-mcp surface that says it.
//
// Since #103 the Builder runs an agent's test job AS THE PERSON the API key
// belongs to (req.auth.actorId, from Core's verify-agent-key); a caller's
// actor_id only names the thread; every test reply carries ran_as beside
// actor_id; a key with no person runs anonymously as before; a voice test is
// still anonymous until the voice backend verifies the key. The Builder states
// that once (capabilitySpecs.js TEST_RUNS_AS, served on /spec/skill), and
// ateam-mcp renders the same words from one constant (src/testRunsAs.js).
//
// Before this, ateam-mcp said the opposite in six places: "Omit to
// auto-generate a test actor", "Omit for a new conversation", "the same
// actor_id maintains conversation context", "synthetic test actor with no
// channels", "Use the same actor_id you passed to ateam_conversation", and
// ateam_test_voice "Runs the full voice pipeline … end-to-end".
//
// Run: node --test test/tests-run-as-key-person.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_RUNS_AS, RAN_AS_IN_REPLY } from "../src/testRunsAs.js";
import { setSessionCredentials } from "../src/api.js";
import { tools, handleToolCall } from "../src/tools.js";
import { renderAgentDocHeader } from "../src/agentDoc.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const tool = (name) => tools.find((t) => t.name === name);
const actorParam = (name) => tool(name).inputSchema.properties.actor_id.description;

// The statement itself, held to the Builder's words (the same phrases its own
// test/testRunsAsQuoted.test.js pins on TEST_RUNS_AS).
test("TEST_RUNS_AS says what the Builder's /spec says", () => {
  for (const rx of [
    /runs AS THE PERSON that key belongs to/,
    /generated it in Tokens & Keys/,
    /actor_id never picks the identity/,
    /a different actor_id is not honoured/,
    /key no person minted[^.]*runs as before/,
    /ran_as is the actor the job ran as/,
    /ateam_test_voice\) runs as the person only once the voice backend verifies the API key/,
    /Core follow-up/,
    /until then it is anonymous/,
  ]) assert.match(TEST_RUNS_AS, rx);
  assert.ok(TEST_RUNS_AS.includes(RAN_AS_IN_REPLY), "RAN_AS_IN_REPLY must be a part of TEST_RUNS_AS, not a second wording");
});

// Any of these on a surface is the pre-#103 claim.
const STALE = [
  [/auto-generate a test actor/i, "a test runs as a generated test actor"],
  [/synthetic test actor/i, "a test runs as a synthetic actor"],
  [/Omit for a new conversation/i, "omitting actor_id starts a new conversation"],
  [/same actor_id maintains conversation context/i, "actor_id alone keeps the context"],
  [/same actor_id you passed/i, "the job belongs to the actor_id you passed"],
  [/per-user-actor flows/i, "per-user flows, with no word on whose actor"],
  [/full voice pipeline|skill dispatch → response|voice-enabled solutions end-to-end/i, "a voice test runs the whole pipeline"],
];
function assertCurrent(where, text) {
  for (const [rx, claim] of STALE) assert.doesNotMatch(text, rx, `${where} still promises: ${claim}`);
}
function assertStatesIt(where, text) {
  assert.ok(text.includes(TEST_RUNS_AS), `${where} does not state who a test runs as (TEST_RUNS_AS)`);
  assertCurrent(where, text);
}

test("ateam_test_skill: actor_id states it; the description names ran_as", () => {
  assertStatesIt("ateam_test_skill actor_id", actorParam("ateam_test_skill"));
  const d = tool("ateam_test_skill").description;
  assert.ok(d.includes(RAN_AS_IN_REPLY), "ateam_test_skill description does not name ran_as");
  assert.match(d, /inside response\.kickoff/, "where ran_as is on a wait_for:'chain' result");
  assertCurrent("ateam_test_skill description", d);
});

test("ateam_conversation: actor_id states it; multi-turn names the thread and ran_as", () => {
  assertStatesIt("ateam_conversation actor_id", actorParam("ateam_conversation"));
  const d = tool("ateam_conversation").description;
  assert.ok(d.includes(RAN_AS_IN_REPLY), "ateam_conversation description does not name ran_as");
  assert.match(d, /actor_id \(the thread\)/);
  assertCurrent("ateam_conversation description", d);
});

test("ateam_test_voice: no full-pipeline claim; person vs anonymous; ran_as", () => {
  const d = tool("ateam_test_voice").description;
  assertStatesIt("ateam_test_voice description", d);
  assert.match(d, /ran_as repeats its actor_id/, "ateam_test_voice does not say where ran_as comes from");
});

test("ateam_test_notification and ateam_get_execution_logs: no synthetic actor, the job is ran_as's", () => {
  assertCurrent("ateam_test_notification description", tool("ateam_test_notification").description);
  const logs = actorParam("ateam_get_execution_logs");
  assertCurrent("ateam_get_execution_logs actor_id", logs);
  assert.match(logs, /pass the ran_as of the ateam_conversation \/ ateam_test_skill reply/);
});

test("bootstrap: conversation_flow states it; developer_loop points at it", async () => {
  const boot = JSON.parse((await handleToolCall("ateam_bootstrap", {}, "sess-runs-as-boot")).content[0].text);
  const flow = boot.conversation_flow;
  assert.equal(flow.who_it_runs_as, TEST_RUNS_AS);
  assert.match(flow.steps[0], /\{ chain_id, actor_id, ran_as \}/);
  assertCurrent("conversation_flow", JSON.stringify(flow));
  assert.doesNotMatch(flow.steps[3], /same conversation context/, "step 4 still promises context by actor_id alone");
  const step5 = boot.developer_loop.steps.find((s) => s.step === 5).description;
  assert.match(step5, /conversation_flow\.who_it_runs_as/);
});

test("the tenant CLAUDE.md states it", () => {
  const doc = renderAgentDocHeader({ solution: { id: "walkmate", name: "Walkmate" }, skills: [], connectors: [] });
  assertStatesIt("CLAUDE.md pitfalls", doc);
});

// A stand-in Builder: answers a conversation kickoff with ran_as.
const SID = "sess-runs-as";
let server;
before(async () => {
  server = createServer((req, res) => {
    req.resume();   // the body is not read: only the path decides the reply
    req.on("end", () => {
      const path = req.url.split("?")[0];
      let reply = { ok: true };
      if (path.endsWith("/test")) reply = { ok: true, job_id: "job_1", chain_id: "job_1", actor_id: "usr_person", ran_as: "usr_person", status: "running" };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, { apiKey: "adas_tenanta_" + "0".repeat(32), apiUrl: `http://127.0.0.1:${server.address().port}`, explicit: true });
});
after(() => server.close());

test("ateam_conversation's result keeps the Builder's ran_as and names it in _poll", async () => {
  const r = await handleToolCall("ateam_conversation", { solution_id: "walkmate", message: "hi" }, SID);
  assert.ok(!r.isError, r.content[0].text.slice(0, 300));
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.ran_as, "usr_person", "the Builder's ran_as did not reach the caller");
  assert.equal(out._poll.who_it_ran_as, RAN_AS_IN_REPLY, "_poll does not name ran_as");
});

// The scaffolded connector's own missing-actor error (getActorId, which named
// TEST_RUNS_AS) is gone with the raw JSON-RPC scaffold: a defineConnector
// connector refuses a call with no caller in the runtime (MISSING_CALLER).
// test/scaffold-connector.test.mjs runs the new scaffold.

// ONE copy of the fact: its distinctive words appear in no other source file.
test("the statement is written once, in src/testRunsAs.js", () => {
  const phrases = ["runs AS THE PERSON that key belongs to", "is the actor the job ran as"];
  for (const f of readdirSync(SRC).filter((n) => n.endsWith(".js") && n !== "testRunsAs.js")) {
    const text = readFileSync(join(SRC, f), "utf8");
    for (const p of phrases) assert.ok(!text.includes(p), `src/${f} restates "${p}" — render TEST_RUNS_AS instead`);
  }
});

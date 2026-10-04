// WHO A TEST RUNS AS — ateam-mcp does not say. It points.
//
// Since Builder #103 an agent's test job runs AS THE PERSON the API key belongs
// to; the Builder states that once, in /spec/skill
// (agent_guide.key_concepts.testing_and_runtime.conversation_testing.
// key_concepts.actor_id), and ateam_get_spec(topic:"skill", search:"actor_id")
// returns it. ateam-mcp used to carry a hand-pasted copy (src/testRunsAs.js),
// pinned only by its length. A copy cannot follow the page: it kept serving a
// sentence the Builder had corrected (a voice test with a person's key reaches
// the skill) in six tools, bootstrap and the tenant CLAUDE.md. So every surface
// that touches the question carries ONE pointer (TEST_RUNS_AS_AT) and no
// sentence of the answer, and this file fails any source or served text that
// restates it.
//
// Before #103 ateam-mcp said the opposite in six places: "Omit to
// auto-generate a test actor", "Omit for a new conversation", "the same
// actor_id maintains conversation context", "synthetic test actor with no
// channels", "Use the same actor_id you passed to ateam_conversation", and
// ateam_test_voice "Runs the full voice pipeline … end-to-end". STALE keeps
// those out.
//
// Run: node --test test/tests-run-as-key-person.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_RUNS_AS_AT } from "../src/testRunsAs.js";
import * as RunsAsModule from "../src/testRunsAs.js";
import { setSessionCredentials } from "../src/api.js";
import { tools, handleToolCall } from "../src/tools.js";
import { renderAgentDocHeader } from "../src/agentDoc.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const tool = (name) => tools.find((t) => t.name === name);
const actorParam = (name) => tool(name).inputSchema.properties.actor_id.description;

// THE POINTER: where the answer is, and nothing of it. It must name the read an
// agent makes (ateam_get_spec, topic skill, search actor_id) and the place in
// the result.
test("TEST_RUNS_AS_AT is a pointer to the served spec, and testRunsAs.js exports nothing else", () => {
  assert.match(TEST_RUNS_AS_AT, /ateam_get_spec\(\{ topic: "skill", search: "actor_id" \}\)/);
  assert.match(TEST_RUNS_AS_AT, /testing_and_runtime\.conversation_testing\.key_concepts\.actor_id/);
  assert.deepEqual(Object.keys(RunsAsModule), ["TEST_RUNS_AS_AT"], "testRunsAs.js exports more than the pointer: a copy of the Builder's words is back");
  assert.ok(TEST_RUNS_AS_AT.length < 200, `${TEST_RUNS_AS_AT.length} characters: a pointer, not a statement`);
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
function assertPoints(where, text) {
  assert.ok(text.includes(TEST_RUNS_AS_AT), `${where} does not point at who a test runs as`);
  assertCurrent(where, text);
}

test("ateam_test_skill: actor_id points; the description names ran_as and points", () => {
  assertPoints("ateam_test_skill actor_id", actorParam("ateam_test_skill"));
  const d = tool("ateam_test_skill").description;
  assertPoints("ateam_test_skill description", d);
  assert.match(d, /inside response\.kickoff/, "where ran_as is on a wait_for:'chain' result");
});

// It asserted /actor_id \(the thread\)/ — "pass the reply's actor_id (the
// thread) back in to continue that thread" (7d44113). Core drops actor_id from
// an agent key; the key continues the conversation
// (test/conversation-continues.test.mjs).
test("ateam_conversation: actor_id points; multi-turn says the key continues it, and points", () => {
  assertPoints("ateam_conversation actor_id", actorParam("ateam_conversation"));
  const d = tool("ateam_conversation").description;
  assertPoints("ateam_conversation description", d);
  assert.match(d, /your key, not actor_id, continues the conversation/);
});

test("ateam_test_voice: no full-pipeline claim; ran_as; points", () => {
  const d = tool("ateam_test_voice").description;
  assertPoints("ateam_test_voice description", d);
  assert.match(d, /ran_as repeats its actor_id/, "ateam_test_voice does not say where ran_as comes from");
});

test("ateam_test_notification and ateam_get_execution_logs: no synthetic actor, the job is ran_as's", () => {
  assertCurrent("ateam_test_notification description", tool("ateam_test_notification").description);
  const logs = actorParam("ateam_get_execution_logs");
  assertCurrent("ateam_get_execution_logs actor_id", logs);
  assert.match(logs, /pass the ran_as of the ateam_conversation \/ ateam_test_skill reply/);
});

test("bootstrap: conversation_flow points; developer_loop points at it", async () => {
  const boot = JSON.parse((await handleToolCall("ateam_bootstrap", {}, "sess-runs-as-boot")).content[0].text);
  const flow = boot.conversation_flow;
  assert.equal(flow.who_it_runs_as, TEST_RUNS_AS_AT);
  assert.match(flow.steps[0], /\{ chain_id, actor_id, ran_as \}/);
  assertCurrent("conversation_flow", JSON.stringify(flow));
  assert.doesNotMatch(flow.steps[3], /same conversation context/, "step 4 still promises context by actor_id alone");
  const step5 = boot.developer_loop.steps.find((s) => s.step === 5).description;
  assert.match(step5, /conversation_flow\.who_it_runs_as/);
});

test("the tenant CLAUDE.md points", () => {
  const doc = renderAgentDocHeader({ solution: { id: "walkmate", name: "Walkmate" }, skills: [], connectors: [] });
  assertPoints("CLAUDE.md pitfalls", doc);
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
  assert.equal(out._poll.who_it_ran_as, TEST_RUNS_AS_AT, "_poll does not point at what ran_as means");
});

// The scaffolded connector's own missing-actor error (getActorId, which named
// the statement) is gone with the raw JSON-RPC scaffold: a defineConnector
// connector refuses a call with no caller in the runtime (MISSING_CALLER).
// test/scaffold-connector.test.mjs runs the new scaffold.

// NOTHING MAY RESTATE THE ANSWER. These are the Builder's sentences (capabilitySpecs.js
// TEST_RUNS_AS and its voice sentence) in their distinctive words; none may appear
// in any ateam-mcp source file, tool description, parameter text, bootstrap result
// or generated CLAUDE.md. The pointer is the only thing that may. (A phrase here
// is a sentence of the answer, not a field name: "ran_as" itself may be named.)
const RESTATEMENTS = [
  /runs (?:it )?as (?:the|that) person/i,
  /share one conversation/i,
  /actor_id never picks/i,
  /service-provisioned key/i,
  /whose key started the test/i,
  /is the actor the job ran as/i,
  /Core ignores actor_id/i,
  /voice backend verifies/i,
  /generated it in Tokens & Keys/i,
];
function restatementsIn(text) {
  return RESTATEMENTS.filter((rx) => rx.test(text)).map(String);
}

test("no ateam-mcp source file restates who a test runs as — only the pointer", () => {
  for (const f of readdirSync(SRC).filter((n) => n.endsWith(".js"))) {
    const found = restatementsIn(readFileSync(join(SRC, f), "utf8"));
    assert.deepEqual(found, [], `src/${f} restates the Builder's statement of who a test runs as: point at it with TEST_RUNS_AS_AT instead`);
  }
});

test("no served text restates it: tool descriptions, parameters, bootstrap and the tenant CLAUDE.md", async () => {
  const boot = (await handleToolCall("ateam_bootstrap", {}, "sess-runs-as-guard")).content[0].text;
  const doc = renderAgentDocHeader({ solution: { id: "walkmate", name: "Walkmate" }, skills: [], connectors: [] });
  const served = [...tools.map((t) => [t.name, JSON.stringify(t)]), ["ateam_bootstrap", boot], ["CLAUDE.md", doc]];
  for (const [where, text] of served) assert.deepEqual(restatementsIn(text), [], `${where} restates the Builder's statement of who a test runs as`);
});

test("(control) the guard sees the Builder's sentences", () => {
  assert.ok(restatementsIn("a test … runs AS THE PERSON that key belongs to").length > 0);
  assert.ok(restatementsIn("so all anonymous tests in a tenant share one conversation").length > 0);
  assert.ok(restatementsIn("A voice test (ateam_test_voice) runs as the person only once the voice backend verifies the API key").length > 0);
  assert.deepEqual(restatementsIn(TEST_RUNS_AS_AT), [], "the pointer itself trips the guard");
});

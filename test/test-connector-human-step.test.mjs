// A STEP THAT WAITS FOR A PERSON is tested with ateam_conversation, never with
// ateam_test_connector — and the texts an agent reads at that moment say so.
//
// 2026-09-28 (invoice-tracker e2e, job_zare1ton call #23): the build "tested" a
// person's confirmation by calling invoice.confirm_held through
// ateam_test_connector on a seeded held invoice, with an amount nobody
// supplied, then saved that call as a "tested" mock. ateam_test_connector's
// description (179ecf1) said only "Call a tool on a running connector and get
// the result"; ateam_conversation never said that multi-turn is how a person's
// step is tested; and three surfaces said "stop when chain_done === true (or
// pending_question is set …)" with no word on how to answer.
//
// PRE-1 (2026-10-01, live): a test started with a key runs as the key's person
// — ran_as, actor_id and Core's jobs.actorId on turn 1, turn 2 and
// ateam_test_connector. Turn 2 on the same actor_id is a NEW chain that Core
// routes back to the skill that asked (sys.askUser ends the chain).
//
// Run: node --test test/test-connector-human-step.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setSessionCredentials } from "../src/api.js";
// Namespace imports, so this file still RUNS on a tree without the new
// constants and every check reports what it finds there.
import * as toolsModule from "../src/tools.js";
import { renderAgentDocHeader } from "../src/agentDoc.js";
import * as testRunsAs from "../src/testRunsAs.js";

const { tools, handleToolCall } = toolsModule;
const tool = (name) => tools.find((t) => t.name === name);
const description = (name) => tool(name).description;
const waitingText = () => {
  const text = toolsModule.WAITING_ON_THE_USER;
  assert.equal(typeof text, "string", "tools.js exports no WAITING_ON_THE_USER — the one wording of what chain_done + pending_question means");
  return text;
};

test("ateam_test_connector: DIRECTLY, plumbing only, a person's step goes to ateam_conversation", () => {
  const d = description("ateam_test_connector");
  for (const part of [
    "DIRECTLY",
    "no skill, no guardrails, no user turn",
    "It can NOT prove a step that waits for a person",
    "ateam_conversation",
    "human_step_testing",
    "Never call a write tool here on a record your test did not create",
    "NO_INDIVIDUAL_USER",
    "never a reason to change where",
    "storage_decision",
  ]) assert.ok(d.includes(part), `ateam_test_connector description lacks: ${part}`);
});

// The spec key is agent_guide.KEY_CONCEPTS.testing_and_runtime (Builder
// spec.js: testing_and_runtime sits inside key_concepts). A pointer that skips
// key_concepts sends the agent to a key that does not exist.
test("ateam_test_connector points at the key the Builder actually serves", () => {
  assert.match(description("ateam_test_connector"), /ateam_get_spec\('skill'\) → agent_guide\.key_concepts\.testing_and_runtime\.human_step_testing/);
});

test("ateam_test_connector says who the call runs as — what PRE-1 saw, never _system_service", () => {
  const d = description("ateam_test_connector");
  assert.ok(testRunsAs.KEY_PERSON, "testRunsAs.js exports no KEY_PERSON");
  assert.equal(testRunsAs.KEY_PERSON, "the person whose key started the test — the person you are talking to");
  assert.ok(d.includes("This call runs as " + testRunsAs.KEY_PERSON + "."), "ateam_test_connector does not say who it runs as");
  assert.doesNotMatch(d, /_system_service/);
});

test("no tool description names the retired refusal 'unsafe actor segment'", () => {
  const all = tools.map((t) => `${t.name}: ${t.description}\n${JSON.stringify(t.inputSchema)}`).join("\n");
  assert.doesNotMatch(all, /unsafe actor segment/i);
});

test("ateam_conversation: you play the person, with an input you wrote", () => {
  const d = description("ateam_conversation");
  assert.ok(d.includes("This is how to test a step that waits for a person: you play the person, with an input you wrote, so you know the right answer — never invent one for a real record."));
  // After the Multi-turn sentence, not somewhere else.
  assert.ok(d.indexOf("you play the person") > d.indexOf("Multi-turn:"), "the sentence is not in the multi-turn paragraph");
});

test("chain_done + pending_question: one wording, in every place that says when to stop polling", async () => {
  const text = waitingText();
  assert.match(text, /When chain_done is true and pending_question is set, the assistant is waiting on the user/);
  assert.match(text, /Reply with ateam_conversation\(same actor_id, your answer\)/);
  assert.match(text, /new chain on the same thread/);
  assert.ok(description("ateam_conversation").includes(text), "ateam_conversation does not say what a pending_question means");
  assert.ok(description("ateam_chain_status").includes(text), "ateam_chain_status does not say what a pending_question means");
  const boot = JSON.parse((await handleToolCall("ateam_bootstrap", {}, "sess-human-step-boot")).content[0].text);
  assert.ok(boot.conversation_flow.steps[1].includes(text), "bootstrap conversation_flow step 2 does not say it");
  // The old wording read as two different ends of the poll.
  const served = [description("ateam_conversation"), description("ateam_chain_status"), JSON.stringify(boot.conversation_flow)].join("\n");
  assert.doesNotMatch(served, /or pending_question is set|OR when pending_question is set/);
});

test("ran_as names the person you are talking to", () => {
  assert.ok(testRunsAs.RAN_AS_IN_REPLY.includes("ran_as is the actor the job ran as: the person whose key started the test — the person you are talking to"));
  assert.ok(testRunsAs.TEST_RUNS_AS.includes(testRunsAs.RAN_AS_IN_REPLY));
});

test("the tenant CLAUDE.md no longer says ateam_test_connector runs as _system_service", () => {
  const doc = renderAgentDocHeader({ solution: { id: "walkmate", name: "Walkmate" }, skills: [], connectors: [] });
  const line = doc.split("\n").find((l) => l.includes("`ateam_test_connector`"));
  assert.ok(line, "CLAUDE.md has no ateam_test_connector pitfall");
  assert.doesNotMatch(line, /_system_service/);
  assert.ok(line.includes(testRunsAs.KEY_PERSON), "the pitfall does not say who the call runs as");
  assert.match(line, /ateam_conversation/);
});

// A stand-in Builder answering a conversation kickoff.
const SID = "sess-human-step";
let server;
before(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, job_id: "job_1", chain_id: "job_1", actor_id: "usr_person", ran_as: "usr_person", status: "running" }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, { apiKey: "adas_tenanta_" + "0".repeat(32), apiUrl: `http://127.0.0.1:${server.address().port}`, explicit: true });
});
after(() => server.close());

test("ateam_conversation's result says what to do when the assistant asks", async () => {
  const r = await handleToolCall("ateam_conversation", { solution_id: "walkmate", message: "hi" }, SID);
  assert.ok(!r.isError, r.content[0].text.slice(0, 300));
  const out = JSON.parse(r.content[0].text);
  assert.equal(out._poll.waiting_on_the_user, waitingText(), "_poll does not say what a pending_question means");
});

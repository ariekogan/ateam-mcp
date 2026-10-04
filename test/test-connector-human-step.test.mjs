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
import { TEST_RUNS_AS_AT } from "../src/testRunsAs.js";
import * as humanStep from "../src/humanStep.js";

const { tools, handleToolCall } = toolsModule;
const tool = (name) => tools.find((t) => t.name === name);
const description = (name) => tool(name).description;
const waitingText = () => {
  const text = humanStep.WAITING_ON_THE_USER;
  assert.equal(typeof text, "string", "humanStep.js exports no WAITING_ON_THE_USER — the one wording of what chain_done + pending_question means");
  return text;
};
// The Builder's /spec/skill human_step_testing.never, byte for byte (#112) —
// the one wording of what ateam_test_connector must never write.
const NEVER = "Never call a write tool with ateam_test_connector on a record your test did not create.";
// human_step_testing.play_the_person, byte for byte.
const PLAY = "Play the person with an input you wrote, so you know the answer that person would give — never invent one for a real record.";

test("ateam_test_connector: DIRECTLY, plumbing only, a person's step goes to ateam_conversation", () => {
  const d = description("ateam_test_connector");
  for (const part of [
    "DIRECTLY",
    "no skill, no guardrails, no user turn",
    "It can NOT prove a step that waits for a person",
    "ateam_conversation",
    "human_step_testing",
    NEVER,
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

test("ateam_test_connector points at who the call runs as, scopes the master_key case, and never says _system_service", () => {
  const d = description("ateam_test_connector");
  assert.ok(d.includes(TEST_RUNS_AS_AT), "ateam_test_connector does not point at who it runs as");
  // CORE review M41x-L3: a master_key session has no key person (Builder #115
  // passes a master caller's own actor through).
  assert.ok(d.includes("A master_key session has no key person: it runs as the actor it holds, or the platform's service identity when it holds none."), "the master_key case is not scoped");
  assert.doesNotMatch(d, /_system_service/);
});

test("no tool description names the retired refusal 'unsafe actor segment'", () => {
  const all = tools.map((t) => `${t.name}: ${t.description}\n${JSON.stringify(t.inputSchema)}`).join("\n");
  assert.doesNotMatch(all, /unsafe actor segment/i);
});

test("ateam_conversation: a person's step is your next message, and you play the person with an input you wrote", () => {
  const d = description("ateam_conversation");
  const multi = d.slice(d.indexOf("Multi-turn:"));
  assert.ok(multi.includes(waitingText()), "the multi-turn paragraph does not say a person's step is your next message");
  assert.equal(humanStep.PLAY_THE_PERSON, PLAY, "humanStep.js does not hold the Builder's human_step_testing.play_the_person");
  assert.ok(multi.includes(PLAY), "the multi-turn paragraph does not say how to play the person");
  // One copy (CORE review M41r3-L2): no hand-written variant anywhere in the tools.
  const all = tools.map((t) => t.description).join("\n");
  assert.doesNotMatch(all, /You play the person|playing the person with an input you wrote/);
});

// Arie, 2026-10-01: "human step is simply another message." One plain
// sentence — the same words /spec/skill human_step_testing.rule leads with.
// A skill can also ask in its reply text, with no pending_question (CORE
// review B112r3-3), so the sentence names both.
const LEAD = "A step that waits for a person is just your next message: when pending_question is set, or the reply asks the person something, send ateam_conversation(same actor_id, the answer that person would give).";

test("WAITING_ON_THE_USER is one plain sentence, in every place that says when to stop polling", async () => {
  const text = waitingText();
  assert.equal(text, LEAD);
  assert.ok(description("ateam_conversation").includes(text), "ateam_conversation does not say it");
  assert.ok(description("ateam_chain_status").includes(text), "ateam_chain_status does not say it");
  const boot = JSON.parse((await handleToolCall("ateam_bootstrap", {}, "sess-human-step-boot")).content[0].text);
  assert.ok(boot.conversation_flow.steps[1].includes(text), "bootstrap conversation_flow step 2 does not say it");
  // The old wording read as two different ends of the poll.
  const served = [description("ateam_conversation"), description("ateam_chain_status"), JSON.stringify(boot.conversation_flow)].join("\n");
  assert.doesNotMatch(served, /or pending_question is set|OR when pending_question is set/);
});

test("the tenant CLAUDE.md no longer says ateam_test_connector runs as _system_service", () => {
  const doc = renderAgentDocHeader({ solution: { id: "walkmate", name: "Walkmate" }, skills: [], connectors: [] });
  const line = doc.split("\n").find((l) => l.includes("`ateam_test_connector`"));
  assert.ok(line, "CLAUDE.md has no ateam_test_connector pitfall");
  assert.doesNotMatch(line, /_system_service/);
  assert.ok(line.includes(TEST_RUNS_AS_AT), "the pitfall does not point at who the call runs as");
  assert.match(line, /ateam_conversation/);
});

// CORE review M41-4: the rule had three wordings — "a write tool … on a record
// your test did not create" here, "a commit tool … on a real record" on the
// Builder, and a CLAUDE.md paraphrase. One wording now, the Builder's, rendered.
test("what ateam_test_connector must never write: one wording, rendered in the description and CLAUDE.md", () => {
  assert.equal(humanStep.TEST_CONNECTOR_NEVER, NEVER, "humanStep.js does not hold the Builder's human_step_testing.never");
  const d = description("ateam_test_connector");
  const doc = renderAgentDocHeader({ solution: { id: "walkmate", name: "Walkmate" }, skills: [], connectors: [] });
  for (const [where, text] of [["ateam_test_connector description", d], ["CLAUDE.md", doc]]) {
    assert.ok(text.includes(NEVER), `${where} does not render human_step_testing.never`);
    assert.doesNotMatch(text, /Never call a (?:write|commit) tool (?:here )?on a|commit tool \(confirm/, `${where} still has another wording of the rule`);
  }
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

// CORE review M41x-L1/L2: stale statements of the old answer in this repo.
test("no file in the repo still says ateam_test_connector runs as _system_service, or points at the deleted scaffold error", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const wip = readFileSync(join(root, "docs", "WIP", "AGENT_ONBOARDING_DOC_AUTOGEN.md"), "utf8");
  assert.doesNotMatch(wip, /`ateam_test_connector` runs as `_system_service`|stripped to `_system_service`/, "docs/WIP still states the old pitfall");
});

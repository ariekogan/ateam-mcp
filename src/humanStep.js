/**
 * A STEP THAT WAITS FOR A PERSON — the Builder's words, byte for byte.
 *
 * The one home is the Builder's /spec/skill
 * agent_guide.key_concepts.testing_and_runtime.human_step_testing (#112):
 * `rule` and `never` below are its `rule` and `never`, verbatim, as
 * src/testRunsAs.js is the Builder's TEST_RUNS_AS. When the Builder's change,
 * these change with them; test/test-connector-human-step.test.mjs pins the
 * bytes. Their own module so agentDoc.js can render them (agentDoc.js cannot
 * import tools.js — tools.js imports agentDoc.js).
 */

// A QUESTION ENDS THE CHAIN. sys.askUser finishes the job that asks (done,
// still carrying state.pendingQuestion — Core cp.chain_api
// getActiveChainsForActor), so chain_done is true while pending_question is
// set. The answer is a NEW chain on the same actor_id, which Core's continuity
// routing lands on the skill that asked: Core removed /api/job/:id/respond
// (Chain Additions D2), and the web chat answers the same way. PRE-1
// (2026-10-01) watched it live. ateam_conversation, ateam_chain_status and
// bootstrap's conversation_flow each said "stop when chain_done === true (or
// pending_question is set …)", which reads as two different ends of a poll and
// says nothing about how to answer. Arie, 2026-10-01: "human step is simply
// another message" — one plain sentence, human_step_testing.rule.
export const WAITING_ON_THE_USER =
  "A step that waits for a person is just your next message: when pending_question is set, send ateam_conversation(same actor_id, the answer that person would give).";

// What ateam_test_connector must never write — human_step_testing.never.
// ateam_test_connector's description said "on a record your test did not
// create" while the Builder said "a commit tool … on a real record", and the
// tenant CLAUDE.md paraphrased both: three wordings of one rule that disagreed
// on whether a write to a record the test made is allowed (CORE review M41-4,
// 2026-10-01). It is: the test made it; it is the test's to write and delete.
export const TEST_CONNECTOR_NEVER =
  "Never call a write tool with ateam_test_connector on a record your test did not create.";

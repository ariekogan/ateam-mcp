/**
 * WHO A TEST RUNS AS — NOT STATED HERE, only pointed at.
 *
 * The Builder says it once, in /spec/skill (capabilitySpecs.js TEST_RUNS_AS,
 * served at agent_guide.key_concepts.testing_and_runtime.conversation_testing.
 * key_concepts.actor_id), and that page is the only place the answer lives.
 *
 * This file used to hold a hand-pasted copy of those words, pinned only by its
 * length. A copy cannot follow the page: when the Builder corrected a sentence
 * (a voice test with a person's key reaches the skill), the copy kept serving
 * the old one in ateam_test_voice, ateam_test_skill, ateam_conversation,
 * ateam_test_connector, bootstrap and the tenant CLAUDE.md until someone
 * noticed. Every ateam-mcp text that touches the question now carries THIS ONE
 * pointer and no sentence of the answer; test/tests-run-as-key-person.test.mjs
 * fails any source or served text that restates it. Its own module because
 * agentDoc.js cannot import tools.js (tools.js imports agentDoc.js).
 */
export const TEST_RUNS_AS_AT =
  'Who a test runs as: ateam_get_spec({ topic: "skill", search: "actor_id" }) → testing_and_runtime.conversation_testing.key_concepts.actor_id.';

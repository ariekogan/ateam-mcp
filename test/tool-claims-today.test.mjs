// A tool description is a promise an agent acts on. One that promised more than
// the platform does, and one that then promised less, held to what it does today:
//
//   B6-VOICE-TEST-OVERCLAIM   ateam_test_voice said it ran "the full voice
//     pipeline … skill dispatch → response" end-to-end (32dec97). The first fix
//     said the voice layer was ALL a test shows ("cannot show a skill result
//     today"), which is false for a person's key: Core c93563976 (D7, in prod
//     since prod-20261001-001) runs a voice test forwarded with a person's API
//     key AS that person, skill job included. Core still refuses the skill call
//     (C6) for a key with no person (an anonymous run) and for a phone caller
//     (phone::<number>, an actor Core does not know). Verified from the code,
//     not from a live run.
//
//   AM28-R4   ateam_bootstrap's minimal_authoring.read_first told an MCP client
//     "GET /spec/skill" (2a07c08). The reader cannot GET anything; it reads a
//     spec page with ateam_get_spec, and search:"auto_expand" returns just that
//     block (typical_minimal_skill included) from the skill and solution pages.
//
// Run: node --test test/tool-claims-today.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { tools, handleToolCall } from "../src/tools.js";

const tool = (name) => tools.find((t) => t.name === name);
const voice = () => tool("ateam_test_voice").description;

test("ateam_test_voice: no blanket 'no skill result' claim, and no 'full pipeline' claim", () => {
  const d = voice();
  assert.doesNotMatch(d, /full voice pipeline|skill dispatch|end-to-end/i, `still promises a skill run to every caller: ${d}`);
  assert.doesNotMatch(d, /VOICE LAYER only|cannot show a skill result/i, `still denies a skill result to every caller, a person's key included: ${d}`);
});

test("ateam_test_voice: says what a person's key gets, and who is still refused (Core C6)", () => {
  const d = voice();
  assert.match(d, /A person's key runs it as that person, skill job included/);
  assert.match(d, /with no person on the key, or a phone caller, Core refuses the skill call today \(C6\)/);
  assert.match(d, /test it with ateam_conversation/, "does not say where to test the skill when it is refused");
});

test("ateam_test_voice: the scoped claim is in the first 1200 characters an in-app agent reads", () => {
  const seen = voice().slice(0, 1200);
  assert.match(seen, /A person's key runs it as that person, skill job included/, "an in-app agent is cut off before it reads what a person's key gets");
  assert.match(seen, /Core refuses the skill call today \(C6\)/, "an in-app agent is cut off before it reads who is refused");
});

test("ateam_bootstrap: read_first sends an MCP client to ateam_get_spec with search, not to 'GET /spec/…'", async () => {
  const boot = JSON.parse((await handleToolCall("ateam_bootstrap", {}, "sess-claims-today-boot")).content[0].text);
  const rf = boot.minimal_authoring?.read_first;
  assert.equal(typeof rf, "string", "bootstrap has no minimal_authoring.read_first");
  assert.match(rf, /ateam_get_spec\(topic:"skill", search:"auto_expand"\)/);
  assert.match(rf, /ateam_get_spec\(topic:"solution", search:"auto_expand"\)/);
  assert.match(rf, /typical_minimal_skill/);
  assert.doesNotMatch(rf, /\bGET\b/, `still tells an MCP client to GET: ${rf}`);
});

test("no tool description and no bootstrap text tells an MCP client to 'GET /spec/…'", async () => {
  const boot = (await handleToolCall("ateam_bootstrap", {}, "sess-claims-today-boot")).content[0].text;
  const texts = [...tools.map((t) => [t.name, JSON.stringify(t)]), ["ateam_bootstrap", boot]];
  const bad = texts.filter(([, t]) => /\bGET \/spec/.test(t)).map(([n]) => n);
  assert.deepEqual(bad, [], "an MCP client cannot GET: it calls ateam_get_spec(topic, search)");
});

// A tool description is a promise an agent acts on. One that promised more than
// the platform does, held to what it does today:
//
//   B6-VOICE-TEST-OVERCLAIM   ateam_test_voice said it ran "the full voice
//     pipeline … skill dispatch → response" end-to-end (32dec97). Every test
//     session's first skill call is refused by Core (C6), so a voice-layer pass
//     read as a skill pass. It now says what the Builder's /spec/voice says
//     (capabilitySpecs.js VOICE_TEST_REACH).
//
// Run: node --test test/tool-claims-today.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { tools } from "../src/tools.js";

const tool = (name) => tools.find((t) => t.name === name);

test("ateam_test_voice: the voice layer only, and it says where a skill result comes from", () => {
  const d = tool("ateam_test_voice").description;
  assert.doesNotMatch(d, /full voice pipeline|skill dispatch|end-to-end/i, `still promises a skill run: ${d}`);
  assert.match(d, /VOICE LAYER only/);
  assert.match(d, /cannot show a skill result today/i);
  assert.match(d, /ateam_conversation or ateam_test_skill/, "does not say where to test the skill itself");
});

test("ateam_test_voice: the claim is in the first 1200 characters an in-app agent reads", () => {
  const seen = tool("ateam_test_voice").description.slice(0, 1200);
  assert.match(seen, /cannot show a skill result today/i, "an in-app agent is cut off before it reads that a voice test shows no skill result");
});

// A tool description is a promise an agent acts on. Three that promised more
// than the platform does, each held to what it does today:
//
//   B6-VOICE-TEST-OVERCLAIM   ateam_test_voice said it ran "the full voice
//     pipeline … skill dispatch → response" end-to-end (32dec97). Every test
//     session's first skill call is refused by Core (C6), so a voice-layer pass
//     read as a skill pass. It now says what the Builder's /spec/voice says
//     (capabilitySpecs.js VOICE_TEST_REACH).
//   M-ACTORSTORE-DEV-PREVIEW  ateam_get_spec labelled 'actor-storage' dev-preview
//     (023b74a). Builder #63 relabels /spec/actor-storage "(production)"; two
//     labels for one topic is two answers.
//   ateam_design_advisor      runs the tenant's LLM, and Builder #81 refuses it
//     without a verified key (401 SIGN_IN_REQUIRED). It sat outside TENANT_TOOLS,
//     so a key-less session was sent to the Builder instead of being told to
//     sign in (and got no auth_gate mark for a proxy to replay on).
//
// Run: node --test test/tool-claims-today.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { tools, handleToolCall } from "../src/tools.js";

const tool = (name) => tools.find((t) => t.name === name);

test("ateam_test_voice: the voice layer only, and it says where a skill result comes from", () => {
  const d = tool("ateam_test_voice").description;
  assert.doesNotMatch(d, /full voice pipeline|skill dispatch|end-to-end/i, `still promises a skill run: ${d}`);
  assert.match(d, /VOICE LAYER only/);
  assert.match(d, /cannot show a skill result today/i);
  assert.match(d, /ateam_conversation or ateam_test_skill/, "does not say where to test the skill itself");
});

test("ateam_get_spec labels actor-storage as the Builder does (#63: production)", () => {
  const d = tool("ateam_get_spec").inputSchema.properties.topic.description;
  assert.match(d, /'actor-storage' = per-actor storage \(production\)/);
  assert.doesNotMatch(d, /dev-preview/);
});

test("ateam_design_advisor says it needs sign-in, and a key-less session is refused here, before any call", async () => {
  assert.match(tool("ateam_design_advisor").description, /REQUIRES SIGN-IN \(ateam_auth\)/);
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ ok: true, advice: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const r = await handleToolCall("ateam_design_advisor", { goal: "a meal coach" }, "sess-advisor-no-key");
    assert.equal(r.isError, true, "a key-less session got an answer");
    assert.equal(r.structuredContent?.stage, "auth_gate", `not refused at the gate: ${JSON.stringify(r.structuredContent)}`);
    assert.deepEqual(calls, [], "the advisor was called for a session with no key");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// EVERY CORE TOOL'S DESCRIPTION REACHES AN IN-APP AGENT WHOLE: at most 1200
// characters. Core cuts every tool description there for an agent run
// (ai-dev-assistant anthropicAgentBackend.js, openaiAgentBackend.js,
// sys.callAiWithTools.js), and the in-app builder makes every ateam_* call
// inside one, so whatever a text says past character 1200 never reaches it.
//
// Until this file, the cut was checked one tool at a time, in the test of
// whichever text a change had just shortened; every other text could grow past
// it unseen. This checks every tool the server lists (coreTools).
//
// OVER_THE_CUT names the texts that were already past it when this test was
// written. They are owed a shortening pass of their own; the list can only
// shrink: a listed text that fits must leave it, and no text may join it.
//
// Run: node --test test/core-description-cut.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { coreTools } from "../src/tools.js";

const CORE_DESCRIPTION_CUT = 1200;

const OVER_THE_CUT = new Set([
  "ateam_auth",
  "ateam_build_and_run",
  "ateam_test_skill",
  "ateam_test_notification",
  "ateam_test_voice",
  "ateam_patch",
  "ateam_delete_solution",
  "ateam_log_progress",
  "ateam_create_plugin",
  "ateam_upload_connector",
  "ateam_github_patch",
]);

const length = (t) => String(t.description || "").length;

test("every core tool's description fits in Core's 1200-character cut (the listed debt aside)", () => {
  const over = coreTools
    .filter((t) => !OVER_THE_CUT.has(t.name) && length(t) > CORE_DESCRIPTION_CUT)
    .map((t) => `${t.name}: ${length(t)} characters; an in-app agent sees only the first ${CORE_DESCRIPTION_CUT}`);
  assert.deepEqual(over, []);
});

test("the debt list only shrinks: each listed tool exists, and is still over the cut", () => {
  const byName = new Map(coreTools.map((t) => [t.name, t]));
  const stale = [...OVER_THE_CUT].filter((name) => !byName.has(name) || length(byName.get(name)) <= CORE_DESCRIPTION_CUT);
  assert.deepEqual(stale, [], "these fit now (or are gone): take them off OVER_THE_CUT");
});

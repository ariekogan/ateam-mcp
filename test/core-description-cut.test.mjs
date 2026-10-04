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
// written, each with its length then. They are owed a shortening pass of
// their own. The debt can only shrink: a listed text may not grow past the
// length pinned here (lower the pin when you shorten one), a listed text that
// fits must leave the list, and no text may join it.
//
// Run: node --test test/core-description-cut.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { coreTools } from "../src/tools.js";

const CORE_DESCRIPTION_CUT = 1200;

const OVER_THE_CUT = new Map([
  ["ateam_auth", 1385],
  ["ateam_build_and_run", 2469],
  ["ateam_test_skill", 1223],
  ["ateam_test_notification", 1331],
  ["ateam_test_voice", 1780],
  ["ateam_patch", 2993],
  ["ateam_delete_solution", 1246],
  ["ateam_log_progress", 1295],
  ["ateam_create_plugin", 2017],
  ["ateam_upload_connector", 1660],
  ["ateam_github_patch", 2568],
]);

const length = (t) => String(t.description || "").length;

test("every core tool's description fits in Core's 1200-character cut (the listed debt aside)", () => {
  const over = coreTools
    .filter((t) => !OVER_THE_CUT.has(t.name) && length(t) > CORE_DESCRIPTION_CUT)
    .map((t) => `${t.name}: ${length(t)} characters; an in-app agent sees only the first ${CORE_DESCRIPTION_CUT}`);
  assert.deepEqual(over, []);
});

test("the debt only shrinks: no listed text grows past its pinned length", () => {
  const byName = new Map(coreTools.map((t) => [t.name, t]));
  const grew = [...OVER_THE_CUT]
    .filter(([name, pinned]) => byName.has(name) && length(byName.get(name)) > pinned)
    .map(([name, pinned]) => `${name}: ${length(byName.get(name))} characters, pinned at ${pinned}`);
  assert.deepEqual(grew, [], "a text already past Core's cut grew: shorten it back");
});

test("the debt list only shrinks: each listed tool exists, and is still over the cut", () => {
  const byName = new Map(coreTools.map((t) => [t.name, t]));
  const stale = [...OVER_THE_CUT.keys()].filter((name) => !byName.has(name) || length(byName.get(name)) <= CORE_DESCRIPTION_CUT);
  assert.deepEqual(stale, [], "these fit now (or are gone): take them off OVER_THE_CUT");
});

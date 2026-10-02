// WHAT ateam_github_push WRITES IS THE BUILDER'S TO SAY, ONCE.
//
// The description said "Commits the full bundle (solution + skills + connector
// source) atomically" (c98addc, 2026-03-10). Builder #144 (BL-21) made the push
// write only what it changes: on a branch that holds the solution, every file
// it reads stays as the branch holds it. The Builder states that once, in
// /spec also_available["POST /deploy/solutions/:solutionId/github/push"]; this
// description points there instead of keeping a second copy that drifts.
//
// Run: node --test test/github-push-points-at-spec.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { tools } from "../src/tools.js";

const CORE_DESCRIPTION_CUT = 1200;
// The Builder's pointer to its one statement (pushFactOneHome.test.js there).
const PUSH_WRITES_AT = 'ateam_get_spec({ topic: "overview", search: "github/push" })';
const description = () => tools.find((t) => t.name === "ateam_github_push").description;

test("the description points at the Builder's statement of what the push writes", () => {
  assert.ok(description().includes(PUSH_WRITES_AT), description());
});

test("…and keeps no copy of it: no promise of a full bundle, nothing it would push over", () => {
  assert.doesNotMatch(description(), /full bundle|atomically|snapshot|Auto-creates/i, description());
});

test("'overview' is a topic ateam_get_spec takes, and the whole text reaches an in-app agent", () => {
  assert.ok(tools.find((t) => t.name === "ateam_get_spec").inputSchema.properties.topic.enum.includes("overview"));
  assert.ok(description().length <= CORE_DESCRIPTION_CUT, `${description().length} characters`);
});

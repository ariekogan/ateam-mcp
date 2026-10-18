// The outside agent is told, in bootstrap and in the CLAUDE.md it writes, what
// cards are and that it has no card tools; the full text is the Builder's
// /spec/solution -> change_cards (a pointer, no copy of the rules).
// Run: node --test test/changes-as-cards.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { handlers } from "../src/tools.js";
import { BRANCH_WORKFLOW } from "../src/branchWorkflow.js";
import { renderAgentDocHeader } from "../src/agentDoc.js";

test("the cards line points at the spec and says there are no card tools", () => {
  assert.match(BRANCH_WORKFLOW.changes_as_cards, /search: "change_cards"/);
  assert.match(BRANCH_WORKFLOW.changes_as_cards, /no card tools/);
});

test("bootstrap carries it", async () => {
  const boot = await handlers.ateam_bootstrap({}, "cards-boot-test");
  assert.ok(JSON.stringify(boot).includes(BRANCH_WORKFLOW.changes_as_cards.slice(0, 60)));
});

test("the CLAUDE.md header carries it", () => {
  const doc = renderAgentDocHeader({ solution: { id: "s", name: "S" }, skills: [], connectors: [] });
  assert.ok(doc.includes("### Changes as cards"));
  assert.ok(doc.includes(BRANCH_WORKFLOW.changes_as_cards));
});

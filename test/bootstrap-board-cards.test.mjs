// CHANGES CAN ALSO BE CARDS. A workspace may keep changes to its solution as
// cards on the Dev Studio board (Core: platform connector dev-studio-mcp, platform
// skills dev-desk and solution-builder). An outside agent must know what a card
// is when the user names one ("do #7"), that a card run is the in-app Builder
// working on `dev` and never shipping, and that ateam-mcp itself has no card
// tool. The text has ONE owner, BRANCH_WORKFLOW.board_cards, rendered into
// ateam_bootstrap's `branching`.
//
// Run: node --test test/bootstrap-board-cards.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { BRANCH_WORKFLOW as W } from "../src/branchWorkflow.js";
import { handlers, tools } from "../src/tools.js";

const boot = await handlers.ateam_bootstrap({}, "board-cards");

test("bootstrap's branching carries the owner's card text, unchanged", () => {
  assert.equal(typeof W.board_cards, "string");
  assert.equal(boot.branching.changes_as_cards, W.board_cards);
});

test("the text states the board, the tag, the card kinds and who may act", () => {
  for (const must of [
    /Dev Studio board/,
    /To do, Doing, Needs you, Review, Stuck, Done/,
    /at most 2 cards in Doing/,
    /#7/,
    /kind "solution" is run by the in-app Builder/,
    /builds on `dev`/,
    /never ships to production/,
    /linked GitHub repository/,
    /kind "repos"/,
    /Only an owner or admin starts a card/,
    /approving one is the owner's own click on the board/,
  ]) assert.match(W.board_cards, must);
});

test("'ateam-mcp has no card tools' stays true: no listed tool works the board", () => {
  assert.match(W.board_cards, /ateam-mcp has no card tools/);
  const boardTools = tools.map((t) => t.name).filter((n) => /card|board/i.test(n));
  assert.deepEqual(boardTools, [], "a card tool was added: change BRANCH_WORKFLOW.board_cards with it");
});

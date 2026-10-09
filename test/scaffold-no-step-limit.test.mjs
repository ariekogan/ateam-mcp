// A skill scaffolded by ateam_patch gets Core's one default step limit, not a
// hard-coded 10 (and no on_max_iterations, which Core never reads). The
// scaffold is an inline literal, so read it from the source.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../src/tools.js", import.meta.url), "utf8");
const scaffold = src.slice(src.indexOf('phase: "PROBLEM_DISCOVERY"'), src.indexOf('phases.push({ phase: "read", status: "created_scaffold"'));

test("the new-skill scaffold is found", () => {
  assert.ok(scaffold.length > 100 && scaffold.includes("engine:"));
});

test("the new-skill scaffold writes no step limit and no on_max_iterations", () => {
  assert.doesNotMatch(scaffold, /max_iterations/);
});

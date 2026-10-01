// BUILDER-2 — what ateam_design_advisor's description says when the advisor
// fails, and when the goal already chose a store.
//
// job_wfkgyg5o (2026-09-28) called the advisor with "Use an in-memory / JSON
// store in a custom MCP connector". The call failed with Core's "circuit open
// for ateam-mcp-test::ateam-proxy-mcp; cooling down" — raised by Core's
// per-(tenant, connector) breaker, so it never reached ateam-mcp or the
// Builder — and the build wrote that store. In that case the tool description
// is the only text the agent has, so it must say: a failed call leaves the
// design unchecked; storage is answered without the LLM; and the field that
// carries a conflict. The circuit-open error names no cool-down time, so the
// text must not promise one.
//
// Run: node --test test/advisor-failure-text.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { tools } from "../src/tools.js";

const desc = tools.find((t) => t.name === "ateam_design_advisor")?.description || "";

test("a failed advisor call leaves the design unchecked — and says so", () => {
  assert.match(desc, /If this call fails, your design is unchecked: do not write storage code on a store you picked before asking\./);
});

test("storage is answered with no LLM, at the one storage decision", () => {
  assert.ok(desc.includes("ateam_get_spec('connector-multi-user') → storage_decision answers storage with no LLM"), desc);
  assert.ok(desc.includes("`storage_decision`"), "the failure reply's field is not named");
});

test("a store the goal already chose comes back as conflicts_with_platform_rules", () => {
  assert.ok(desc.includes("`conflicts_with_platform_rules`"), desc);
});

test("it does not promise a cool-down time the error never names", () => {
  assert.match(desc, /names no time/);
  assert.doesNotMatch(desc, /cool-down the error names/);
});

test("the topic it points at is one ateam_get_spec accepts", () => {
  const topics = tools.find((t) => t.name === "ateam_get_spec")?.inputSchema?.properties?.topic?.enum || [];
  assert.ok(topics.includes("connector-multi-user"));
});

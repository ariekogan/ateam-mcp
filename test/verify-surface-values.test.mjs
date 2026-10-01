// BUILDER-9 (P5): ateam_verify_surface's public schema declared expect.tools
// only (242048d), while Core's ui.surfaceProbe has taken expect.values since
// 2984d2a60 — a value that must be on screen AND gone when the data path is cut,
// the one check that tells a number read from the data from one baked into the
// page. The Builder's widget rules (MEANING_FIELDS_RULE PROVE IT) tell agents to
// use it; an agent reading this schema could not know it exists.
//
// Run: node --test test/verify-surface-values.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { tools } from "../src/tools.js";

const expectSchema = () => tools.find((t) => t.name === "ateam_verify_surface")?.inputSchema?.properties?.expect;

test("ateam_verify_surface expect declares values: string[] beside tools", () => {
  const props = expectSchema()?.properties || {};
  assert.ok(props.values, "expect.properties.values is missing from the public schema");
  assert.deepEqual(props.values, { type: "array", items: { type: "string" } });
  assert.deepEqual(props.tools, { type: "array", items: { type: "string" } });
});

test("the description says what values proves, in Core's terms", () => {
  const d = expectSchema()?.description || "";
  assert.match(d, /\{ values: \[/);
  assert.match(d, /must appear in visible_text AND must DISAPPEAR when the data path is disabled/);
  assert.match(d, /hardcoded in the plugin, so the probe fails it/);
});

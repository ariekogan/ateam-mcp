// WHERE a plugin's data rules — and when a test that wrote records is done —
// are read whole, as ateam_verify_surface and ateam_get_spec tell it.
//
// The Builder's rules live in /spec/widgets sections.data_fidelity
// (MEANING_FIELDS_RULE, which ends with TEST_ROW_DONE_RULE, and
// ACTIONABLE_STATE_RULE; uiPluginRules.js). That page is larger than one
// ateam_get_spec response (MAX_RESPONSE_CHARS, 50,000; 53,368 pretty-printed on
// production, 2026-10-02), so a plain read stubs `sections`. The Builder's one
// pointer, DATA_FIDELITY_AT, is the search form, which returns the branch whole.
//   - verify_surface's expect said "Use a value from a record you created"
//     (a1fd01f) and stopped: nothing said the record must then go.
//   - 'widgets' (2fc571c) and 'ui-plugins' (d7b92aa) never named the search form,
//     and 'ui-plugins' called itself "the DEEP React Native (mobile) plugin build
//     guide", though the page covers iframe, react-native and adaptive.
//
// Run: node --test test/data-fidelity-pointers.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { tools } from "../src/tools.js";

const CORE_DESCRIPTION_CUT = 1200;
// The Builder's DATA_FIDELITY_AT (uiPluginRules.js), up to its HTTP aside.
const READ_WHOLE = 'ateam_get_spec({ topic: "widgets", search: "data_fidelity" })';
const tool = (name) => tools.find((t) => t.name === name);
const topics = () => tool("ateam_get_spec").inputSchema.properties.topic.description;
const line = (name, next) => topics().slice(topics().indexOf(`'${name}' =`), topics().indexOf(`'${next}' =`));

test("verify_surface expect: after proving a value, delete the record by its id through the solution's own delete", () => {
  const e = tool("ateam_verify_surface").inputSchema.properties.expect.description;
  assert.ok(e.includes("Then finish: delete that record by its id through the solution's own delete."), e);
  // A pointer, not a copy: the rule's name and where it is read whole.
  assert.ok(e.endsWith(`The whole rule, TEST_ROW_DONE_RULE: ${READ_WHOLE}.`), e);
  assert.doesNotMatch(e, /DONE means BOTH|reversing|soft delete/, "a copy of TEST_ROW_DONE_RULE, not a pointer");
  // What it proves is unchanged (test/verify-surface-values.test.mjs).
  assert.match(e, /must appear in visible_text AND must DISAPPEAR when the data path is disabled/);
});

test("'widgets' names the read that returns data_fidelity whole, and why a plain read is not it", () => {
  const w = line("widgets", "ui-plugins");
  assert.ok(w.includes("sections.data_fidelity: what a plugin that shows data must render, and when a test that wrote records is done."), w);
  assert.ok(w.includes(`A plain read can arrive with that section stubbed (one response holds 50,000 characters), so read it whole with ${READ_WHOLE}.`), w);
});

test("'ui-plugins' is the build guide for every render mode, and points at the same read", () => {
  const u = line("ui-plugins", "device-capabilities");
  assert.doesNotMatch(u, /DEEP React Native \(mobile\) plugin build guide|any MOBILE widget/);
  assert.ok(u.includes("'ui-plugins' = the UI plugin BUILD guide for every render mode: iframe (HTML under ui-dist/, rendered by the web and by the phone's WebView), react-native (phone only) and adaptive (both)"), u);
  // The RN build facts it carried stay.
  assert.ok(u.includes("compile with a build:rn esbuild script (format=cjs, target=es2015, external react/react-native/@adas/plugin-sdk) to rn-bundle/index.bundle.js"), u);
  assert.ok(u.includes(`What a plugin that shows data must render is read whole with ${READ_WHOLE}`), u);
  // The topic list is a parameter, not cut by Core; the tool's own text is.
  assert.ok(tool("ateam_get_spec").description.length <= CORE_DESCRIPTION_CUT);
});

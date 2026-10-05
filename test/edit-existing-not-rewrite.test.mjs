// An existing connector file is edited by search/replace, never rewritten whole.
//
// On 2026-10-05 one in-app builder step took 948s; 563s were two model turns
// each streaming one huge file (~22,000 tokens). ateam_github_write called
// itself "the PRIMARY way to write connector code" and "replace existing
// ones", so agents (outside ones and the in-app builder, which gets this text
// through a pass-through) resent whole files for small changes.
//
// Run: node test/edit-existing-not-rewrite.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { handlers, tools } from "../src/tools.js";

const desc = (n) => tools.find((t) => t.name === n).description;

test("ateam_github_write is for NEW files and no longer 'the primary way' or 'replace existing'", () => {
  const d = desc("ateam_github_write");
  assert.doesNotMatch(d, /PRIMARY way/);
  assert.doesNotMatch(d, /replace existing ones/);
  assert.match(d, /NEW file/);
  assert.match(d, /ALREADY EXISTS is changed with ateam_github_patch search\/replace/);
});

test("ateam_github_patch says to always use search/replace for an existing file", () => {
  assert.match(desc("ateam_github_patch"), /Always use search\/replace/);
});

test("the developer-loop text agrees: write = NEW, patch = existing", async () => {
  const out = JSON.stringify(await handlers.ateam_bootstrap({}, "t"));
  assert.match(out, /Write NEW connector files/);
  assert.match(out, /Edit EXISTING files with search\/replace, always/);
});

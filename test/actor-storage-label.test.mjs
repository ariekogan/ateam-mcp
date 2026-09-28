// M-ACTORSTORE-DEV-PREVIEW: ateam_get_spec labelled 'actor-storage' dev-preview
// (023b74a). Builder #63 relabels /spec/actor-storage "(production)"; two labels
// for one topic is two answers. This ships WITH Builder #63, never before it.
//
// Run: node --test test/actor-storage-label.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { tools } from "../src/tools.js";

test("ateam_get_spec labels actor-storage as the Builder does (#63: production)", () => {
  const d = tools.find((t) => t.name === "ateam_get_spec").inputSchema.properties.topic.description;
  assert.match(d, /'actor-storage' = per-actor storage \(production\)/);
  assert.doesNotMatch(d, /dev-preview/);
});

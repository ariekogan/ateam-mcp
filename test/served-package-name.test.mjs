// The SDK package is @ateam-ai/sdk. ateam_get_spec's topic list told agents the
// 'sdk' topic is "the @ateam/sdk runtime API reference" (023b74a, since
// reworded in place): a name no registry has, which an agent copies into an
// import or an `npm install` and gets a 404 for (BL-44).
//
// Everything this server serves is text in src/, so the wrong scope is pinned
// out of all of it, and the one place that names the package is pinned to the
// right name.
//
// Run: node --test test/served-package-name.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { coreTools } from "../src/tools.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

test("no text this server serves names a package under the scope @ateam/ (the scope is @ateam-ai/)", () => {
  const wrong = [];
  for (const f of readdirSync(SRC).filter((n) => n.endsWith(".js") && !n.endsWith(".test.js"))) {
    readFileSync(SRC + f, "utf8").split("\n").forEach((line, i) => {
      const hit = /@ateam\/[\w-]+/.exec(line);
      if (hit) wrong.push(`src/${f}:${i + 1}: ${hit[0]}`);
    });
  }
  assert.deepEqual(wrong, [], "the npm scope is @ateam-ai/, not @ateam/");
});

test("ateam_get_spec describes the 'sdk' topic as the @ateam-ai/sdk runtime API reference", () => {
  const spec = coreTools.find((t) => t.name === "ateam_get_spec");
  const topic = spec.inputSchema.properties.topic.description;
  assert.match(topic, /'sdk' = the @ateam-ai\/sdk runtime API reference/);
});

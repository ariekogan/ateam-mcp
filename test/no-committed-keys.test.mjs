/**
 * NO MINTED KEY IN THE SOURCE.
 *
 * This repository is public, and its tests are part of it. 47dea01 put a sealed
 * API key that Core had really minted on mac1 dev into test/key-environment
 * .test.mjs, verbatim, "so these tests pin the ACTUAL format". It was a working
 * credential for as long as Core honours it, in the clear, for anyone.
 *
 * A SEALED key (`adas_<env>_<blob>`) is the form this can happen with silently:
 * only Core's sealing secret produces one, so a sealed literal in the source is
 * a real key by construction, and nobody can tell it from a live one by eye.
 * A test that needs one BUILDS it from synthetic bytes at runtime, which also
 * keeps it out of this scan (see key-environment.test.mjs).
 *
 * What counts as a sealed key is parseApiKey's answer (src/api.js), the one
 * owner of the key format, not a second pattern kept here to drift from it.
 *
 * A finding names the file and line, NEVER the value: this test must not be
 * the thing that prints the key.
 *
 * Run: node --test test/no-committed-keys.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseApiKey } from "../src/api.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCANNED = ["src", "test"];

/** file:line of every sealed-key literal in `text`. Never the value. */
function sealedLiteralLines(text) {
  const lines = [];
  for (const m of text.matchAll(/adas_[A-Za-z0-9_-]+/g)) {
    if (parseApiKey(m[0]).sealed) lines.push(text.slice(0, m.index).split("\n").length);
  }
  return lines;
}

function sourceFiles() {
  const out = [];
  for (const dir of SCANNED) {
    for (const entry of readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && /\.(m?js|cjs|json)$/.test(entry.name)) {
        out.push(join(entry.parentPath ?? entry.path, entry.name));
      }
    }
  }
  return out;
}

test("(control) the scan finds a sealed literal, and reports only where", () => {
  // Built here at runtime, so this file holds no literal of its own.
  const blob = Buffer.alloc(47, 0xfb).toString("base64url");
  const text = `const a = 1;\nconst k = "adas_dev_${blob}";\n`;
  assert.deepEqual(sealedLiteralLines(text), [2]);
});

test("(control) the scan covers the suite this rule is about", () => {
  const files = sourceFiles().map((f) => f.slice(ROOT.length + 1));
  assert.ok(files.includes(join("test", "key-environment.test.mjs")), "key-environment.test.mjs was not scanned");
  assert.ok(files.includes(join("src", "api.js")), "src/api.js was not scanned");
});

test("no sealed API key is committed in src/ or test/", () => {
  const found = [];
  for (const file of sourceFiles()) {
    for (const line of sealedLiteralLines(readFileSync(file, "utf8"))) {
      found.push(`${file.slice(ROOT.length + 1)}:${line}`);
    }
  }
  assert.deepEqual(found, [],
    `a sealed API key literal is committed at ${found.join(", ")} — a real, minted credential in a public repo. ` +
    `Build test keys from synthetic bytes at runtime (key-environment.test.mjs), and have Core revoke the committed one.`);
});

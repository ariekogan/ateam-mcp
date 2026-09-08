// ateam_get_examples — the type enum and the path map must be the SAME SET.
//
// Same defect class as spec-topics.test.mjs, and it had already happened twice
// by the time anyone looked:
//
//   ui-plugin-iframe  — served by the Builder for months, absent from BOTH the
//                       enum and the map here, so no agent could ever fetch it
//   device-tools      — the worked pattern for runtime:"device", added to the
//                       Builder on 2026-09-07 and unreachable through this tool
//
// The second one is why this file exists. A clean-room rebuild of the reference
// solution failed because the platform said "copy the pattern" three times and
// never contained the pattern. The Builder half of that repair is worthless if
// the MCP surface an external agent actually calls does not expose it — which is
// exactly the state it shipped in.
//
// The two lists are edited separately, so they drift separately:
//
//   in the map, not the enum → the schema rejects a type the tool can serve,
//     and the agent is told it does not exist
//   in the enum, not the map → the call is accepted and then resolves to
//     undefined, fetching something else and looking like a valid answer
//
// Run: node test/example-types.test.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "tools.js"), "utf8");

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
    failures++;
  }
}

// ── The two lists, read out of the source ───────────────────────────────────
const mapBody = SRC.slice(SRC.indexOf("const EXAMPLE_PATHS = {"));
const mapKeys = [...mapBody.slice(0, mapBody.indexOf("\n};")).matchAll(/^\s{2}"?([\w-]+)"?:\s*"/gm)].map((m) => m[1]);

// Anchored on a VALUE, not a line number, so re-ordering the schema does not
// silently make this test pass by finding nothing.
const enumLine = SRC.split("\n").find((l) => l.includes("enum:") && l.includes('"script-cache-skill"'));
const enumValues = enumLine ? [...enumLine.matchAll(/"([\w-]+)"/g)].map((m) => m[1]) : [];

console.log("ateam_get_examples — enum ↔ path map");

check("the enum was found in the source", enumValues.length > 0,
  "anchor value 'script-cache-skill' is gone from the enum line — re-anchor this test");
check("the path map was found in the source", mapKeys.length > 0);

const missingFromEnum = mapKeys.filter((k) => !enumValues.includes(k));
const missingFromMap = enumValues.filter((v) => !mapKeys.includes(v));

check("every mapped type is accepted by the schema", missingFromEnum.length === 0,
  missingFromEnum.length ? `servable but rejected: ${missingFromEnum.join(", ")}` : "");
check("every accepted type resolves to a path", missingFromMap.length === 0,
  missingFromMap.length ? `accepted but unresolvable: ${missingFromMap.join(", ")}` : "");

// ── The two that were actually missing ──────────────────────────────────────
// Named explicitly, not just covered by set equality: someone deleting them
// would keep the sets equal and quietly reopen the exact gap this file records.
for (const t of ["device-tools", "ui-plugin-iframe"]) {
  check(`"${t}" is reachable through the tool`, enumValues.includes(t) && mapKeys.includes(t));
}

check('"device-tools" points at the Builder route that serves it',
  mapBody.includes('"device-tools": "/spec/examples/device-tools"'));

// ── An unknown type must SAY so, not fetch something else ───────────────────
// It used to reach get(undefined), which resolves to the API root — so a typo
// answered with a plausible-looking payload instead of an error.
check("an unknown type fails by name rather than fetching undefined",
  /Unknown example type/.test(SRC) && /Object\.keys\(EXAMPLE_PATHS\)/.test(SRC),
  "the handler no longer guards EXAMPLE_PATHS[type]");

// ── The description has to mention what an agent would search for ───────────
// An entry nobody can find is worth the same as an entry that is not there.
check('the schema description mentions device-tools', /device-tools/.test(SRC.slice(SRC.indexOf("Example type:"), SRC.indexOf("Example type:") + 3000)));

console.log(failures === 0 ? "\nPASS" : `\nFAIL — ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);

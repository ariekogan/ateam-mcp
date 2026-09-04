// ateam_get_spec — the topic enum and the path map must be the SAME SET.
//
// There are two hand-maintained lists of the spec topics this tool accepts:
// the `enum` in the inputSchema, and the SPEC_PATHS map the handler resolves
// against. They are edited separately, so they drift separately, and each way
// of drifting fails differently and badly:
//
//   in the map, not the enum → the schema rejects a topic the tool can serve,
//     and the agent is told the topic does not exist
//   in the enum, not the map → the call is accepted and then 500s, or worse,
//     resolves to undefined and fetches something else
//
// This already happened once (OPEN-19): ateam_design_advisor pointed at spec
// topics ateam_get_spec did not accept, so following the advisor's own pointer
// failed. The advisor is the FIRST hop a building agent makes; a dead pointer
// there costs a whole design.
//
// Run: node test/spec-topics.test.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "tools.js"), "utf8");

let failures = 0;
function check(name, cond) {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}`); failures++; }
}

// ── The two lists, read out of the source ───────────────────────────────────
const mapBody = SRC.slice(SRC.indexOf("const SPEC_PATHS = {"));
const mapKeys = [...mapBody.slice(0, mapBody.indexOf("\n};")).matchAll(/^\s{2}"?([\w-]+)"?:\s*"/gm)].map((m) => m[1]);

// The get_spec enum is the one containing "connector-multi-user" — anchored on
// a value, not a line number, so re-ordering the schema does not break this.
const enumLine = SRC.split("\n").find((l) => l.includes("enum:") && l.includes('"connector-multi-user"'));
const enumValues = enumLine ? [...enumLine.matchAll(/"([\w-]+)"/g)].map((m) => m[1]) : [];

console.log("spec topics");
check("SPEC_PATHS was found and is not empty", mapKeys.length > 5);
check("the get_spec topic enum was found", enumValues.length > 5);

// `monitoring` is served by the tool itself rather than by a /spec route, so it
// is legitimately enum-only. Anything else enum-only is a dead topic.
const HANDLED_WITHOUT_A_ROUTE = new Set(["monitoring"]);

const missingFromMap = enumValues.filter((t) => !mapKeys.includes(t) && !HANDLED_WITHOUT_A_ROUTE.has(t));
check(
  `every enum topic resolves to a path${missingFromMap.length ? ` — dead: ${missingFromMap.join(", ")}` : ""}`,
  missingFromMap.length === 0
);

const missingFromEnum = mapKeys.filter((t) => !enumValues.includes(t));
check(
  `every mapped path is offered in the enum${missingFromEnum.length ? ` — unreachable: ${missingFromEnum.join(", ")}` : ""}`,
  missingFromEnum.length === 0
);

// ── The advisor's pointers must be topics this tool accepts ─────────────────
// The catalog lives in the Builder repo, so this cannot read it directly. What
// it CAN hold is the topics the advisor is known to point at — every one that
// has ever been added to the catalog. If a pointer topic ever leaves the enum,
// the advisor starts handing out an address that 404s.
const ADVISOR_POINTER_TOPICS = [
  "skill", "solution", "actor-storage", "voice", "voice-native", "widgets",
  "python_helpers", "triggers", "sub-agent", "consumer-roles",
  "mobile-connector", "device-capabilities",
];
const brokenPointers = ADVISOR_POINTER_TOPICS.filter((t) => !enumValues.includes(t));
check(
  `every advisor pointer topic is accepted${brokenPointers.length ? ` — broken: ${brokenPointers.join(", ")}` : ""}`,
  brokenPointers.length === 0
);

// The device matrix is the answer to "can the phone do X". It is reachable, or
// a builder is back to reading whichever topic happens to mention the camera.
check("the generated device capability matrix is reachable", enumValues.includes("device-capabilities"));

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

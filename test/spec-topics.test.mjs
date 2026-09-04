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
import { formatError } from "../src/api.js";
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

// The question-shaped index is the ONE topic a newcomer can find by thinking
// about their own problem rather than our vocabulary. If it stops being
// offered, an agent is back to guessing which artifact doc mentions a camera —
// which is what the 2026-09-04 acceptance run did, badly.
check("the capability index is reachable", enumValues.includes("capabilities"));
check("  and bootstrap names it as the FIRST call",
  /_first_call[\s\S]{0,200}topic:'capabilities'/.test(SRC));
check("  and the advisor's fallback names it too",
  /if_the_advisor_does_not_answer[\s\S]{0,300}topic:'capabilities'/.test(SRC));

// ── A 404 from /spec must not blame a solution ──────────────────────────────
// The generic 404 hint says "check the solution_id or skill_id". /spec takes
// neither, so asking for a topic a deployment has not shipped yet — which is
// exactly what happens while a tool is ahead of a backend — sent the reader
// hunting a solution that was never in the request.
console.log("404 on a spec path");

const specMsg = formatError("GET", "/spec/device-capabilities", 404, "Cannot GET /spec/device-capabilities", "https://api.ateam-ai.com");
// Bans the ACTION, not the word. The hint is allowed to say "takes no
// solution_id" — that is the disclaimer. What it must never do is send the
// reader off to find one.
check("does NOT send the reader hunting a solution",
  !/ateam_list_solutions/i.test(specMsg) && !/Check the solution_id/i.test(specMsg));
check("names the deployment that answered", specMsg.includes("https://api.ateam-ai.com"));
check("names the topic that was not served", specMsg.includes("device-capabilities"));
check("says retrying will not help", /Retrying will not/i.test(specMsg));

// The generic 404 must be UNCHANGED — this is a narrowing, not a replacement.
const solMsg = formatError("GET", "/solutions/nope", 404, "not found", "https://api.ateam-ai.com");
check("a real resource 404 still points at solution_id/skill_id",
  /solution_id/.test(solMsg) && /ateam_list_solutions/.test(solMsg));

// /specification-ish paths must not be swallowed by a sloppy prefix match.
const otherMsg = formatError("GET", "/specials/x", 404, "not found", "https://api.ateam-ai.com");
check("a path merely starting with /spec is not treated as a spec topic",
  /solution_id/.test(otherMsg));

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

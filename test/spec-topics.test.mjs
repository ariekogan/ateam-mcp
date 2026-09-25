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

// ── A topic nobody is told about is a topic nobody asks for ────────────────
// The enum says what may be requested; the description is the only place an
// agent learns what each topic IS. 360fb78 added five topics to the enum and
// none to the description — and seven more had been undescribed since long
// before. Read from the REAL tool object, not from the source text.
const { tools: TOOL_LIST } = await import("../src/tools.js");
const specTool = TOOL_LIST.find((t) => t.name === "ateam_get_spec");
const topicSchema = specTool?.inputSchema?.properties?.topic;
check("the live get_spec topic schema was found", Array.isArray(topicSchema?.enum) && topicSchema.enum.length > 5);
const undescribed = (topicSchema?.enum || []).filter((t) => !topicSchema.description.includes(`'${t}' =`));
check(`every enum topic is described${undescribed.length ? ` — undescribed: ${undescribed.join(", ")}` : ""}`,
  undescribed.length === 0);

// The device matrix is the answer to "can the phone do X". It is reachable, or
// a builder is back to reading whichever topic happens to mention the camera.
check("the generated device capability matrix is reachable", enumValues.includes("device-capabilities"));

// The question-shaped index is the ONE topic a newcomer can find by thinking
// about their own problem rather than our vocabulary. If it stops being
// offered, an agent is back to guessing which artifact doc mentions a camera —
// which is what the 2026-09-04 acceptance run did, badly.
check("the capability index is reachable", enumValues.includes("capabilities"));
// WHETHER without HOW is where the 2026-09-04 build failed: the agent knew the
// camera existed and still implemented continuous guidance as a photo loop.
check("the realization catalog is reachable", enumValues.includes("realizations"));
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

// ── An unknown topic must fail BY NAME ──────────────────────────────────────
// It used to leave `path` undefined, so the fetch targeted "<base>undefined" —
// a host that does not resolve. The reader was told to check their internet
// connection, about a deployment that had answered seconds earlier.
console.log("unknown topic");
const specHandler = SRC.slice(SRC.indexOf("let path = SPEC_PATHS[topic];"), SRC.indexOf("ateam_get_workflows:"));
check("get_spec refuses an unmapped topic instead of fetching undefined",
  /if \(!path\) \{[\s\S]{0,200}throw new Error\([\s\S]{0,200}Unknown spec topic/.test(specHandler));
check("  and lists what exists — the caller cannot see the map",
  /Object\.keys\(SPEC_PATHS\)\.join/.test(specHandler));

// ── Oversized spec responses stay VALID JSON and lose nothing silently ──────
// /spec/capabilities is ~50KB, of which `questions` is ~45KB, and bootstrap
// names it as the FIRST call an agent should make. The old `.slice()` cut
// inside `questions` and took every section after it — `composing_several`,
// `if_your_question_is_not_here` — with no mention that they had existed.
console.log("oversized spec truncation");
const { formatResultForTest } = await import("../src/tools.js").then(
  (m) => ({ formatResultForTest: m.formatResultForTest })
);
if (typeof formatResultForTest !== "function") {
  console.error("  ✗ formatResultForTest is not exported — this section tests nothing");
  failures++;
} else {
  const huge = {
    topic: "capabilities",
    how_to_use: "short and must survive",
    questions: Array.from({ length: 13 }, (_, i) => ({ id: `q${i}`, body: "x".repeat(4000) })),
    composing_several: { note: "the section the old slice ate" },
    if_your_question_is_not_here: "also eaten",
  };
  const outStr = formatResultForTest(huge, "ateam_get_spec");
  check(`stays under the cap (${outStr.length.toLocaleString()} chars)`, outStr.length <= 50_000);

  let parsed = null;
  try { parsed = JSON.parse(outStr); } catch { /* stays null */ }
  check("is still VALID JSON — the old tail-slice was not", parsed !== null);

  if (parsed) {
    check("the small section AFTER the huge one survives whole",
      parsed.composing_several?.note === "the section the old slice ate");
    check("  and so does the one after that",
      parsed.if_your_question_is_not_here === "also eaten");
    check("the omitted section is NAMED, not silently gone",
      /questions/.test(parsed._truncation || ""));
    // Nothing is lost: every entry is either included whole or named in the
    // not-included index. That union is the property that matters — the old
    // tail-slice satisfied neither half.
    const q = parsed.questions;
    const accountedFor = new Set([
      ...(q?.included || []).map((e) => e.id),
      ...(q?.not_included_ids || []),
    ]);
    check(`every one of the 13 entries is accounted for (${accountedFor.size}/13)`,
      accountedFor.size === 13);
    check("  and the ones that fit are present in FULL, not summarized",
      (q?.included || []).every((e) => e.body?.length === 4000));
    check("a section that fits is never stubbed",
      parsed.how_to_use === "short and must survive");
  }

  // A response that fits must be returned untouched — no stub, no _truncation.
  const small = formatResultForTest({ topic: "enums", a: 1 }, "ateam_get_spec");
  check("a small spec response is passed through unchanged",
    JSON.parse(small).a === 1 && JSON.parse(small)._truncation === undefined);

  // ── THE CAP IS A CEILING, WHATEVER THE SHAPE (754f2b2111) ──
  // 360fb78 replaced the old `.slice(0, MAX_RESPONSE_CHARS)` with a budget
  // check that charged 2 chars for a _truncation sentence of hundreds, ran
  // BEFORE the partial-array wrapper was substituted, never considered a
  // STRING section, and listed every omitted id. The one fixture above
  // happened to fit. These are the shapes that did not.
  const CAP = 50_000;
  const shapes = {
    "1,000 small entries": { topic: "capabilities", questions: Array.from({ length: 1000 }, (_, i) => ({ id: `e${i}`, body: "x".repeat(40) })) },
    "60 entries just over budget": { topic: "capabilities", questions: Array.from({ length: 60 }, (_, i) => ({ id: `e${i}`, body: "x".repeat(900) })) },
    "one 300KB string section": { topic: "sdk", guide: "y".repeat(300_000) },
    "200,000 id-only entries": { topic: "capabilities", questions: Array.from({ length: 200_000 }, (_, i) => ({ id: `e${i}` })) },
    "40 medium sections": { topic: "skill", ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`s${i}`, { text: "z".repeat(2_000) }])) },
    // No single section is worth stubbing — only an index-only answer fits.
    "3,000 small string sections": { topic: "enums", ...Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`key_${i}`, "v".repeat(30)])) },
  };
  for (const [label, shape] of Object.entries(shapes)) {
    const t0 = Date.now();
    const s = formatResultForTest(shape, "ateam_get_spec");
    let ok = null; try { ok = JSON.parse(s); } catch { /* stays null */ }
    check(`${label}: ≤ ${CAP.toLocaleString()} chars (${s.length.toLocaleString()}), valid JSON, ${Date.now() - t0}ms`,
      s.length <= CAP && ok !== null && Date.now() - t0 < 5_000);
    if (label === "one 300KB string section" && ok) {
      check("  the oversized STRING section is indexed, not returned whole",
        typeof ok.guide === "object" && /guide/.test(ok._truncation || ""));
    }
    // The index-only backstop is for documents nothing else can shrink. An
    // array that can be partially included must be — a budget that miscounts
    // would otherwise hide behind the backstop and still "pass" the cap.
    if (Array.isArray(shape.questions) && ok) {
      check("  and it still carries whole entries, not just an index",
        (ok.questions?.included?.length || 0) > 0);
    }
  }

  // ── THE INDEX IS TOTAL (998c07488a) ──
  // Omitted entries with no id/q/name used to be dropped from not_included_ids
  // by `.filter(Boolean)` — while the document said "the rest are indexed
  // below" over an EMPTY array. The union check above passes only because its
  // fixture gives every entry an `id`.
  const idless = formatResultForTest({
    topic: "capabilities",
    questions: Array.from({ length: 20 }, (_, i) => ({ question: `q${i}?`, body: "w".repeat(4000) })),
  }, "ateam_get_spec");
  const iq = JSON.parse(idless).questions;
  check(`id-less entries: included + indexed = all 20 (${iq?.included?.length} + ${iq?.not_included_ids?.length})`,
    (iq?.included?.length || 0) + (iq?.not_included_ids?.length || 0) === 20
      && iq?.not_included_count === 20 - (iq?.included?.length || 0));

  // A bounded index still ADDS UP: the count is exact even when the list of
  // names is capped.
  const many = JSON.parse(formatResultForTest(shapes["200,000 id-only entries"], "ateam_get_spec")).questions;
  check("a capped index still states the exact omitted count",
    many && typeof many.not_included_count === "number"
      && (many.included?.length || 0) + many.not_included_count === 200_000);
}

// ── The two lists must match the SERVER, not just each other ────────────────
// Everything above compares two hand-maintained lists INSIDE this file. Both
// can agree perfectly and still name fewer topics than the deployment serves:
// on 2026-09-23 the server served host-contract, platform-connectors,
// platform-truth, sdk and workflows, and no agent could request any of them,
// because nothing here had ever asked the server what it had.
//
// The /spec index self-reports `topics_served_here`, derived from its own
// router — so this compares against what is actually mounted.
console.log("the map vs the DEPLOYMENT");
const SPEC_BASE = process.env.ATEAM_SPEC_BASE || "https://dev-api.ateam-ai.com";
let servedTopics = null;
try {
  const r = await fetch(`${SPEC_BASE}/spec`, { signal: AbortSignal.timeout(15_000) });
  if (r.ok) servedTopics = (await r.json())?._this_deployment?.topics_served_here || null;
} catch { /* offline — reported below, never silently passed */ }

if (!Array.isArray(servedTopics)) {
  // Loud, and does NOT count as a pass. A check that cannot fail is a label.
  console.log(`  ⚠ SKIPPED — could not reach ${SPEC_BASE}. This check did NOT run.`);
} else {
  const mapped = new Set(
    [...mapBody.slice(0, mapBody.indexOf("\n};")).matchAll(/^\s{2}"?[\w-]+"?:\s*"(\/spec[^"]*)"/gm)]
      .map((m) => m[1].replace(/^\/spec\/?/, "") || "overview")
  );
  // Sub-paths (a/b) are reachable via their parent topic's `section` param.
  const unreachable = servedTopics.filter((t) => t && !t.includes("/") && !mapped.has(t));
  check(
    `every topic the deployment serves is requestable${unreachable.length ? ` — UNREACHABLE: ${unreachable.join(", ")}` : ""}`,
    unreachable.length === 0
  );
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

// BUILDER-2 — what ateam_design_advisor's description says when the advisor
// fails, and when the goal already chose a store.
//
// job_wfkgyg5o (2026-09-28) called the advisor with "Use an in-memory / JSON
// store in a custom MCP connector". The call failed with Core's "circuit open
// for ateam-mcp-test::ateam-proxy-mcp; cooling down" — raised by Core's
// per-(tenant, connector) breaker, so it never reached ateam-mcp or the
// Builder — and the build wrote that store. In that case the tool description
// is the only text the agent has, so it must say: a failed call leaves the
// design unchecked; storage is answered without the LLM; and the field that
// carries a conflict. The circuit-open error names no cool-down time, so the
// text must not promise one.
//
// AND IT MUST ARRIVE. That agent is the in-app solution builder, which makes
// every ateam_* call inside an agent run, and Core cuts every tool description
// there at 1200 characters (ai-dev-assistant anthropicAgentBackend.js,
// openaiAgentBackend.js, sys.callAiWithTools.js). Review M39-1 found the first
// version of this text past the cut.
//
// Run: node --test test/advisor-failure-text.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { tools } from "../src/tools.js";
import { formatError } from "../src/api.js";

const CORE_DESCRIPTION_CUT = 1200;
const desc = tools.find((t) => t.name === "ateam_design_advisor")?.description || "";
const seen = desc.slice(0, CORE_DESCRIPTION_CUT);

test("a failed advisor call leaves the design unchecked — and says so, inside what Core passes on", () => {
  assert.match(seen, /If this call fails, your design is unchecked: do not write storage code on a store you picked before asking\./);
});

test("storage is answered with no LLM, at the one storage decision — inside the cut", () => {
  assert.ok(seen.includes("ateam_get_spec('connector-multi-user') → storage_decision answers storage with no LLM"), seen);
  assert.ok(seen.includes("`storage_decision`"), "the failure reply's field is not named");
});

test("the WHOLE description reaches an in-app agent: it fits in Core's 1200-character cut", () => {
  assert.ok(desc.length <= CORE_DESCRIPTION_CUT, `${desc.length} characters; an in-app agent sees only the first ${CORE_DESCRIPTION_CUT}, ending "…${seen.slice(-40)}"`);
  // What was here before this change still arrives too.
  assert.ok(seen.includes("`truncated: true` means the answer was CUT OFF"));
});

test("conflicts are described as what they are: words matched, not a verdict on intent (M39-3)", () => {
  assert.ok(seen.includes("`conflicts_with_platform_rules` lists words in your goal or design_state that name a store the platform forbids (matched by words"), seen);
});

test("it does not promise a cool-down time the error never names", () => {
  assert.match(seen, /names no time/);
  assert.doesNotMatch(desc, /cool-down the error names/);
});

test("the topic it points at is one ateam_get_spec accepts", () => {
  const topics = tools.find((t) => t.name === "ateam_get_spec")?.inputSchema?.properties?.topic?.enum || [];
  assert.ok(topics.includes("connector-multi-user"));
});

// What the agent is SHOWN of a failure: formatError's text, which keeps 2000
// characters of the body. These bodies are the Builder's own (Builder #109,
// POST /spec/advisor at its review-round head, goal: the incident's, which
// names two stores) — review M39-2 found storage_decision cut from them.
const BUILDER_500 = "{\"error\":\"advisor failed: circuit open for ateam-mcp-test::ateam-proxy-mcp; cooling down\",\"storage_decision\":\"WHERE A CONNECTOR'S DATA GOES: records \u2014 anything the product lists, counts or totals \u2014 go in actorStore, through store() in THE template (GET /spec/multi-user-connector > complete_example.code (ateam_get_spec topic \\\"connector-multi-user\\\")): scope:'actor' for a user's own data, scope:'tenant' only for data shared by design. Files that are not records go under process.env.DATA_DIR, read with no fallback. Never the code directory (read-only, so EROFS, and replaced by every upload), /tmp, a module-level array, a native engine, or a file of records. Samples the user asked for go in through the store, labelled. A refusal is fixed at the call, never by moving the data. Caller identity comes from defineConnector's ctx. Every case, why, and the failure behind each NOT: ateam_get_spec('connector-multi-user') \u2192 storage_decision.\",\"storage_decision_note\":\"Decided without the LLM: it holds although this call failed.\",\"conflicts_with_platform_rules\":[{\"you_said\":\"in-memory\",\"rule\":\"A module-level array or object.\",\"use_instead\":\"storage_decision\"},{\"you_said\":\"JSON store\",\"rule\":\"A file of records \u2014 a JSON, JSONL or CSV file, lowdb, node-json-db \u2014 one for everyone or one per user, under DATA_DIR or anywhere else.\",\"use_instead\":\"storage_decision\"}]}";
const BUILDER_401 = "{\"error\":\"advisor: sign in first. It runs on your tenant's own LLM, so it needs a verified credential. NOT an outage and NOT a platform limit.\",\"code\":\"SIGN_IN_REQUIRED\",\"fix\":\"Send X-API-KEY (call ateam_auth(api_key) first) \u2014 every later call carries it. X-ADAS-TENANT alone is not a credential.\",\"storage_decision\":\"WHERE A CONNECTOR'S DATA GOES: records \u2014 anything the product lists, counts or totals \u2014 go in actorStore, through store() in THE template (GET /spec/multi-user-connector > complete_example.code (ateam_get_spec topic \\\"connector-multi-user\\\")): scope:'actor' for a user's own data, scope:'tenant' only for data shared by design. Files that are not records go under process.env.DATA_DIR, read with no fallback. Never the code directory (read-only, so EROFS, and replaced by every upload), /tmp, a module-level array, a native engine, or a file of records. Samples the user asked for go in through the store, labelled. A refusal is fixed at the call, never by moving the data. Caller identity comes from defineConnector's ctx. Every case, why, and the failure behind each NOT: ateam_get_spec('connector-multi-user') \u2192 storage_decision.\",\"storage_decision_note\":\"Decided without the LLM: it holds although this call failed.\",\"answer_without_authenticating\":{\"capability_index\":\"GET /spec/capabilities \u2014 every \\\"can I \u2026?\\\" question with a one-word answer and where to read next. No LLM, no tenant, no key.\",\"device_matrix\":\"GET /spec/device-capabilities \u2014 the generated per-API device matrix.\",\"spec_search\":\"POST /spec/search { query } \u2014 semantic search over the full /spec docs. No LLM, no tenant, no key.\",\"note\":\"These are static and always available. Do NOT conclude a capability is missing because this call was refused.\"},\"conflicts_with_platform_rules\":[{\"you_said\":\"in-memory\",\"rule\":\"A module-level array or object.\",\"use_instead\":\"storage_decision\"},{\"you_said\":\"JSON store\",\"rule\":\"A file of records \u2014 a JSON, JSONL or CSV file, lowdb, node-json-db \u2014 one for everyone or one per user, under DATA_DIR or anywhere else.\",\"use_instead\":\"storage_decision\"}]}";

test("a two-conflict failure body keeps storage_decision WHOLE in what the agent is shown (M39-2)", () => {
  for (const [status, text] of [[500, BUILDER_500], [401, BUILDER_401]]) {
    const body = JSON.parse(text);
    assert.ok(body.conflicts_with_platform_rules.length >= 2, "the fixture is not the two-conflict case");
    const shown = formatError("POST", "/spec/advisor", status, text, "https://api.ateam-ai.com");
    assert.ok(shown.includes(`"storage_decision":${JSON.stringify(body.storage_decision)}`), `${status}: storage_decision cut:\n${shown.slice(0, 400)}…`);
    assert.ok(shown.includes(JSON.stringify(body.storage_decision_note)), `${status}: the note was cut`);
  }
});

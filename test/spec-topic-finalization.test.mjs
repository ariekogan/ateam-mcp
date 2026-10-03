// ateam_get_spec(topic:"finalization") — how a skill's run ends, read whole.
//
// The Builder serves that chapter ONCE, at /spec/skill → finalization
// (FINALIZATION, capabilitySpecs.js; Builder PR "a Finalization chapter in
// /spec/skill"), and a search for "finalization" returns it whole inside one
// response. /spec/skill itself is ~190,000 characters; ateam_get_spec cuts a
// page to 50,000. Without a topic of its own, an agent asking "how does a run
// end" had to know that search term, or read a page cut to fit.
//
// The topic is that read: path /spec/skill, search "finalization" added unless
// the caller gave a search of their own. ateam-mcp states no finalization rule
// itself — the topic's line says what the chapter covers and never repeats a
// number or a rule, so it cannot drift from the Builder's chapter.
//
// Every request is answered in-process (fetch is replaced); each is checked
// against the URL fetch was called with.
//
// Run: node --test test/spec-topic-finalization.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setSessionCredentials, KEY_ENVIRONMENTS } from "../src/api.js";
import { handleToolCall, tools } from "../src/tools.js";

const CORE_DESCRIPTION_CUT = 1200;
const HEX = "0".repeat(32);
const SID = "sess-finalization-topic";

let fetched = [];
const realFetch = globalThis.fetch;
before(() => {
  setSessionCredentials(SID, { tenant: "tenanta", apiKey: `adas_prod_tenanta_${HEX}`, apiUrl: KEY_ENVIRONMENTS.prod });
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    fetched.push(u);
    return new Response(JSON.stringify({ topic: "skill", finalization: { description: "stub" } }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
});
after(() => { globalThis.fetch = realFetch; });

async function getSpec(args) {
  fetched = [];
  const res = await handleToolCall("ateam_get_spec", args, SID);
  return { res, url: fetched[0] };
}

const spec = () => tools.find((t) => t.name === "ateam_get_spec");
const topicSchema = () => spec().inputSchema.properties.topic;
// The topic's own line in the description: from "'finalization' =" to the next topic.
const line = () => {
  const d = topicSchema().description;
  const from = d.indexOf("'finalization' =");
  return from < 0 ? "" : d.slice(from, d.indexOf("'monitoring' =", from));
};

test("'finalization' is a topic ateam_get_spec accepts, and it is described", () => {
  assert.ok(topicSchema().enum.includes("finalization"), "not in the topic enum");
  assert.ok(line().length > 100, "the description has no 'finalization' = line");
});

test("asking for it reads the finalization part of the skill spec, whole", async () => {
  const { res, url } = await getSpec({ topic: "finalization" });
  assert.ok(!res.isError, res.content[0].text.slice(0, 300));
  assert.equal(url.pathname, "/spec/skill");
  assert.equal(url.searchParams.get("search"), "finalization");
  assert.equal(url.searchParams.get("section"), null);
  assert.equal(JSON.parse(res.content[0].text).finalization.description, "stub");
});

test("a search of the caller's own wins over the topic's", async () => {
  const { res, url } = await getSpec({ topic: "finalization", search: "finalize_tool" });
  assert.ok(!res.isError, res.content[0].text.slice(0, 300));
  assert.equal(url.pathname, "/spec/skill");
  assert.equal(url.searchParams.get("search"), "finalize_tool");
});

test("no other topic gains a search it did not ask for", async () => {
  for (const topic of ["skill", "solution", "workflows", "widgets", "triggers"]) {
    const { res, url } = await getSpec({ topic });
    assert.ok(!res.isError, `${topic}: ${res.content[0].text.slice(0, 200)}`);
    assert.equal(url.searchParams.get("search"), null, topic);
    assert.equal(url.pathname, `/spec/${topic}`, topic);
  }
  const { url } = await getSpec({ topic: "skill", section: "role", search: "stages" });
  assert.equal(url.searchParams.get("section"), "role");
  assert.equal(url.searchParams.get("search"), "stages");
});

test("its line names the ways a run ends and states no rule or number of its own", () => {
  const l = line();
  for (const part of ["sys.finalizePlan", "sys.askUser", "sys.handoffToSkill", "role.finalize_tool", "infra_ok", "what does not work yet"]) {
    assert.ok(l.includes(part), `the line does not name ${part}`);
  }
  // The Builder's chapter owns every number and rule; a copy here would drift.
  assert.doesNotMatch(l, /\d/, "a number in the finalization line");
  assert.doesNotMatch(l, /\b(must|never|always|default)\b/i, "a rule in the finalization line");
  // The swap test: nothing the chapter's domain-neutral words would not say.
  assert.doesNotMatch(l, /invoic|supplier|vendor(?!ed|ing)|currenc|amount|due[\s_-]*date|payment|receipt|ledger|bill/i);
  assert.doesNotMatch(l, /dev-api|dev-builder|adas_dev_/);
});

test("the tool's own description still fits Core's cut", () => {
  assert.ok(spec().description.length <= CORE_DESCRIPTION_CUT, `${spec().description.length} characters`);
});

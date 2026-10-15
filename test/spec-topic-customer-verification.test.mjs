// ateam_get_spec(topic:"customer-verification") — the page that teaches an
// outside agent (or the build skill) to design a solution with customer
// verification, and the advisor pointer that sends it there.
//
// The Builder serves the page ONCE, at /spec/customer-verification
// (CUSTOMER_VERIFICATION_SPEC), and its advisor catalog entry `customer_verification`
// carries spec_topic "customer-verification". ateam_design_advisor only proxies
// POST /spec/advisor, so it holds no copy and needs no change here. What
// ateam-mcp owns is the DOOR: the topic had been in no list in this file, so the
// advisor's own pointer ("read_spec": "customer-verification") was refused by
// ateam_get_spec — the OPEN-19 failure again, in the one place a designing agent
// goes first.
//
// The topic's line in the description says what is LIVE and what is COMING and
// never more: Core checks an emailed code today; phone calls and text messages
// are not built. A line that said "email, voice" would send a phone-only
// solution to a gate that does not exist (ateam_test_voice's own text says why:
// Core refuses a phone caller's skill call today, C6).
//
// Every request is answered in-process (fetch is replaced); each is checked
// against the URL fetch was called with.
//
// Run: node --test test/spec-topic-customer-verification.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setSessionCredentials, KEY_ENVIRONMENTS } from "../src/api.js";
import { handleToolCall, tools } from "../src/tools.js";

const HEX = "0".repeat(32);
const SID = "sess-customer-verification-topic";

let fetched = [];
const realFetch = globalThis.fetch;
before(() => {
  // explicit: the advisor runs on the tenant's own LLM, so the sign-in gate refuses it without one.
  setSessionCredentials(SID, { tenant: "tenanta", apiKey: `adas_prod_tenanta_${HEX}`, apiUrl: KEY_ENVIRONMENTS.prod, explicit: true });
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    fetched.push({ url: u, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
    if (u.pathname === "/spec/advisor") {
      // The Builder's own shape (routes/spec.js: relevant_capabilities[].read_spec
      // is an ateam_get_spec topic).
      return new Response(JSON.stringify({
        relevant_capabilities: [{ id: "customer_verification", why: "stub", read_spec: "customer-verification", wiring_tool: "ateam_patch" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ name: "customer_verification", status: "stub" }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
});
after(() => { globalThis.fetch = realFetch; });

const run = async (name, args) => {
  fetched = [];
  const res = await handleToolCall(name, args, SID);
  return { res, calls: fetched };
};

const spec = () => tools.find((t) => t.name === "ateam_get_spec");
const topicSchema = () => spec().inputSchema.properties.topic;
// The topic's own line in the description: from "'customer-verification' =" to the next topic.
const line = () => {
  const d = topicSchema().description;
  const from = d.indexOf("'customer-verification' =");
  return from < 0 ? "" : d.slice(from, d.indexOf("'triggers' =", from));
};

test("'customer-verification' is a topic ateam_get_spec accepts, and it is described", () => {
  assert.ok(topicSchema().enum.includes("customer-verification"), "not in the topic enum");
  assert.ok(line().length > 100, "the description has no 'customer-verification' = line");
});

test("asking for it reads the Builder's /spec/customer-verification page, and adds nothing to the request", async () => {
  const { res, calls } = await run("ateam_get_spec", { topic: "customer-verification" });
  assert.ok(!res.isError, res.content[0].text.slice(0, 300));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url.pathname, "/spec/customer-verification");
  assert.equal(calls[0].url.search, "", "the topic added a search or section of its own");
  assert.equal(JSON.parse(res.content[0].text).name, "customer_verification");
});

test("a search of the caller's own reaches the page unchanged", async () => {
  const { res, calls } = await run("ateam_get_spec", { topic: "customer-verification", search: "risky_tools" });
  assert.ok(!res.isError, res.content[0].text.slice(0, 300));
  assert.equal(calls[0].url.pathname, "/spec/customer-verification");
  assert.equal(calls[0].url.searchParams.get("search"), "risky_tools");
});

test("its line says what is live and what is coming, and promises no phone or text channel", () => {
  const l = line();
  const [live, coming = ""] = l.split(/COMING/);
  assert.match(live, /LIVE today: the email code check only/, `the line does not say what is live: ${l}`);
  assert.match(coming, /not built yet/, `the line does not say the rest is not built: ${l}`);
  assert.match(coming, /phone calls/);
  assert.match(coming, /text messages/);
  // Before the word COMING, only email: a phone or a call named there would read as live.
  assert.doesNotMatch(live, /\b(voice|phone|call|calls|sms|text message)/i, `a channel Core has not built is named as live: ${live}`);
});

test("the line states no rule or number of its own: the Builder's page is the one home", () => {
  const l = line();
  assert.ok(l.length > 100, "the description has no 'customer-verification' = line to check");
  assert.doesNotMatch(l, /\d/, `a number in the line can drift from the page: ${l}`);
  assert.doesNotMatch(l, /sys\.verification|protected_tools|risky_tools|proof_ttl/, `a field name in the line can drift from the page: ${l}`);
});

test("ateam_design_advisor needs no change: it asks the Builder, and the topic it points at is accepted and read", async () => {
  const advised = await run("ateam_design_advisor", { goal: "outside people email us and must be proven before they see their records" });
  assert.ok(!advised.res.isError, advised.res.content[0].text.slice(0, 300));
  assert.equal(advised.calls.length, 1, "the advisor made more than the one Builder call");
  assert.equal(advised.calls[0].method, "POST");
  assert.equal(advised.calls[0].url.pathname, "/spec/advisor");
  assert.deepEqual(Object.keys(advised.calls[0].body).sort(), ["design_state", "goal"]);

  const pointer = JSON.parse(advised.res.content[0].text).relevant_capabilities[0].read_spec;
  assert.equal(pointer, "customer-verification");
  assert.ok(topicSchema().enum.includes(pointer), `the advisor points at "${pointer}", which ateam_get_spec refuses`);
  const read = await run("ateam_get_spec", { topic: pointer });
  assert.ok(!read.res.isError, read.res.content[0].text.slice(0, 300));
  assert.equal(read.calls[0].url.pathname, "/spec/customer-verification");
});

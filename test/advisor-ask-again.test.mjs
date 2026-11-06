// THE ADVISOR MAY ANSWER "STILL RUNNING", AND ASKING AGAIN WAITS FOR THE SAME ANSWER
// (advisor v2, Builder #180 phase 1).
//
// The Builder's agent advisor (engine "agent") waits at most wait_ms and then
// answers status:"running" with a request_id. Over a hosted connection the call
// must answer inside the chat client's ~60 s, so ateam_design_advisor asks the
// Builder to wait less than HOSTED_CALL_BUDGET_MS; a stdio process may wait
// longer. The same call with request_id sends only the id: it starts nothing.
//
// Run: node --test test/advisor-ask-again.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { setSessionCredentials, runToolCall } from "../src/api.js";
import * as TOOLS from "../src/tools.js";

const { handleToolCall, HOSTED_CALL_BUDGET_MS } = TOOLS;
const KEY = "adas_tenanta_00000000000000000000000000000000";
setSessionCredentials("sess-adv", { apiKey: KEY, apiUrl: "http://builder.test", explicit: true });

function stub(t, reply) {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    sent.push({ path: new URL(String(url)).pathname, body: opts.body ? JSON.parse(opts.body) : undefined });
    return new Response(JSON.stringify(reply), { status: reply.status === "running" ? 202 : 200, headers: { "Content-Type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  return sent;
}
const run = (args, transport) => runToolCall("sess-adv", () => handleToolCall("ateam_design_advisor", args, "sess-adv"), { transport });
const textOf = (r) => JSON.parse(r?.content?.[0]?.text ?? JSON.stringify(r));

test("hosted: the Builder is asked to wait less than the hosted budget, and a running answer reaches the agent", async (t) => {
  const sent = stub(t, { status: "running", request_id: "adv_0123456789abcdef", _next: "call again" });
  const r = await run({ goal: "a team app", design_state: {} }, "http");
  assert.equal(sent[0].path, "/spec/advisor");
  assert.ok(sent[0].body.wait_ms < HOSTED_CALL_BUDGET_MS, `wait_ms ${sent[0].body.wait_ms}`);
  assert.equal(sent[0].body.goal, "a team app");
  assert.equal(textOf(r).request_id, "adv_0123456789abcdef");
});

test("asking again sends only the request id (nothing new is started); stdio may wait longer", async (t) => {
  const sent = stub(t, { relevant_capabilities: [], engine: "agent" });
  await run({ goal: "a team app", request_id: "adv_0123456789abcdef" }, "stdio");
  assert.deepEqual(Object.keys(sent[0].body).sort(), ["request_id", "wait_ms"]);
  assert.ok(sent[0].body.wait_ms > HOSTED_CALL_BUDGET_MS);
});

test("a goal is sent once: a transport failure is not re-sent (a goal starts a billed run); a request_id must be a string", async (t) => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    sent.push(JSON.parse(opts.body));
    return new Response("bad gateway", { status: 502 });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  await run({ goal: "a team app", design_state: {} }, "http").catch(() => null);
  assert.equal(sent.length, 1);
  const bad = await run({ goal: "a team app", request_id: 42 }, "http").catch((e) => e);
  assert.match(JSON.stringify(bad?.message ?? bad), /request_id must be/);
  assert.equal(sent.length, 1);
});

test("the call answers inside its budget: hosted under HOSTED_CALL_BUDGET_MS, stdio under the edge's ~100 s", async (t) => {
  const sent = stub(t, { relevant_capabilities: [], engine: "agent" });
  await run({ goal: "a team app" }, "stdio");
  assert.ok(sent[0].body.wait_ms <= 75_000, `stdio wait_ms ${sent[0].body.wait_ms}`);
  await run({ goal: "a team app" }, "http");
  assert.ok(sent[1].body.wait_ms <= HOSTED_CALL_BUDGET_MS - 10_000, `hosted wait_ms ${sent[1].body.wait_ms}`);
});

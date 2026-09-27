// actor_id on ateam_conversation / ateam_test_skill: say what it does TODAY.
//
// Every surface an agent reads promised per-actor threads (C2-FALSE-ACTOR-
// CONTRACT-DOCS): "pass the actor_id back to continue the conversation", "the
// same actor_id maintains conversation context", "use ateam_test_skill /
// ateam_conversation for per-user-actor flows". Today the returned
// test_<ts>_<rand> id is a label: the Builder never forwards it to Core, the
// job runs as the tenant's _system_service actor, and its planner gets no
// earlier turns (Core C2/C3). An agent that followed the docs sent "yes" to a
// conversation that did not remember asking.
//
// This drives the real surfaces — the tool list, the bootstrap response, the
// tenant CLAUDE.md, the conversation handler's own _poll block, the scaffolded
// connector and the actor-not-found hint — and holds them to ONE text
// (src/actorIdToday.js).
//
// Run: node --test test/actor-id-today.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setSessionCredentials, formatError } from "../src/api.js";
import { tools, handlers, handleToolCall } from "../src/tools.js";
import { renderAgentDocHeader } from "../src/agentDoc.js";
import { ACTOR_ID_TODAY } from "../src/actorIdToday.js";

const SID = "sess-actor-id-today";
const KEY = "adas_tenanta_00000000000000000000000000000000";
const uploads = [];
let server;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const path = req.url.split("?")[0];
      let reply = { ok: true };
      if (path.endsWith("/test")) reply = { ok: true, job_id: "job_1", chain_id: "job_1", actor_id: "test_1790000000000_ab12cd" };
      if (path.endsWith("/upload")) { uploads.push(JSON.parse(body || "{}")); reply = { ok: true, tools: 1 }; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, { apiKey: KEY, apiUrl: `http://127.0.0.1:${server.address().port}`, explicit: true });
});
after(() => server.close());

// The promises, as an agent reads them.
const FALSE_PROMISES = [
  [/continue the (same )?(conversation|thread)\b/i, "passing actor_id back continues the conversation"],
  [/maintains conversation context/i, "the same actor_id maintains conversation context"],
  [/same conversation context/i, "new chain, same conversation context"],
  [/conversation continuity/i, "actor_id gives conversation continuity"],
  [/per-user-actor flows/i, "test_skill / conversation are the per-user-actor path"],
  [/auto-expires in 24h/i, "a test actor is created and expires"],
  [/multi-turn via actor_id/i, "multi-turn via actor_id"],
  [/use ateam_test_skill or a real conversation to exercise per-user/i, "test_skill is actor-scoped"],
];
const assertNoPromise = (where, text) => {
  for (const [rx, claim] of FALSE_PROMISES) assert.doesNotMatch(text, rx, `${where} still promises: ${claim}`);
};
const tool = (name) => tools.find((t) => t.name === name);

test("the text says what happens today, and names the only path that is per-user", () => {
  assert.match(ACTOR_ID_TODAY, /_system_service/);
  assert.match(ACTOR_ID_TODAY, /does NOT continue a conversation/);
  assert.match(ACTOR_ID_TODAY, /EXISTS in this tenant/);
  assertNoPromise("ACTOR_ID_TODAY", ACTOR_ID_TODAY);
});

test("ateam_test_skill and ateam_conversation carry it, and promise nothing else", () => {
  const skillActor = tool("ateam_test_skill").inputSchema.properties.actor_id.description;
  const conv = tool("ateam_conversation");
  assert.ok(skillActor.includes(ACTOR_ID_TODAY), "ateam_test_skill's actor_id does not say what it does today");
  assert.ok(conv.description.includes(ACTOR_ID_TODAY), "ateam_conversation does not say what actor_id does today");
  assertNoPromise("ateam_test_skill actor_id", skillActor);
  assertNoPromise("ateam_conversation description", conv.description);
  assertNoPromise("ateam_conversation actor_id", conv.inputSchema.properties.actor_id.description);
  // Every other tool, too: the promise must not survive anywhere in the list.
  assertNoPromise("tools/list", JSON.stringify(tools));
});

test("the bootstrap conversation_flow carries it; no step promises a thread", async () => {
  const boot = await handlers.ateam_bootstrap({}, SID);
  assert.equal(findDeep(boot, "conversation_flow")?.actor_id_today, ACTOR_ID_TODAY,
    "conversation_flow does not render ACTOR_ID_TODAY");
  assertNoPromise("ateam_bootstrap", JSON.stringify(boot));
});

test("the tenant CLAUDE.md does not send per-user testing to test_skill / conversation", () => {
  const doc = renderAgentDocHeader({ solution: { id: "s", name: "S" } });
  assert.ok(doc.includes(ACTOR_ID_TODAY), "the tenant CLAUDE.md does not say what actor_id does today");
  assertNoPromise("CLAUDE.md", doc);
});

test("ateam_conversation's own reply does not tell the caller to pass the label back", async () => {
  const r = await handleToolCall("ateam_conversation", { solution_id: "s", message: "log 3 glasses" }, SID);
  assert.ok(!r.isError, r.content?.[0]?.text);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.actor_id, "test_1790000000000_ab12cd", "(the Builder's label is still returned as-is)");
  assert.equal(out._poll?.actor_id, ACTOR_ID_TODAY, "_poll does not say what that actor_id does");
  assertNoPromise("ateam_conversation result", JSON.stringify(out));
});

test("a scaffolded connector's missing-actor error does not call test_skill actor-scoped", async () => {
  uploads.length = 0;
  const r = await handleToolCall("ateam_create_connector", { solution_id: "s", connector_id: "demo-mcp" }, SID);
  assert.ok(!r.isError, r.content?.[0]?.text);
  const server = uploads.flatMap((u) => u.files || []).find((f) => f.path.endsWith("server.js"))?.content || "";
  assert.match(server, /_adas_actor missing/, "(the scaffold's actor guard was not found)");
  assertNoPromise("scaffolded server.js", server);
});

test("the actor-not-found hint does not point at the label ateam_conversation returns", () => {
  const msg = formatError("POST", "/solutions/s/test", 400,
    JSON.stringify({ ok: false, code: "ACTOR_NOT_FOUND", error: 'Actor "bob" not found' }), "https://api.example");
  assert.match(msg, /does not recognise the ACTOR "bob"/);
  assert.doesNotMatch(msg, /the one ateam_conversation returned/, "the hint sends the caller to the test_ label");
});

function findDeep(obj, key) {
  if (!obj || typeof obj !== "object") return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) { const f = findDeep(v, key); if (f !== undefined) return f; }
  return undefined;
}

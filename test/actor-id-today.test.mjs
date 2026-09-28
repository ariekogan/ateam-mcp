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
// The first fix (c847a4b) overcorrected into two more false texts, which CORE
// read against Core origin/dev: "passing it back does NOT continue a
// conversation (the planner is given no earlier turns)" and "per-user tools see
// no user". A _system_service job gets no transcript, but a message classified
// `continue` inherits the tenant's LAST _system_service chain (Core
// worker/chainContinuation.js, keyed on the actor), so two unrelated test
// threads can share context; and its tools receive _adas_actor
// "_system_service" (utils/callerContext.js:224-226), which actorStore refuses
// ("unsafe actor segment", actorstore-mcp/pool.js:28-35).
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
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSessionCredentials, formatError } from "../src/api.js";
import { tools, handlers, handleToolCall } from "../src/tools.js";
import { renderAgentDocHeader } from "../src/agentDoc.js";
// A namespace import, so a build that lacks one of the two texts fails the
// tests that need it (with their messages) instead of failing to link.
import * as today from "../src/actorIdToday.js";
const { ACTOR_ID_TODAY, SERVICE_ACTOR_AT_TOOLS } = today;

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
  // c847a4b's overcorrection: "nothing carries" and "no user". Both false.
  [/does NOT (continue|carry)\b/i, "a follow-up carries nothing over"],
  [/one message is one conversation/i, "a follow-up carries nothing over"],
  [/see no user/i, "per-user tools see no user"],
  [/caller is not actor-scoped/i, "a _system_service caller leaves _adas_actor missing"],
];
const assertNoPromise = (where, text) => {
  for (const [rx, claim] of FALSE_PROMISES) assert.doesNotMatch(text, rx, `${where} still promises: ${claim}`);
};
const tool = (name) => tools.find((t) => t.name === name);

test("the text says what happens today, and names the only path that is per-user", () => {
  assert.match(ACTOR_ID_TODAY, /_system_service/);
  assert.match(ACTOR_ID_TODAY, /EXISTS in this tenant/);
  assertNoPromise("ACTOR_ID_TODAY", ACTOR_ID_TODAY);
});

test("a follow-up: no transcript, but a 'continue' inherits the tenant's LAST _system_service chain", () => {
  assert.match(ACTOR_ID_TODAY, /its chat transcript is empty/, "does not say a _system_service turn gets no transcript");
  assert.match(ACTOR_ID_TODAY, /intent 'continue' inherits .* of the tenant's most recently finished _system_service chain \(last 30 min\), whichever thread ran it/,
    "does not say a 'continue' inherits the tenant's last _system_service chain");
  assert.match(ACTOR_ID_TODAY, /two unrelated test threads can share context/, "does not say what that means for two test threads");
  assert.match(ACTOR_ID_TODAY, /passing it back does not choose what a turn continues/, "does not say the label picks nothing");
});

test("per-user tools receive the actor '_system_service', and actorStore refuses it", () => {
  assert.equal(typeof SERVICE_ACTOR_AT_TOOLS, "string", "no one text says what a per-user tool receives as _system_service");
  assert.match(SERVICE_ACTOR_AT_TOOLS, /receive _adas_actor '_system_service'/, "does not say what a per-user tool receives");
  assert.match(SERVICE_ACTOR_AT_TOOLS, /actorStore refuses a per-actor call made with it \('actorstore-mcp: unsafe actor segment'\)/,
    "does not say what actorStore does with that actor");
  assert.ok(ACTOR_ID_TODAY.includes(SERVICE_ACTOR_AT_TOOLS), "ACTOR_ID_TODAY does not render SERVICE_ACTOR_AT_TOOLS");
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
  const step4 = findDeep(boot, "conversation_flow")?.steps?.[3] || "";
  assert.match(step4, /^4\. NEXT TURN/, "(conversation_flow step 4 not found)");
  assert.match(step4, /from WHICH one \(as _system_service it may be another test thread's\), is actor_id_today below/,
    "step 4 does not say which earlier chain a next turn inherits from");
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
  // The message the connector actually throws, as its string expression evaluates.
  const expr = server.match(/if \(!id\) \{\s*throw new Error\(([\s\S]*?)\);\s*\}/)?.[1];
  assert.ok(expr, "(the scaffold's missing-actor throw was not found)");
  const message = new Function(`return (${expr});`)();
  assert.ok(message.includes(`A test call is NOT this cause: ateam_test_connector, and ateam_test_skill / ateam_conversation without a real actor_id, run as the tenant's shared _system_service actor, and ${SERVICE_ACTOR_AT_TOOLS}.`),
    `the missing-actor error does not say a test call reaches the tool as '_system_service': ${message}`);
  assertNoPromise("scaffolded missing-actor error", message);
  // The text is embedded in a double-quoted string of GENERATED code: prove it still parses.
  const dir = mkdtempSync(join(tmpdir(), "actor-scaffold-"));
  try {
    writeFileSync(join(dir, "server.mjs"), server);
    execFileSync(process.execPath, ["--check", join(dir, "server.mjs")], { stdio: "pipe" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

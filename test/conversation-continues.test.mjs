// WHAT CONTINUES A CONVERSATION, as ateam_conversation tells it.
//
// It said "pass the reply's actor_id (the thread) back in to continue that
// thread", its actor_id "to continue it" (7d44113), its kickoff result
// "ateam_conversation(actor_id: …) to continue the thread" (a793b34), and
// bootstrap "CONTINUE THE THREAD … New chain, same thread". None of it is what
// Core does (ai-dev-assistant origin/dev, 2026-10-02):
//   - Core drops a body actorId from an API-key or JWT caller (server.js:2578-2580),
//     so the job runs as the key's person — the conversation is keyed by that.
//   - Every call is a new chain (server.js:2748; sys.askUser ends its chain,
//     server.js:2771-2776).
//   - An answer reaches the skill that asked only through continuity routing:
//     within 60 s of that actor's last turn, 5 min for 25 characters or fewer,
//     never after a new-task verb (skills/skillLoader.js:216-251).
// And the description was 1,489 characters where Core cuts at 1,200
// (anthropicAgentBackend.js:618), so the in-app builder never read its end.
//
// The Builder's constants stay byte for byte (tests-run-as-key-person,
// test-connector-human-step pin them); this checks what ateam-mcp says around them.
//
// Run: node --test test/conversation-continues.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setSessionCredentials } from "../src/api.js";
import { tools, handleToolCall } from "../src/tools.js";
import { TEST_RUNS_AS, RAN_AS_IN_REPLY } from "../src/testRunsAs.js";
import { WAITING_ON_THE_USER, PLAY_THE_PERSON } from "../src/humanStep.js";

const CORE_DESCRIPTION_CUT = 1200;
const conv = () => tools.find((t) => t.name === "ateam_conversation");

// The two sentences, as the description, the kickoff result and bootstrap
// render them. Written here once more ON PURPOSE: a test that read them from
// the source could not notice the source changing them.
const CONTINUES =
  "Each call is a new chain, and your key, not actor_id, continues the conversation: Core keys it by the actor the job runs as (passing the reply's actor_id back is harmless).";
const WINDOW =
  "Core sends a message to the skill of that actor's last turn only within 60 s of it (5 min if the message is 25 characters or fewer), never when it starts with a new-task verb (build, create, make, …); later it is routed like a first message, so an answer can miss its question.";

test("the WHOLE description reaches an in-app agent: it fits in Core's 1200-character cut", () => {
  const d = conv().description;
  assert.ok(d.length <= CORE_DESCRIPTION_CUT, `${d.length} characters; an in-app agent sees only the first ${CORE_DESCRIPTION_CUT}, ending "…${d.slice(CORE_DESCRIPTION_CUT - 40, CORE_DESCRIPTION_CUT)}"`);
  // What sat past the cut before now arrives.
  assert.ok(d.includes(RAN_AS_IN_REPLY));
});

test("multi-turn: the key continues the conversation, not actor_id, and each call is a new chain", () => {
  const multi = conv().description.slice(conv().description.indexOf("Multi-turn:"));
  assert.ok(multi.includes(CONTINUES), multi);
  assert.doesNotMatch(conv().description, /to continue that thread|actor_id \(the thread\)/);
});

test("the reply window, with Core's numbers: 60 s, 5 min for 25 characters or fewer, and a new-task verb", () => {
  const multi = conv().description.slice(conv().description.indexOf("Multi-turn:"));
  assert.ok(multi.includes(WINDOW), multi);
  // The window comes before the rule for answering, which it qualifies; the
  // Builder's sentences follow unchanged.
  assert.ok(multi.indexOf(WINDOW) < multi.indexOf(WAITING_ON_THE_USER));
  assert.ok(multi.includes(PLAY_THE_PERSON));
});

test("actor_id says what it does and does not do, then who the job runs as", () => {
  const p = conv().inputSchema.properties.actor_id.description;
  assert.ok(p.startsWith("Optional. It picks no identity and continues nothing: your key does both"), p);
  assert.ok(p.includes("with a person, the reply's actor_id is that person whatever you pass"), p);
  assert.ok(p.includes("ateam-mcp keeps the actor_id you pass, and the one the reply returns (a test_ id excepted), as this session's actor"), p);
  // Core answers an unknown X-ADAS-ACTOR-ID with 401 `Actor "<id>" not found`
  // (ai-dev-assistant middleware/attachActor.js), on every later read.
  assert.ok(p.includes("so pass only a real one: an id Core does not know makes those reads fail (401)"), p);
  assert.ok(p.endsWith(TEST_RUNS_AS), "TEST_RUNS_AS is not rendered whole at the end");
  assert.doesNotMatch(p, /to continue it/);
});

test("bootstrap says the same: the next turn needs no actor_id, and the window", async () => {
  const boot = JSON.parse((await handleToolCall("ateam_bootstrap", {}, "sess-conv-continues-boot")).content[0].text);
  const flow = boot.conversation_flow;
  assert.ok(flow.steps[3].includes(CONTINUES) && flow.steps[3].includes(WINDOW), flow.steps[3]);
  assert.doesNotMatch(JSON.stringify(flow), /same thread|CONTINUE THE THREAD|actor_id: <the reply's actor_id>/);
  assert.doesNotMatch(flow.example.continue, /actor_id/);
  const step5 = boot.developer_loop.steps.find((s) => s.step === 5).description;
  assert.doesNotMatch(step5, /multi-turn via actor_id/);
  assert.match(step5, /the next turn: conversation_flow\.steps\[3\]/);
});

// The kickoff result's own hint.
const SID = "sess-conv-continues";
let server;
before(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, job_id: "job_1", chain_id: "job_1", actor_id: "usr_person", ran_as: "usr_person", status: "running" }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, { apiKey: "adas_tenanta_" + "0".repeat(32), apiUrl: `http://127.0.0.1:${server.address().port}`, explicit: true });
});
after(() => server.close());

test("the kickoff result says how to send the next turn, without actor_id", async () => {
  const r = await handleToolCall("ateam_conversation", { solution_id: "walkmate", message: "hi" }, SID);
  assert.ok(!r.isError, r.content[0].text.slice(0, 300));
  const out = JSON.parse(r.content[0].text);
  assert.equal(out._poll.continue, `ateam_conversation(solution_id, message). ${CONTINUES} ${WINDOW}`);
});

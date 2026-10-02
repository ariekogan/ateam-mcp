// A WRONG LESSON CAN BE CORRECTED: ateam_log_lesson carries `supersedes`,
// ateam_get_lessons carries `include_superseded`, and both texts say how.
//
// The lessons store (Builder, POST/GET /api/solutions/:id/lessons) owns the
// behaviour: a lesson logged with supersedes:<id> replaces that one, the wrong
// one stays in the history, and GET no longer returns it as a lesson. These
// tools must carry both fields to it — the handler destructured a fixed list,
// so an unlisted field was dropped before any request — and the texts must
// reach an in-app agent whole: Core cuts every tool description at 1200
// characters (ai-dev-assistant anthropicAgentBackend.js, openaiAgentBackend.js,
// sys.callAiWithTools.js), and ateam_log_lesson was already 1292.
//
// Run: node --test test/lesson-supersede.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setSessionCredentials } from "../src/api.js";
import { handleToolCall, tools, LESSON_CORRECTION_RULE } from "../src/tools.js";

const CORE_DESCRIPTION_CUT = 1200;
const SID = "sess-lesson-supersede";
let hits = [];
let reply = null;
let server;
before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null });
      const r = reply || { status: 200, body: { ok: true } };
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, {
    apiKey: "adas_tenanta_00000000000000000000000000000000",
    apiUrl: `http://127.0.0.1:${server.address().port}`,
    explicit: true,
  });
});
after(() => server.close());

async function call(tool, args, answer = null) {
  hits = [];
  reply = answer;
  const res = await handleToolCall(tool, args, SID);
  return { res, text: res.content[0].text };
}

const tool = (name) => tools.find((t) => t.name === name);

test("ateam_log_lesson sends `supersedes` to the lessons store", async () => {
  await call("ateam_log_lesson", {
    solution_id: "sol-a", tool: "ateam_test_connector", error: "ETIMEDOUT after 30000ms", supersedes: "lesson_3f9a0c12de",
  });
  assert.deepEqual(hits.map((h) => `${h.method} ${h.url}`), ["POST /deploy/solutions/sol-a/lessons"]);
  assert.equal(hits[0].body.supersedes, "lesson_3f9a0c12de");
  assert.equal(hits[0].body.error, "ETIMEDOUT after 30000ms");
});

test("a plain lesson sends no `supersedes` at all", async () => {
  await call("ateam_log_lesson", { solution_id: "sol-a", tool: "ateam_upload_connector", error: "permission denied: devices.write" });
  assert.equal("supersedes" in hits[0].body, false, JSON.stringify(hits[0].body));
});

test("a refused supersede reaches the caller as the store's 409, naming the current lesson", async () => {
  const { res, text } = await call(
    "ateam_log_lesson",
    { solution_id: "sol-a", tool: "ateam_test_voice", error: "no audio frames received", supersedes: "lesson_aaaaaaaaaa" },
    { status: 409, body: { ok: false, code: "LESSON_ALREADY_SUPERSEDED", superseded_by: "lesson_bbbbbbbbbb", current: "lesson_cccccccccc", error: 'appendLesson: lesson "lesson_aaaaaaaaaa" was already superseded by "lesson_bbbbbbbbbb"; the current one is "lesson_cccccccccc".' } },
  );
  assert.equal(res.isError, true);
  assert.match(text, /409/);
  assert.match(text, /LESSON_ALREADY_SUPERSEDED/);
  assert.match(text, /the current one is \\?"lesson_cccccccccc\\?"/);
});

test("ateam_get_lessons asks for superseded lessons only when told, beside limit", async () => {
  await call("ateam_get_lessons", { solution_id: "sol-a", limit: 5, include_superseded: true });
  assert.deepEqual(hits.map((h) => h.url), ["/deploy/solutions/sol-a/lessons?limit=5&include_superseded=true"]);
  await call("ateam_get_lessons", { solution_id: "sol-a", include_superseded: false });
  assert.deepEqual(hits.map((h) => h.url), ["/deploy/solutions/sol-a/lessons"]);
});

test("both schemas declare the new fields", () => {
  assert.equal(tool("ateam_log_lesson").inputSchema.properties.supersedes?.type, "string");
  assert.deepEqual(tool("ateam_log_lesson").inputSchema.required, ["solution_id", "tool", "error"]);
  assert.equal(tool("ateam_get_lessons").inputSchema.properties.include_superseded?.type, "boolean");
});

test("both texts quote the ONE correction rule, whole, inside Core's 1200-character cut", () => {
  for (const name of ["ateam_log_lesson", "ateam_get_lessons"]) {
    const desc = tool(name).description;
    assert.ok(desc.length <= CORE_DESCRIPTION_CUT, `${name}: ${desc.length} characters; an in-app agent sees only the first ${CORE_DESCRIPTION_CUT}`);
    assert.ok(desc.includes(LESSON_CORRECTION_RULE), `${name} does not quote the rule`);
  }
  // The log text no longer claims a wrong lesson can only be added to.
  assert.doesNotMatch(tool("ateam_log_lesson").description, /You cannot edit or delete earlier lessons/);
  assert.match(tool("ateam_get_lessons").description, /never listed in `lessons`/);
});

// THE SAME RULE AS THE BUILDER'S, byte for byte (===): the Builder's lessons
// store (apps/backend/src/store/solutions.js LESSON_CORRECTION_RULE) owns the
// behaviour and quotes this text in GET /lessons' `_note`. A change on one side
// fails here until the other carries it too.
const BUILDER_LESSON_CORRECTION_RULE =
  'A lesson that proved WRONG is corrected, never edited: log the corrected lesson with ' +
  'supersedes:"<its id>". The wrong one stays in the history but is no longer returned as a lesson.';
test("LESSON_CORRECTION_RULE is the Builder's, byte for byte", () => {
  assert.equal(LESSON_CORRECTION_RULE, BUILDER_LESSON_CORRECTION_RULE);
});

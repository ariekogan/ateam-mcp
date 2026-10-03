// A WRONG LESSON CAN BE CORRECTED: ateam_log_lesson carries `supersedes`,
// ateam_get_lessons carries `include_superseded`, and both texts say how.
//
// The lessons store (Builder, POST/GET /api/solutions/:id/lessons) owns the
// behaviour: a lesson logged with supersedes:<id> replaces that one, the wrong
// one stays in the history, and GET no longer returns it as a lesson. These
// tools must carry both fields to it — the handler destructured a fixed list,
// so an unlisted field was dropped before any request.
//
// THE RULE ITSELF HAS ONE HOME: the Builder's GET answer, as `correction_rule`.
// The texts declare the arguments and point at that field; nothing here keeps
// a copy of the rule, and no test does either — the one below reads the field
// off a (mocked) GET answer. Whether the texts fit Core's 1200-character cut
// is test/core-description-cut.test.mjs.
//
// Run: node --test test/lesson-supersede.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setSessionCredentials } from "../src/api.js";
import * as toolsModule from "../src/tools.js";

const { handleToolCall, tools } = toolsModule;
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

test("the texts point at the GET's `correction_rule` and declare the arguments — no copy of the rule", () => {
  assert.equal(toolsModule.LESSON_CORRECTION_RULE, undefined, "ateam-mcp keeps a copy of the rule again");
  const log = tool("ateam_log_lesson").description;
  const get = tool("ateam_get_lessons").description;
  assert.ok(log.includes("You cannot edit or delete earlier lessons; supersede them"), log);
  assert.match(log, /`supersedes`/);
  assert.match(log, /`correction_rule`/);
  assert.match(get, /Every answer carries `correction_rule`/);
  assert.match(get, /include_superseded:true/);
  assert.match(get, /never listed in `lessons`/);
  assert.match(tool("ateam_log_lesson").inputSchema.properties.supersedes.description, /`correction_rule`/);
  // The old wording, which said no correction was possible, is gone.
  assert.doesNotMatch(log, /APPEND-ONLY/);
});

test("the rule reaches the caller as the GET answered it — the tool neither drops nor rewrites `correction_rule`", async () => {
  // Whatever the Builder says is the rule is what the agent reads: this
  // mocked answer's value is not the rule, on purpose — the tool must pass
  // the field through, not supply one of its own.
  const answer = { ok: true, lessons: [], count: 0, superseded_count: 0, correction_rule: "the field as the lessons GET answered it" };
  const { res, text } = await call("ateam_get_lessons", { solution_id: "sol-a" }, { status: 200, body: answer });
  assert.equal(res.isError, undefined);
  assert.equal(JSON.parse(text).correction_rule, answer.correction_rule, text);

  // A refused read answers with the field too, and the caller sees it.
  const refused = { ok: false, code: "INVALID_SOLUTION_ID", error: "getLessons: id required (string)", correction_rule: "the field on a refused read" };
  const r = await call("ateam_get_lessons", { solution_id: "sol-a" }, { status: 400, body: refused });
  assert.equal(r.res.isError, true);
  assert.match(r.text, /the field on a refused read/);
});

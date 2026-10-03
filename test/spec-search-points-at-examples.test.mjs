// ateam_spec_search says where a hit is READ — both ways, not one.
//
// 3a23931 (2026-07-19) wrote "then read the full topic via ateam_get_spec(topic)"
// for every hit. A hit that is an EXAMPLE is not a spec topic: /spec/examples/<type>
// is served by ateam_get_examples(type), and ateam_get_spec has no such topic.
// The corpus points at examples both ways: sysSpecSearch indexes /spec topics, and
// their text says things like "see_example: GET /spec/examples/ui-plugin-iframe"
// (Builder spec.js iframe_plugin_guide) — a reader who follows the one sentence the
// description gives asks ateam_get_spec for something it cannot serve and learns
// only the list of topics it does serve. (Core's ingest.js skips slugs that start
// "examples"; the pointer reaches an agent inside hit text, and the description
// covers a topic named examples/<type> as well, for a corpus that indexes them.)
//
// The handler adds nothing to a result but `served_by`: there is no result text
// of ours to correct. The one other place a hit's name lands in our code is
// ateam_get_spec's unknown-topic error, which now says where an examples/<type>
// name is read.
//
// Run: node --test test/spec-search-points-at-examples.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setSessionCredentials } from "../src/api.js";
import { handleToolCall, coreTools } from "../src/tools.js";
import { EXAMPLE_PATHS } from "../src/exampleTypes.js";

const SID = "sess-spec-search-examples";
const paths = [];
let server;

before(async () => {
  server = createServer((req, res) => {
    paths.push(req.url.split("?")[0]);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, { apiKey: "adas_tenanta_00000000000000000000000000000000", apiUrl: `http://127.0.0.1:${server.address().port}`, explicit: true });
});
after(() => server.close());

const description = () => coreTools.find((t) => t.name === "ateam_spec_search").description;

test("the description sends a spec topic to ateam_get_spec and an example to ateam_get_examples", () => {
  const d = description();
  assert.match(d, /ateam_get_spec\(topic\)/);
  assert.match(d, /examples\/<type>/);
  assert.match(d, /ateam_get_examples\(type\)/);
  const examples = d.indexOf("ateam_get_examples(type)");
  assert.ok(examples > d.indexOf("ateam_get_spec(topic)"), "the example pointer must follow the topic pointer it qualifies");
});

test("what the description says is true: an example type is served by ateam_get_examples", async () => {
  paths.length = 0;
  // The type a hit's own text names today ("see_example: GET /spec/examples/ui-plugin-iframe").
  assert.ok("ui-plugin-iframe" in EXAMPLE_PATHS);
  await handleToolCall("ateam_get_examples", { type: "ui-plugin-iframe" }, SID);
  assert.deepEqual(paths, ["/spec/examples/ui-plugin-iframe"]);
});

for (const name of ["examples/ui-plugin-iframe", "/spec/examples/ui-plugin-iframe"]) {
  test(`ateam_get_spec("${name}") names the tool that reads it, and fetches nothing`, async () => {
    paths.length = 0;
    const r = await handleToolCall("ateam_get_spec", { topic: name }, SID);
    assert.equal(r.isError, true);
    const text = r.content[0].text;
    assert.match(text, /ateam_get_examples/);
    assert.doesNotMatch(text, /Unknown spec topic/, "it is an example, not an unknown topic");
    assert.deepEqual(paths, []);
  });
}

test("a genuinely unknown topic still lists the topics that exist", async () => {
  const r = await handleToolCall("ateam_get_spec", { topic: "no-such-topic" }, SID);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Unknown spec topic "no-such-topic"\. Available: .*skill/);
});

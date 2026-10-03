// ateam_create_connector NEVER DESTROYS (CORE). It uploads its scaffold with
// replace:true (575e993: "this is a NEW connector") and never checked that the
// id was new. replace:true deletes every file the upload lacks — from Core, and
// since Builder #121 / #123 from the Builder's source and the repo's working
// branch — so create on an existing id swapped that connector for a skeleton.
// It now asks first, with the read ateam_get_connector_source makes, and refuses
// an id that exists, or one it could not check.
//
// And ateam_upload_connector says what replace:true deletes, inside the
// 1200-character cut Core applies to every tool description an in-app agent
// sees (ai-dev-assistant anthropicAgentBackend.js; ateam_upload_connector is a
// solution-builder bootstrap tool).
//
// Run: node --test test/create-connector-never-destroys.test.mjs
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setSessionCredentials } from "../src/api.js";
import { tools, handleToolCall } from "../src/tools.js";

const SID = "sess-create-never-destroys";
const KEY = "adas_tenanta_00000000000000000000000000000000";
const CORE_DESCRIPTION_CUT = 1200;
/** What the stand-in's GET …/connectors/<id>/source answers, per connector id. */
const SOURCE = {
  "invoice-mcp": [200, { ok: true, connector_id: "invoice-mcp", provenance: "authored_fs", files: [{ path: "server.js", content: "// real" }] }],
  "running-mcp": [404, { ok: false, code: "AUTHORED_SOURCE_MISSING", deployed_in_core: true }],
  "fresh-mcp": [404, { ok: false, code: "AUTHORED_SOURCE_MISSING", deployed_in_core: false }],
  "flaky-mcp": [500, { ok: false, error: "authored store unreadable" }],
};
const requests = [];
let server;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const path = req.url.split("?")[0];
      requests.push({ method: req.method, path, body: body ? JSON.parse(body) : null });
      const src = /\/connectors\/([^/]+)\/source$/.exec(path);
      const [status, reply] = req.method === "GET" && src ? SOURCE[src[1]] : [200, { ok: true, tools: 1 }];
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, { apiKey: KEY, apiUrl: `http://127.0.0.1:${server.address().port}`, explicit: true });
});
after(() => server.close());
beforeEach(() => { requests.length = 0; });

const create = (connector_id) => handleToolCall("ateam_create_connector", { solution_id: "walkmate", connector_id }, SID);
const uploads = () => requests.filter((r) => r.method === "POST" && r.path.endsWith("/upload"));

test("an id with authored source: refused, CONNECTOR_EXISTS, and no upload is sent", async () => {
  const r = await create("invoice-mcp");
  assert.equal(r.isError, true, r.content?.[0]?.text);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.code, "CONNECTOR_EXISTS");
  assert.match(out.error, /already exists .* use ateam_upload_connector/);
  assert.deepEqual(uploads(), [], "create sent the upload that would have replaced the connector");
});

test("an id Core runs with no authored source: refused too — it exists", async () => {
  const r = await create("running-mcp");
  assert.equal(r.isError, true, r.content?.[0]?.text);
  assert.equal(JSON.parse(r.content[0].text).code, "CONNECTOR_EXISTS");
  assert.deepEqual(uploads(), []);
});

test("a new id: created as before — one replace:true upload of the scaffold", async () => {
  const r = await create("fresh-mcp");
  assert.ok(!r.isError, r.content?.[0]?.text);
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.ok, true);
  assert.equal(uploads().length, 1);
  assert.equal(uploads()[0].body.replace, true);
  assert.ok(uploads()[0].body.files.some((f) => f.path === "server.js"));
});

test("the existence check fails: refused with that error — never created blind", async () => {
  const r = await create("flaky-mcp");
  assert.equal(r.isError, true, r.content?.[0]?.text);
  const text = r.content[0].text;
  assert.match(text, /could not tell whether connector "flaky-mcp" already exists/);
  assert.match(text, /authored store unreadable/);
  assert.match(text, /Nothing was created or uploaded/);
  assert.deepEqual(uploads(), [], "a create that could not check went ahead");
});

test("ateam_upload_connector says what replace:true deletes — and where it does not — inside Core's cut", () => {
  const t = tools.find((x) => x.name === "ateam_upload_connector");
  const replaceLine = t.description.split("\n").find((l) => l.includes("replace:true —"));
  assert.ok(replaceLine, "the replace:true mode is not described");
  assert.match(replaceLine, /from Core, from the Builder's source and, when GitHub is connected, from the repo's working branch \(dev\)/);
  // CORE (LOW-MED): the branch loses what the upload leaves out whether Core
  // ever ran it or not — a file written with ateam_github_patch included.
  assert.match(replaceLine, /deployed or not — files written with ateam_github_patch included/);
  assert.match(replaceLine, /Some files are kept — repo\.kept names each with its reason\./);
  assert.match(replaceLine, /Never from main/);
  assert.match(replaceLine, /github:true \+ replace:true leaves the repo as it is/);
  assert.doesNotMatch(t.description, /Wipes connector dir \+ writes only the provided files/, "the old, incomplete claim is still served");
  assert.ok(t.description.length <= CORE_DESCRIPTION_CUT, `${t.description.length} characters; an in-app agent sees only the first ${CORE_DESCRIPTION_CUT}`);
  const param = t.inputSchema.properties.replace.description;
  assert.match(param, /from Core, from the Builder's source and, when GitHub is connected, from the repo's working branch \(dev\)/);
  assert.match(param, /deployed or not, files written with ateam_github_patch included/);
  assert.match(param, /Main is never touched/);
  // CORE on #50: repo.kept also holds regenerated files, binaries and too-large
  // ones — not only files that are not known text. The text names no one kind.
  assert.match(param, /some files are kept — repo\.kept names each with its reason/);
  assert.doesNotMatch(JSON.stringify(t), /not known text is kept/, "the text says only not-known-text files are kept");
  assert.match(param, /With github:true the repo is left as it is/);
});

test("ateam_create_connector says it never replaces, and what it answers instead", () => {
  const d = tools.find((x) => x.name === "ateam_create_connector").description;
  assert.match(d, /Create never replaces/);
  assert.match(d, /refused with CONNECTOR_EXISTS and nothing is uploaded — change it with ateam_upload_connector/);
  assert.match(d, /cannot be read, the create is refused too/);
  assert.ok(d.length <= CORE_DESCRIPTION_CUT, `${d.length} characters`);
});

test("no text names a dev host", () => {
  for (const name of ["ateam_upload_connector", "ateam_create_connector"]) {
    const t = tools.find((x) => x.name === name);
    assert.doesNotMatch(JSON.stringify(t), /dev-api|dev-builder|adas_dev_/, name);
  }
});

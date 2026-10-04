// ateam_get_solution(solution_id, skill_id, section:"tools") must answer what
// the skill can do — every tool its deploy sends — not only skill.json's list.
//
// The section slice (a260068, OPEN-8) read `skill.tools` off the Builder's
// skill read. Since Builder BL-38 a deploy keeps what it imports from the
// skill's connectors in the Builder's deployed state, never in skill.json, and
// the skill read sends it beside the skill as `deployed` (deployed.tools:
// {name, description, connector}). The slice dropped it: a skill whose tools
// all come from its connectors answered `tools: []`, while ateam_github_read's
// description (a4bd04c) tells agents this section is how to answer "what can
// this skill actually do?".
//
// Checked against what the handler sends and answers, with a local stand-in
// that answers the Builder's GET /deploy/solutions/:id/skills/:skillId.
//
// Run: node --test test/skill-tools-section-reads-deployed.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { setSessionCredentials } from "../src/api.js";
import { handleToolCall } from "../src/tools.js";

const SID = "sess-tools-section-deployed";
const KEY = "adas_tenanta_00000000000000000000000000000000";
const own = { name: "notes.add", description: "Add a note" };
/** skill id → what the Builder's skill read answers for it. */
const READS = {
  // Deployed: one tool written in skill.json, two imported from its connector.
  "item-keeper": {
    skill: { id: "item-keeper", connectors: ["items-mcp"], tools: [own] },
    deployed: {
      phase: "DEPLOYED",
      tools: [
        { name: "notes.add", description: "Add a note", connector: null },
        { name: "items.list", description: "List the items", connector: "items-mcp" },
        { name: "items.add", description: "Add an item", connector: "items-mcp" },
      ],
      imported_from: { "items-mcp": ["items.list", "items.add"] },
    },
  },
  // Deployed, but the Builder has not yet migrated its skill.json (BL-38): the
  // file still holds, marked `_auto_imported`, the tool an earlier import wrote.
  "unmigrated": {
    skill: {
      id: "unmigrated", connectors: ["items-mcp"],
      tools: [own, { name: "items.list", description: "List the items", source: { connection_id: "items-mcp" }, _auto_imported: true }],
    },
    deployed: {
      phase: "DEPLOYED",
      tools: [
        { name: "notes.add", description: "Add a note", connector: null },
        { name: "items.list", description: "List the items", connector: "items-mcp" },
      ],
      imported_from: { "items-mcp": ["items.list"] },
    },
  },
  // No deploy recorded, and the file already holds an imported tool.
  "undeployed-with-import": {
    skill: { id: "undeployed-with-import", tools: [own, { name: "items.add", _auto_imported: true }, { name: "items.mark", _auto_imported: false }] },
    deployed: null,
  },
  // Never deployed.
  "fresh-skill": { skill: { id: "fresh-skill", connectors: ["items-mcp"], tools: [] }, deployed: null },
  // A Builder from before BL-38: no `deployed` at all.
  "old-builder": { skill: { id: "old-builder", tools: [own] } },
};
let api;

before(async () => {
  api = createHttpServer((req, res) => {
    const m = /\/deploy\/solutions\/[^/]+\/skills\/([^/?]+)$/.exec(new URL(req.url, "http://x").pathname);
    const body = m && READS[decodeURIComponent(m[1])];
    res.writeHead(body ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body || { error: "Skill not found" }));
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, { apiKey: KEY, apiUrl: `http://127.0.0.1:${api.address().port}`, explicit: true });
});
after(() => api.close());

async function toolsSection(skill_id) {
  const out = await handleToolCall("ateam_get_solution", { solution_id: "list-keeper", skill_id, section: "tools" }, SID);
  const text = out?.content?.[0]?.text;
  return text ? JSON.parse(text) : out;
}
const names = (tools) => (tools || []).map((t) => t.name).sort();

test("a deployed skill: section 'tools' answers every tool its deploy sends, imported ones included", async () => {
  const r = await toolsSection("item-keeper");
  assert.deepEqual(names(r.tools), ["items.add", "items.list", "notes.add"],
    "the section answered skill.json's list, without the tools its connector gives it");
  assert.deepEqual(names(r.authored_tools), ["notes.add"]);
  assert.deepEqual(r.imported_from, { "items-mcp": ["items.list", "items.add"] });
  assert.match(r._note, /imported from its connectors/);
});

test("a skill with no deploy recorded: the file's list, and the note says that is all it is", async () => {
  const r = await toolsSection("fresh-skill");
  assert.deepEqual(r.tools, []);
  assert.match(r._note, /No deploy is recorded/);
});

test("a Builder that sends no deployed state: the file's list, said as such", async () => {
  const r = await toolsSection("old-builder");
  assert.deepEqual(names(r.tools), ["notes.add"]);
  assert.match(r._note, /sent no deployed state/);
});

test("any other section still slices the skill as before", async () => {
  const out = await handleToolCall("ateam_get_solution", { solution_id: "list-keeper", skill_id: "item-keeper", section: "connectors" }, SID);
  const r = JSON.parse(out.content[0].text);
  assert.deepEqual(r.connectors, ["items-mcp"]);
});

// Builder BL-43: authored_tools is "the ones you wrote". A tool the import wrote
// into skill.json (_auto_imported) is not one of them, and ateam_patch on it is
// undone by the next deploy.
test("authored_tools leaves out a tool marked _auto_imported (a skill not yet migrated by BL-38)", async () => {
  const r = await toolsSection("unmigrated");
  assert.deepEqual(names(r.authored_tools), ["notes.add"],
    "authored_tools listed a connector's imported tool as one the author wrote");
  assert.deepEqual(names(r.tools), ["items.list", "notes.add"], "tools = what the deploy sends, imported ones included");
  assert.deepEqual(r.imported_from, { "items-mcp": ["items.list"] });
});

test("with no deploy recorded, authored_tools still leaves the imported tool out; tools is the whole file", async () => {
  const r = await toolsSection("undeployed-with-import");
  assert.deepEqual(names(r.authored_tools), ["items.mark", "notes.add"],
    "only a tool marked _auto_imported:true is left out; _auto_imported:false is the author's");
  assert.deepEqual(names(r.tools), ["items.add", "items.mark", "notes.add"]);
});

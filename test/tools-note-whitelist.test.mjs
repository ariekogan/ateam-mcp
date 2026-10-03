// A SKILL'S tools[] IS A WHITELIST ONCE DEPLOYED — the patch summary says so (RUN5-3).
//
// ad5b085 added `_tools_note` to ateam_patch's summary: "Callable tools =
// tools_declared + ALL tools from linked connectors". Core does the opposite
// whenever tools[] is non-empty (Core 1f2513ff1): it lets the skill call only
// the connector tools its tools[] names. In e2e run 5 a skill's tools[] held
// four tools imported before its connector gained a fifth; the note said the
// fifth was callable, Core refused it, and the skill said it "isn't available".
//
// The note now states the whitelist and points to the one home of the rule —
// the skill spec's how_a_skill_gets_its_tools — instead of keeping a copy. It
// is a skill's note: a solution definition (connectors, no tools[]) gets none.
// And ateam_upload_connector no longer says it never touches a skill: since
// the Builder's RUN5-3 fix it redeploys the skills that import the connector.
//
// Behavioural: the real ateam_patch (dry_run), through the real dispatcher,
// against a local server playing the skill-validator.
//
// Run: node --test test/tools-note-whitelist.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setSessionCredentials } from "../src/api.js";
import { handleToolCall, tools } from "../src/tools.js";

const SID = "sess-tools-note";
const KEY = "adas_tenanta_00000000000000000000000000000000";
const SKILL = {
  id: "skill-a", name: "Skill A", connectors: ["conn-a"],
  tools: [{ name: "list_items" }, { name: "add_item" }],
};
const SOLUTION = { id: "sol-a", name: "Sol A", skills: [{ id: "skill-a" }], linked_skills: ["skill-a"], connectors: [{ id: "conn-a" }] };

let server;
before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const file = url.searchParams.get("path");
    const body = url.pathname === "/deploy/solutions/sol-a/github/read"
      ? { ok: true, content: JSON.stringify(file === "solution.json" ? SOLUTION : SKILL) }
      : null;
    res.writeHead(body ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body || { error: "not served" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, { apiKey: KEY, apiUrl: `http://127.0.0.1:${server.address().port}`, explicit: true });
});
after(() => server.close());

async function dryRun(args) {
  const r = await handleToolCall("ateam_patch", { solution_id: "sol-a", dry_run: true, ...args }, SID);
  return JSON.parse(r.content[0].text);
}

test("a skill with a non-empty tools[]: the note says it is a whitelist, never that every connector tool is callable", async () => {
  const out = await dryRun({ target: "skill", skill_id: "skill-a", updates: { description: "d" } });
  const note = out.after_state_summary?._tools_note;
  assert.ok(note, JSON.stringify(out.after_state_summary));
  assert.deepEqual(out.after_state_summary.tools_declared, ["list_items", "add_item"]);
  assert.match(note, /WHITELIST/);
  assert.match(note, /only the connector tools the deployed tools\[\] names/);
  assert.match(note, /a tool of \[conn-a\] not in it is NOT callable/);
  assert.doesNotMatch(note, /ALL tools from linked connectors|callable via the LINK/i,
    "the ad5b085 claim: a tool tools[] does not name reads as callable");
});

test("the note points at the rule's one home and at the live list — it keeps no copy of the rule", async () => {
  const out = await dryRun({ target: "skill", skill_id: "skill-a", updates: { description: "d" } });
  const note = out.after_state_summary._tools_note;
  assert.match(note, /ateam_get_spec\('skill'\) → agent_guide\.key_concepts\.how_a_skill_gets_its_tools/);
  assert.match(note, /ateam_get_solution\(solution_id, skill_id:"skill-a", section:"tools"\)/);
  assert.doesNotMatch(note, /_auto_imported|imports? .* at deploy/i, "a second statement of how the list is built");
});

test("a solution definition gets no tools note", async () => {
  const out = await dryRun({ target: "solution", updates: { description: "d" } });
  assert.ok(out.after_state_summary, JSON.stringify(out));
  assert.equal(out.after_state_summary._tools_note, undefined);
});

test("ateam_upload_connector says it redeploys the importing skills, and how the reply reports them", () => {
  const d = tools.find((t) => t.name === "ateam_upload_connector").description;
  assert.doesNotMatch(d, /WITHOUT redeploying skills/);
  assert.match(d, /every skill that imports this connector's tools/);
  assert.match(d, /skill_tools/);
  assert.match(d, /A tools\[\] you wrote yourself is never changed/);
});

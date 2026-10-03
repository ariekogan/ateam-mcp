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
// the Builder's RUN5-3 fix it redeploys the skills that import the connector,
// and build_and_run's connector restart (Phase 2.5) reads that upload's
// verdict instead of recording ok:true for every answer (R53-8).
//
// Behavioural: the real ateam_patch (dry_run) and ateam_build_and_run, through
// the real handlers, against a local server or a stubbed fetch playing the
// skill-validator.
//
// Run: node --test test/tools-note-whitelist.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setSessionCredentials } from "../src/api.js";
import { handleToolCall, handlers, tools } from "../src/tools.js";

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

test("the note points at the rule's one home and at the Builder's copy — never 'the live list' — and keeps no copy of the rule", async () => {
  const out = await dryRun({ target: "skill", skill_id: "skill-a", updates: { description: "d" } });
  const note = out.after_state_summary._tools_note;
  assert.match(note, /ateam_get_spec\('skill'\) → agent_guide\.key_concepts\.how_a_skill_gets_its_tools/);
  // That read is the Builder's file, not Core's deployed skill (R53-5): it is
  // never called the live list.
  assert.match(note, /The Builder's copy of the list \(not necessarily what Core runs\): ateam_get_solution\(solution_id, skill_id:"skill-a", section:"tools"\)/);
  assert.doesNotMatch(note, /live list/i);
  assert.doesNotMatch(note, /_auto_imported|imports? .* at deploy/i, "a second statement of how the list is built");
});

test("a solution definition gets no tools note", async () => {
  const out = await dryRun({ target: "solution", updates: { description: "d" } });
  assert.ok(out.after_state_summary, JSON.stringify(out));
  assert.equal(out.after_state_summary._tools_note, undefined);
});

test("ateam_upload_connector says it redeploys the importing skills WHOLE, and points at the rule's one home", () => {
  const d = tools.find((t) => t.name === "ateam_upload_connector").description;
  assert.doesNotMatch(d, /WITHOUT redeploying skills/);
  assert.match(d, /the skills that import this connector's tools are redeployed when they need it/);
  assert.match(d, /a redeploy of the WHOLE skill as the Builder holds it, so its other connectors' tools and any saved edit not yet deployed go live too/);
  assert.match(d, /per skill and per connector, what changed in what Core runs; stages\.skills is its verdict/);
  assert.match(d, /A tools\[\] you wrote yourself is never changed/);
  assert.match(d, /ateam_get_spec\('skill'\) → agent_guide\.key_concepts\.how_a_skill_gets_its_tools\.when_the_connector_changes/);
});

// ─── build_and_run's connector restart reads the upload's verdict (R53-8) ───
async function buildAndRun(uploadAnswer) {
  const origFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || "GET";
    let body = { ok: true };
    if (u.includes("/github/status")) body = { ok: true, repo_url: "https://github.com/x/y" };
    else if (u.includes("/github/pull-bundle")) {
      body = { ok: true, solution: { id: "sol-a", name: "Sol A", skills: [{ id: "skill-a" }] }, skills: [{ id: "skill-a", name: "Skill A" }],
        mcp_store: { "conn-a": [{ path: "server.js", content: "// v2" }] }, skills_found: 1, connectors_found: 1, files_loaded: 1 };
    } else if (u.includes("/validate/solution")) body = { ok: true, errors: [], warnings: [] };
    else if (u.endsWith("/deploy/solution") && method === "POST") body = { ok: true, import: { skills: [], connectors: 1 } };
    else if (u.includes("/connectors/conn-a/upload")) body = uploadAnswer;
    return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  try {
    const result = await handlers.ateam_build_and_run({ solution_id: "sol-a" }, "sid");
    return result.phases.find((p) => p.phase === "connector_restart");
  } finally { global.fetch = origFetch; }
}

test("Phase 2.5: an upload whose skills stage is PARTIAL is not recorded as a clean restart", async () => {
  const phase = await buildAndRun({
    ok: false, overall: "PARTIAL", stages: { authored: "SUCCESS", github: "NOT_RUN", core: "SUCCESS", skills: "PARTIAL" },
    failed_steps: ["skills"], tools: 3,
    skill_tools: { ok: false, skills: [{ skill_id: "skill-a", ok: false, status: "failed", error: "MCP generation failed", changes: {} }], unchanged: [] },
  });
  assert.ok(phase, "build_and_run did not reach the connector restart");
  assert.equal(phase.status, "partial", JSON.stringify(phase));
  assert.equal(phase.connectors[0].ok, false);
  assert.equal(phase.connectors[0].skills, "PARTIAL");
  assert.deepEqual(phase.connectors[0].failed_steps, ["skills"]);
  assert.equal(phase.connectors[0].skill_tools.skills[0].skill_id, "skill-a");
});

test("Phase 2.5: an upload with nothing to refresh stays a clean restart", async () => {
  const phase = await buildAndRun({ ok: true, overall: "SUCCESS", stages: { core: "SUCCESS", skills: "NOT_RUN" }, tools: 3, skill_tools: { ok: true, skills: [], unchanged: ["skill-a"] } });
  assert.equal(phase.status, "done");
  assert.deepEqual(phase.connectors[0], { id: "conn-a", ok: true, tools: 3, skills: "NOT_RUN" });
});

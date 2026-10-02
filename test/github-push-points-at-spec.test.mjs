// WHAT THE GITHUB PUSH WRITES IS THE BUILDER'S TO SAY, ONCE.
//
// ateam_github_push said "Commits the full bundle (solution + skills + connector
// source) atomically" (c98addc, 2026-03-10), ateam_sync_all "push Builder FS →
// GitHub" (94b9bc0), and ateam_build_and_run "on a FIRST deploy (no repo yet)
// creates the GitHub repo and pushes to it" (45010fa). Builder #144 (BL-21)
// makes the push write only what it changes: on a branch that holds the
// solution, every file it reads stays as the branch holds it, and nothing
// reaches it from the Builder's disk but what the branch lacks. A pinned
// tenant's repo is Core's to create, at GitHub connect, never the push's.
//
// The Builder states all of it, when the push runs included, once: /spec
// also_available["POST /deploy/solutions/:solutionId/github/push"]
// (pushFactOneHome.test.js there). Every text here points at it; none keeps
// a copy. This scans EVERY tool's texts — descriptions and parameter
// descriptions — so a copy added to any tool fails here.
//
// Run: node --test test/github-push-points-at-spec.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { tools } from "../src/tools.js";

const CORE_DESCRIPTION_CUT = 1200;
// The Builder's pointer to its one statement.
const PUSH_WRITES_AT = 'ateam_get_spec({ topic: "overview", search: "github/push" })';
const tool = (name) => tools.find((t) => t.name === name);

/** Every served text of every tool: [where, text]. */
function texts() {
  const out = [];
  const walk = (v, where) => {
    if (typeof v === "string") out.push([where, v]);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`);
  };
  for (const t of tools) walk({ description: t.description, inputSchema: t.inputSchema }, t.name);
  return out;
}

// What a copy of the push's behaviour has said, or would say.
const PUSH_CLAIMS = [
  /full bundle/i,
  /(Builder )?FS\s*(→|->)\s*GitHub/i,
  /Builder FS to GitHub/i,
  /auto-creates the repo/i,
  /creates the GitHub repo/i,
  /\bpush\w*\b[^.]*\batomically\b/i,
  /snapshot the current state/i,
  // The /spec statement's own words on when the push runs (B58R-2).
  /runs it after a deploy with inline connector code/i,
];

test("no tool text restates what the push writes, or when it runs", () => {
  const copies = texts()
    .flatMap(([where, text]) => PUSH_CLAIMS.filter((re) => re.test(text)).map((re) => `${where}: ${re}`));
  assert.deepEqual(copies, []);
});

test("the tools whose call is the push point at the Builder's statement", () => {
  for (const name of ["ateam_github_push", "ateam_sync_all"]) {
    assert.ok(tool(name).description.includes(PUSH_WRITES_AT), `${name}: ${tool(name).description}`);
  }
  assert.match(tool("ateam_build_and_run").description, /then ateam_github_push \(when it runs: its \/spec entry\)/);
});

test("'overview' is a topic ateam_get_spec takes, and each changed text reaches an in-app agent whole", () => {
  assert.ok(tool("ateam_get_spec").inputSchema.properties.topic.enum.includes("overview"));
  for (const name of ["ateam_github_push", "ateam_sync_all"]) {
    assert.ok(tool(name).description.length <= CORE_DESCRIPTION_CUT, `${name}: ${tool(name).description.length} characters`);
  }
});

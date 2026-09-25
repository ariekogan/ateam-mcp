// ateam_bootstrap must not contradict itself INSIDE ONE RESPONSE.
//
// The branch model is deliberate: work on `dev`, ateam_github_promote merges
// dev → main, and build_and_run deploys main. bootstrap is the FIRST thing an
// external agent reads — before any tool description — so whatever it says is
// the model the agent builds against.
//
// It said the opposite from 4eced4f (2026-03-21) until 2026-09-23: "Single-
// branch model: ALL changes go directly to 'main'". That was four months after
// promote became a real dev→main merge (7a75479, 2026-05-19) and a month after
// writes moved to dev (6e4470e).
//
// THEN I FIXED FOUR PLACES AND MISSED TWO, which is worse than leaving it
// alone: an external agent's next run got a response that dated its own former
// error in `branching` while `assistant_behavior_contract.always` still ended
// "ALL changes go directly to main" and `when_to_use_what` still called
// promote "Create a checkpoint (safe-* tag)". The disagreement did not get
// resolved — it moved inside a single tool result, where it is harder to
// notice and impossible to reconcile.
//
// So this test walks the WHOLE bootstrap response — and the tool descriptions,
// and the agent doc — and fails on the known PHRASINGS of the old model
// (OLD_MODEL below) wherever they are nested. It is not proof of absence: it
// used to claim it was, and two survivors ("files on main", "create a
// checkpoint (safe point)") shipped green under that claim because no entry
// matched their wording. A new phrasing needs a new entry.
//
// Run: node test/bootstrap-one-branch-model.test.mjs
import { handlers, tools } from "../src/tools.js";
import { renderAgentDocHeader } from "../src/agentDoc.js";

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); failures++; }
};

const boot = await handlers.ateam_bootstrap({}, "boot-test");

/**
 * Every string in the response, with the dotted path that reaches it and the
 * container it sits in. The container matters: developer_loop.steps[5] said
 * "create a checkpoint (safe point)" while the TOOL NAME sat in its sibling
 * `tools` array — neither the text nor the path mentioned promote, so a
 * text-or-path probe could not see it.
 */
function strings(node, path = "", out = [], parent = null) {
  if (typeof node === "string") out.push({ path, text: node, parent });
  else if (Array.isArray(node)) node.forEach((v, i) => strings(v, `${path}[${i}]`, out, node));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) strings(v, path ? `${path}.${k}` : k, out, node);
  }
  return out;
}
const ALL = strings(boot);

console.log("bootstrap is a response, not a pile of strings");
check("it returned something with strings in it", ALL.length > 50, `${ALL.length} strings`);

// The one place allowed to quote the old model is the note that DATES it, and
// it must be recognisable as a quotation of a past error.
const HISTORY_NOTE = /told every first-turn agent the opposite/;

console.log("no surviving claim of the single-branch model");
const OLD_MODEL = [
  { re: /ALL changes go directly to ['"`]?main/i, why: "the single-branch claim" },
  { re: /[Ss]ingle-branch model/, why: "the single-branch label" },
  { re: /only branch/i, why: '"main is the only branch"' },
  { re: /auto-pushes to main/i, why: '"every deploy pushes main"' },
  { re: /commits? (?:here|to main) automatically/i, why: '"patches commit to main automatically"' },

  // ── ADDED 2026-09-24, AND THE REASON MATTERS ──
  // agentDoc.js carried the retired model for months and NOT ONE of the five
  // patterns above matched its wording. The guard existed, ran green, and
  // could not have failed on the surface that mattered most. Widened to the
  // phrasings actually found there, so this set is shaped by what drifted
  // rather than by what I imagined would drift.
  { re: /single-branch/i, why: 'the bare word "single-branch"' },
  { re: /Everything lands on [`'"]?main/i, why: '"everything lands on main directly"' },
  { re: /push origin main/, why: "an instruction to push straight to production" },
  { re: /safe-\*/, why: "the retired safe-* tag format" },
  { re: /checkpoint when green/i, why: "promote framed as a checkpoint rather than a ship" },

  // ── ADDED 2026-09-24 (review c4b68f0079), shaped by the two that escaped ──
  // "Write/create connector files on main" (github_tools.when_to_use_what)
  // matched none of the ten above. `land(s)` is deliberately NOT in this
  // family: ateam_github_sync_from_main correctly says "the moment anything
  // lands on main directly — a hotfix…", and "Everything lands on main" has
  // its own entry above.
  { re: /(?:write|writes|patch(?:es)?|commit(?:s)?|files)[^.]{0,40}\bon [`'"]?main\b/i, why: "a write placed on main" },
  { re: /creates? a checkpoint|checkpoint \(/i, why: "promote framed as creating a checkpoint" },
];
for (const { re, why } of OLD_MODEL) {
  const hits = ALL.filter((s) => re.test(s.text) && !HISTORY_NOTE.test(s.text));
  check(`${why} appears nowhere`, hits.length === 0,
        hits.map((h) => h.path).join(", "));
}

console.log("the TOOL DESCRIPTIONS teach the same model");
// The guard used to walk only the bootstrap response, so the rollback and
// list_versions descriptions went on telling agents to hunt for safe-* tags
// that promote stopped writing on 2026-05-19 (7a75479). One retired-prefix
// mention is legitimate — the owner's back-compat note — and it is exempted
// by its exact text, so a second, hand-written one still fails.
const { BRANCH_WORKFLOW: OWNER } = await import("../src/branchWorkflow.js");
const TOOL_STRINGS = strings(tools);
check("tool descriptions were walked", TOOL_STRINGS.length > 200, `${TOOL_STRINGS.length} strings`);
check("the owner carries the one legitimate back-compat note",
      typeof OWNER.legacy_tag_note === "string" && /safe-\*/.test(OWNER.legacy_tag_note));
const withoutNote = (t) => (OWNER.legacy_tag_note ? t.split(OWNER.legacy_tag_note).join("") : t);
for (const { re, why } of [...OLD_MODEL, { re: /safe-(?:\d{4}|YYYY)/, why: "a retired safe-YYYY-… example tag" }]) {
  const hits = TOOL_STRINGS.filter((s) => re.test(withoutNote(s.text)));
  check(`tools: ${why} appears nowhere`, hits.length === 0,
        hits.map((h) => `${h.path} (${tools[Number(h.path.match(/^\[(\d+)\]/)?.[1])]?.name})`).join(", "));
}
const tagTools = tools.filter((t) => ["ateam_github_rollback", "ateam_github_list_versions"].includes(t.name));
check("rollback and list_versions name the CURRENT tag format",
      tagTools.length === 2 && tagTools.every((t) => t.description.includes(OWNER.tag_format)));

console.log("the AGENT DOC teaches the same model — it is the copy that PERSISTS");
// Bootstrap prose dies with the session. CLAUDE.md is committed into the
// tenant's own repo on every build_and_run and is then read by every future
// agent and human there, including ones that never call ateam_bootstrap. It
// taught the retired model — "Everything lands on `main` directly",
// "git push origin main", "safe-*" — for months, because this guard only ever
// looked at bootstrap.
const AGENT_DOC = renderAgentDocHeader({
  solution: { id: "guard-test" }, skills: [], connectors: [],
});
check("the agent doc rendered", AGENT_DOC.length > 200, `${AGENT_DOC.length} chars`);
check("it still has a dev-workflow section to guard", /## 6\./.test(AGENT_DOC));

for (const { re, why } of OLD_MODEL) {
  check(`agent doc: ${why} appears nowhere`, !re.test(AGENT_DOC));
}
check("agent doc names the write branch", AGENT_DOC.includes("`dev`"));
check("agent doc names the promote tool", AGENT_DOC.includes("ateam_github_promote"));
check("agent doc carries the current tag format", AGENT_DOC.includes("prod-YYYY-MM-DD-NNN"));

console.log("the branch story has ONE owner, importable by both consumers");
// tools.js imports agentDoc.js, so agentDoc cannot import tools back — which is
// exactly why it kept a private copy. The fact now lives in its own module.
const { BRANCH_WORKFLOW } = await import("../src/branchWorkflow.js");
check("BRANCH_WORKFLOW is importable on its own", typeof BRANCH_WORKFLOW === "object");
check("it is frozen", Object.isFrozen(BRANCH_WORKFLOW));
check("the agent doc renders FROM it, not from a copy",
      AGENT_DOC.includes(BRANCH_WORKFLOW.one_line) && AGENT_DOC.includes(BRANCH_WORKFLOW.write_side));

console.log("promote is described as a SHIP, not a checkpoint");
// A tag is a side effect of the merge. Calling it a checkpoint is what left
// agents believing their work was already on main.
// PATH or TEXT. The first cut of this checked only the VALUE for "promote" —
// but `when_to_use_what.ateam_github_promote` has promote in the KEY, so
// restoring the exact string the external agent found ("Create a checkpoint
// (safe-* tag)") slipped straight through. My own mutation caught it.
// …AND ITS CONTAINER. Text-or-path still missed developer_loop.steps[5]: the
// step's description said "create a checkpoint (safe point)" and the tool name
// lived in the sibling `tools` array. A string is about promote when anything
// in the object or array it sits in names promote.
const mentionsPromote = (s) => /promote/i.test(s.text) || /promote/i.test(s.path)
  || (s.parent !== null && /promote/i.test(JSON.stringify(s.parent)));
const checkpointClaims = ALL.filter((s) =>
  mentionsPromote(s) && /creates? a checkpoint|checkpoint \(/i.test(s.text));
check("promote is never called 'create a checkpoint'", checkpointClaims.length === 0,
      checkpointClaims.map((h) => h.path).join(", "));

const safeTag = ALL.filter((s) => /safe-YYYY|safe-\*/.test(s.text) && mentionsPromote(s));
check("promote does not advertise the retired safe-* tag name", safeTag.length === 0,
      safeTag.map((h) => h.path).join(", "));

console.log("the real loop is stated");
const joined = ALL.map((s) => s.text).join("\n");
check("it names dev as where writes land", /lands? on `?dev`?|writes? (?:go to|land on) `?dev`?/i.test(joined));
// It checked for "ONLY ateam_github_promote writes it". That claim was false:
// ateam_github_rollback writes main, and so does any write that names
// ref:'main' (ateam_github_patch's own emergency-hotfix path). The true fact is
// that nothing writes main BY DEFAULT, and promote is how work gets there.
check("it names promote as how work reaches main, and nothing writes main by default",
      /nothing writes it by default/i.test(joined) && /Work reaches it through ateam_github_promote/.test(joined));
check("it says build_and_run deploys MAIN", /build_and_run deploys MAIN|deploys `?main`?/i.test(joined));
check("it warns that skipping promote is silent", /NOT deployed|not live until|is NOT in this deploy|nothing you wrote is running/i.test(joined));

console.log("ONE owner, not several copies");
// The real fix is not "no forbidden phrases" — it is that no section RESTATES
// the model. Six sections used to carry their own prose; now they render from
// BRANCH_WORKFLOW, so changing it moves every surface together or none.
const SRC = await import("node:fs").then((fs) =>
  fs.readFileSync(new URL("../src/tools.js", import.meta.url), "utf8"));
const bootstrapBody = SRC.slice(SRC.indexOf("ateam_bootstrap: async"), SRC.indexOf("ateam_status_all: async"));

// The definition MOVED (2026-09-24) out of tools.js into its own module, because
// a second consumer appeared that tools.js cannot serve: agentDoc.js renders the
// tenant's CLAUDE.md, and tools.js already imports agentDoc — so agentDoc
// importing tools back is a cycle. It kept a private copy instead, and that copy
// taught the retired model for months. Assert the owner is in the shared module
// and that tools.js no longer defines its own.
const OWNER_SRC = await import("node:fs").then((fs) =>
  fs.readFileSync(new URL("../src/branchWorkflow.js", import.meta.url), "utf8"));
check("a single BRANCH_WORKFLOW definition exists, in the shared module",
      /export const BRANCH_WORKFLOW = Object\.freeze\(\{/.test(OWNER_SRC));
check("tools.js imports it rather than redefining it",
      /import \{ BRANCH_WORKFLOW \} from ['"]\.\/branchWorkflow\.js['"]/.test(SRC)
      && !/const BRANCH_WORKFLOW = Object\.freeze/.test(SRC));
check("it is frozen, so no consumer can mutate it for everyone else", /Object\.freeze/.test(OWNER_SRC));

// Every section that speaks about branches must do it THROUGH the owner.
// WHAT THIS DOES AND DOES NOT PROVE: one BRANCH_WORKFLOW reference satisfies a
// section, so a section can render from the owner in one key and restate the
// model in prose two keys away (github_tools did exactly that). The phrasing
// guards above are what catch a restatement; these only catch a section that
// stopped using the owner altogether.
const refs = (bootstrapBody.match(/BRANCH_WORKFLOW\./g) || []).length;
check(`the bootstrap sections render from it (${refs} references)`, refs >= 12);

// Bounds by BRACE MATCHING, not a fixed window. A first cut sliced 2600 chars
// from the section name and reported assistant_behavior_contract as not using
// the owner — because that section is longer than the window. A check that
// silently covers less than it claims is the failure mode this whole exercise
// is about.
const sectionBody = (name) => {
  const at = bootstrapBody.indexOf(`${name}: {`);
  if (at < 0) return null;
  let i = bootstrapBody.indexOf("{", at), depth = 0;
  for (let k = i; k < bootstrapBody.length; k++) {
    if (bootstrapBody[k] === "{") depth++;
    else if (bootstrapBody[k] === "}" && --depth === 0) return bootstrapBody.slice(at, k + 1);
  }
  return null;
};

for (const section of ["branching", "github_tools", "developer_loop", "assistant_behavior_contract"]) {
  const block = sectionBody(section);
  check(`${section} was found in the source`, !!block);
  if (!block) continue;
  check(`${section} renders from the owner rather than restating it`,
        /BRANCH_WORKFLOW\./.test(block), `${block.length} chars scanned`);
}

// The canonical order must be present as an ordered loop, not as prose an
// agent has to reassemble.
const loop = boot.branching?.the_loop;
check("the loop is an ordered list", Array.isArray(loop) && loop.length >= 4);
if (Array.isArray(loop)) {
  const joinedLoop = loop.join(" | ");
  check("  step order is edit → review → ship → deploy",
    /EDIT[\s\S]*REVIEW[\s\S]*SHIP[\s\S]*DEPLOY/.test(joinedLoop), joinedLoop.slice(0, 120));
  check("  and github_tools shows the SAME array, not a paraphrase",
    boot.github_tools?.iteration_workflow?.the_loop === loop ||
    JSON.stringify(boot.github_tools?.iteration_workflow?.the_loop) === JSON.stringify(loop));
}

console.log("the agent doc's git steps work on a repo that has no dev branch yet");
// CAUGHT BY ARIE, not by a test: the first cut told the reader
// `git checkout dev`, which FAILS on a tenant repo that only has `main`.
// ensureDevBranch (Builder githubService.js:836) creates `dev` from `main` on
// the first PLATFORM write, so a repo only ever written by hand does not have
// it. Three live tenant repos were in exactly that state.
//
// A doc that tells an agent to run a command that errors is not a smaller
// defect than one that teaches the wrong model — it just fails louder.
check("step 1 does not assume dev already exists",
      /git checkout dev 2>\/dev\/null \|\| git checkout -b dev/.test(AGENT_DOC),
      "a main-only tenant repo would fail at step 1");
check("and it SAYS why, so the reader is not guessing",
      /may not exist yet/.test(AGENT_DOC) && /ensureDevBranch/.test(AGENT_DOC));
check("no step pushes to the deploy branch",
      !/git push origin main/.test(AGENT_DOC));

console.log("both loops are documented — iterate is not the same as ship");
// WHAT THIS EXISTS FOR: ateam_build_and_run deploys `main` and has no ref
// parameter, so a doc that shows ONLY the ship loop reads as "nothing can be
// tested before production". That is false — ateam_patch and
// ateam_upload_connector deploy to Core from `dev` with no promote — and the
// doc that implied otherwise shipped into a tenant repo. Arie caught it by
// reading the rendered output; no test did.
check("the owner carries the iterate loop", Array.isArray(BRANCH_WORKFLOW.iterate_without_promote)
      && BRANCH_WORKFLOW.iterate_without_promote.length >= 3);
check("it names the tools that deploy without a promote",
      BRANCH_WORKFLOW.iterate_without_promote.join(" ").includes("ateam_patch")
      && BRANCH_WORKFLOW.iterate_without_promote.join(" ").includes("ateam_upload_connector"));
check("the agent doc shows BOTH loops, not just the ship one",
      /Iterate — deploy and TEST without promoting/.test(AGENT_DOC) && /### Ship/.test(AGENT_DOC));
check("the agent doc says build_and_run is the HEAVY path, not the routine one",
      /HEAVY full path/.test(AGENT_DOC));

console.log("developer_loop step 6 is a SHIP, not a checkpoint");
// The guard above only scanned the `branching`/`github_tools` prose. This
// framing survived in developer_loop.steps[6] — the retired wording, in the
// section an agent actually follows.
const dl = boot.developer_loop.steps;
check("step 6 is named Ship", dl[5].action === "Ship", dl[5].action);
check("step 6 does not call promote a checkpoint", !/checkpoint/i.test(dl[5].description));
check("step 6 renders from the owner",
      dl[5].description.includes(BRANCH_WORKFLOW.promote_is_a_ship_not_a_checkpoint));
check("step 5 tells you to test BEFORE shipping", /Test BEFORE you ship/.test(dl[4].description));

console.log("the iterate loop and the ship loop say only true things about each other");
// #19's first cut added the iterate loop and left the old sentences beside it.
// The rendered CLAUDE.md said "Nothing on `dev` is live" a few lines above
// "These deploy to Core from `dev`". Every fact below was checked against the
// Builder. ateam_patch and ateam_redeploy post {async:true}, and the skill
// redeploy route's async exit deploys the BUILDER'S copy of the skill (the
// resolveBranch-iterative read of `dev` is on its sync exit only). That copy
// is `dev` because every Builder save pushes to dev, and because the
// pre-deploy check heals it from dev first: a mirrored deploy keeps GitHub's
// updated_at (Builder #50, gitSync.stampFor), so a hand push to dev wins that
// heal. target:"solution" runs the BULK redeploy of every skill;
// ateam_upload_connector(github:true) deploys the connector's `dev` files and
// leaves skills alone.
const everyText = [...ALL.map((s) => s.text), AGENT_DOC].join("\n");
check("nobody says `dev` is not live — the iterate tools deploy it",
      !/Nothing on `?dev`? is live/i.test(everyText));
check("the silent mistake no longer claims NOTHING you wrote is running (false once ateam_patch ran)",
      !/nothing you wrote is running/i.test(BRANCH_WORKFLOW.the_silent_mistake));
check("  it names the real trap: build_and_run REPLACES what the iterate tools deployed",
      /REPLACES/.test(BRANCH_WORKFLOW.the_silent_mistake)
      && ["ateam_patch", "ateam_upload_connector"].every((t) => BRANCH_WORKFLOW.the_silent_mistake.includes(t)));
check("the agent doc points at a step that exists (there is no numbered step 1 any more)",
      !/in step 1\b/.test(AGENT_DOC) && /Editing files by hand/.test(AGENT_DOC));
check("iterate_note stands on its own — no \"These\" pointing at a list that is not beside it",
      !/^\s*These\b/.test(BRANCH_WORKFLOW.iterate_note) && !/\bThese deploy\b/.test(dl[4].description));
check("ateam_patch's redeploy scope is stated per target: \"solution\" redeploys the WHOLE solution",
      BRANCH_WORKFLOW.iterate_without_promote.some((l) => /target: "solution"/.test(l) && /WHOLE solution/.test(l))
      && BRANCH_WORKFLOW.iterate_without_promote.some((l) => /target: "skill"/.test(l) && /THAT skill/.test(l))
      && !BRANCH_WORKFLOW.iterate_without_promote.some((l) => /ateam_patch\(solution_id, target, updates\)/.test(l)));
{
  // Codex on #19: the rendered lines mixed `solution_id: "x"` with bare
  // placeholders (`c`, `target`, `updates`), so a copied line is not a call.
  const block = AGENT_DOC.slice(AGENT_DOC.indexOf("### Iterate"), AGENT_DOC.indexOf("### Ship"));
  const calls = block.split("\n").filter((l) => /^ateam_\w+\(/.test(l));
  const bare = calls.filter((l) => l.slice(l.indexOf("(") + 1, l.indexOf(")")).split(",").some((a) => !a.includes(":")));
  check("every rendered iterate call names every argument", calls.length >= 4 && bare.length === 0,
        bare.join(" | ") || `${calls.length} calls`);
}
check("developer_loop step 4 is the ITERATE loop, not the ship loop",
      !dl[3].tools.includes(BRANCH_WORKFLOW.promote_tool) && !dl[3].tools.includes("ateam_build_and_run")
      && dl[3].tools.includes("ateam_upload_connector") && dl[3].tools.includes("ateam_patch")
      && !dl[3].description.includes(BRANCH_WORKFLOW.one_line), JSON.stringify(dl[3].tools));
check("  and the ship step is where promote → build_and_run lives",
      dl[5].tools.includes(BRANCH_WORKFLOW.promote_tool) && dl[5].tools.includes("ateam_build_and_run"));
check("the behaviour contract does not call an ateam_patch \"not live yet\"",
      !ALL.some((s) => /After any write, say the change is not live/i.test(s.text)));

console.log("no claim in the same response contradicts the iterate loop (second review of #19)");
// Each of these was in the SAME bootstrap result, or the same rendered
// CLAUDE.md, as the iterate loop, and this file passed with all of them in it.
const CONTRADICTIONS = [
  { re: /for every deploy/i, why: '"main for every deploy" (the iterate tools deploy dev)' },
  { re: /is the ONLY thing that moves work/i, why: '"promote is the ONLY thing that moves work"' },
  { re: /ONLY ateam_github_promote writes/i, why: '"ONLY promote writes main" (rollback and ref:main write it too)' },
  { re: /Nothing reaches `?main`? without a promote/i, why: '"nothing reaches main without a promote"' },
  { re: /github_patch[^.|]{0,60}build_and_run\(github:\s*true\)/i, why: "github_patch → build_and_run(github:true) (refused, or ships main without the patch)" },
  { re: /ALWAYS deploys the `?main`? branch/i, why: '"ALWAYS deploys main" (inline parts deploy as sent)' },
  { re: /auto-pushes to GitHub/i, why: '"auto-pushes to GitHub" (only a first deploy creates and pushes the repo)' },
  { re: /\bCheckpoint \|/, why: 'the tool table calling promote "Checkpoint"' },
  { re: /guaranteed redeploy|always redeploys/i, why: '"ateam_patch always redeploys" (its redeploy can fail; the phase says so)' },
];
const SURFACES = [...ALL.map((s) => ({ where: s.path, text: s.text })),
  ...TOOL_STRINGS.map((s) => ({ where: `tools${s.path}`, text: s.text })),
  { where: "CLAUDE.md", text: AGENT_DOC }];
for (const { re, why } of CONTRADICTIONS) {
  const hits = SURFACES.filter((x) => re.test(x.text));
  check(`${why} appears nowhere`, hits.length === 0, hits.map((h) => h.where).join(", "));
}
check("github_tools.branch renders from the owner (it restated the model, falsely)",
      boot.github_tools.branch === `${BRANCH_WORKFLOW.write_side} ${BRANCH_WORKFLOW.deploy_side}`);
check("iteration_workflow.code_changes tests from dev BEFORE the ship step",
      /upload_connector[\s\S]*Ship[\s\S]*promote/.test(boot.github_tools.iteration_workflow.code_changes),
      boot.github_tools.iteration_workflow.code_changes);
check("the behaviour contract's connector rule is the iterate rule",
      boot.assistant_behavior_contract.always.some((l) => /ateam_github_patch \+ ateam_upload_connector/.test(l)));
check("the silent mistake is a sentence on its own (developer_loop step 6 renders it after another one)",
      /^The silent mistake is /.test(BRANCH_WORKFLOW.the_silent_mistake));
check("  and does not promise a refusal every Builder gives",
      /older Builder deploys it and reports success/.test(BRANCH_WORKFLOW.the_silent_mistake));
check("ateam_redeploy is described as the Builder's copy, refreshed from dev — not as a read of dev",
      BRANCH_WORKFLOW.iterate_without_promote.some((l) => /^ateam_redeploy/.test(l) && /Builder's copy/.test(l) && /refreshes from `dev`/.test(l)));
// Builder #50 decides FS-vs-GitHub by WHICH SIDE CHANGED (its sync records),
// not by updated_at. Three claims follow from that and were missing or false.
check("ateam_redeploy's line says a change on BOTH sides is refused, not picked",
      BRANCH_WORKFLOW.iterate_without_promote.some((l) => /^ateam_redeploy/.test(l) && /ALSO changed/.test(l) && /refused/.test(l)));
// Builder #50 (review round 4): a Builder copy of `main` content dev lacks (a
// hotfix or rollback a build_and_run deployed) is REFUSED until dev has it —
// it is not "kept and carried to dev" (nothing says main's copy is newer), and
// a dev patch does not overwrite it. And ateam_upload_connector has no check.
check("ateam_redeploy's line names main content dev lacks as refused too",
      BRANCH_WORKFLOW.iterate_without_promote.some((l) => /^ateam_redeploy/.test(l) && /`main` content `dev` does not have/.test(l) && /refused/.test(l)));
check("the CLAUDE.md hand-edit paragraph says which tools refuse, and that upload_connector does not",
      /a hand push is\s+pulled in by the pre-deploy check — unless the Builder's copy of that same file also changed[\s\S]{0,400}`ateam_redeploy` and\s+`ateam_patch` refuse to deploy the solution[\s\S]{0,160}`ateam_upload_connector` reads/.test(AGENT_DOC));
check("the CLAUDE.md no longer says every iterate deploy (upload_connector included) is refused",
      !/Then the\s+deploy is refused and names the file instead of picking a side/.test(AGENT_DOC));
{
  const gp = tools.find((t) => t.name === "ateam_github_patch").description;
  check("the ref:'main' hotfix path says to bring dev along, and that iterate deploys refuse the file until then",
        /ref:'main' only for emergency hotfixes[\s\S]*ateam_github_sync_from_main[\s\S]*ateam_redeploy and ateam_patch refuse to deploy the solution/.test(gp));
  check("  and no longer promises the Builder ships the hotfix and writes it to dev",
        !/keeps the hotfix as a change `dev` lacks/.test(gp) && !/ships it and writes it to `dev`/.test(gp));
  check("  and says connector code has no such check",
        /Connector code has no such check: ateam_upload_connector deploys `dev`'s code/.test(gp));
}
check("rollback no longer claims ateam_redeploy undoes it (the Builder refuses the rolled-back files until dev has them)",
      !/ateam_redeploy deploys the rolled-back change again/.test(BRANCH_WORKFLOW.rollback)
      && /ateam_redeploy and ateam_patch refuse to deploy the solution and name the rolled-back files/.test(BRANCH_WORKFLOW.rollback));
check("rollback says ateam_upload_connector deploys dev's code again until the sync",
      /ateam_upload_connector deploys `dev`'s connector code — the rolled-back change — again/.test(BRANCH_WORKFLOW.rollback));
check("rollback says to bring dev along (the iterate tools deploy dev)",
      /ateam_github_sync_from_main/.test(BRANCH_WORKFLOW.rollback)
      && tools.find((t) => t.name === "ateam_github_rollback").description.includes("ateam_github_sync_from_main"));
// Builder #50 (review round 5). The Builder's refusal after a hotfix or a
// rollback is SOLUTION-WIDE — its guard walks every file, so a redeploy of an
// unrelated skill is refused too. "refuse that file" understated it.
check("the iterate refusal after a hotfix/rollback is described as solution-wide, everywhere it is described",
      /refuse to deploy the solution — any skill of it, not only that file's/.test(AGENT_DOC)
      && BRANCH_WORKFLOW.iterate_without_promote.some((l) => /^ateam_redeploy/.test(l) && /every redeploy of the solution is refused/.test(l))
      && /refuse to deploy the solution — any skill of it, not only that file's/.test(tools.find((t) => t.name === "ateam_github_patch").description));
// Builder #50 (review round 5). A Builder save held off dev (or whose push
// failed) is never overwritten by build_and_run: it is refused, 409
// UNPUSHED_BUILDER_CHANGE, and only ateam_github_pull replaces it on purpose.
{
  const bar = tools.find((t) => t.name === "ateam_build_and_run").description;
  check("build_and_run's description names the UNPUSHED_BUILDER_CHANGE refusal and both ways out",
        /UNPUSHED_BUILDER_CHANGE/.test(bar) && /ateam_redeploy writes the Builder's copy to `dev`/.test(bar)
        && /ateam_github_sync_from_main/.test(bar) && /ateam_github_pull replaces the Builder's copy/.test(bar));
  check("ateam_github_pull says it replaces a Builder change that never reached GitHub",
        /REPLACES the Builder's copy[\s\S]*never reached GitHub/.test(tools.find((t) => t.name === "ateam_github_pull").description));
  check("the CLAUDE.md says a save that did not reach dev stays in the Builder and blocks build_and_run",
        /NOT_WRITTEN_TO_GITHUB[\s\S]{0,200}`ateam_build_and_run` is refused\s+\(UNPUSHED_BUILDER_CHANGE\)/.test(AGENT_DOC));
}
check("the upload description names the deployed floor of the merge",
      /files Core ALREADY runs/.test(tools.find((t) => t.name === "ateam_upload_connector").description));
{
  // A handler RESPONSE, not bootstrap: ateam_redeploy's 404 hint told the
  // agent to github_patch and then build_and_run(solution_id, github:true).
  const at = SRC.indexOf("Skill not found in Builder storage.");
  check("ateam_redeploy's not-found hint does not route through build_and_run(github:true)",
        at > 0 && !/build_and_run\(solution_id, github: ?true\)/.test(SRC.slice(at, at + 400)));
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

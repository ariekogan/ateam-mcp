// src/branchWorkflow.js
// THE ONE OWNER OF THE BRANCH STORY.
//
// It lived in tools.js, which was correct until a SECOND consumer appeared that
// tools.js cannot serve: agentDoc.js renders CLAUDE.md into each tenant's own
// repo, and tools.js already imports agentDoc.js — so agentDoc importing tools
// back is a cycle. It kept its own copy instead, and that copy still taught the
// RETIRED single-branch model ("Everything lands on `main` directly",
// "git push origin main", "checkpoints via safe-* tags") months after the model
// was retired.
//
// That copy was the worst of the seven, because it is the only one that
// PERSISTS: bootstrap prose dies with the session, but CLAUDE.md is committed
// into the tenant repo on every build_and_run and is then read by every future
// agent and human there — including ones that never call ateam_bootstrap. It
// instructed readers to push straight to `main`, which is production and which
// only ateam_github_promote may write.
//
// So the fix is not to edit the string. It is to give the fact one home that
// BOTH consumers can import. Adding a field here reaches the tool surface and
// the tenant's CLAUDE.md at once; editing either copy in place is how this
// drifted for months.

export const BRANCH_WORKFLOW = Object.freeze({
  write_branch: 'dev',
  deploy_branch: 'main',
  promote_tool: 'ateam_github_promote',
  tag_format: 'prod-YYYY-MM-DD-NNN',
  // The prefix promote wrote before 7a75479 (2026-05-19). It no longer writes
  // it, but older solutions still carry such tags and rollback accepts them —
  // so the tools that LIST and TARGET tags say so ONCE, here, instead of each
  // naming the retired prefix as the thing to look for (which they did).
  legacy_tag_note: 'Solutions older than 2026-05-19 may also carry retired safe-* tags; rollback accepts those too.',

  one_line:
    'edit on `dev` → review the diff → ateam_github_promote → `main` → ateam_build_and_run deploys `main`',

  loop: Object.freeze([
    '1. EDIT    ateam_github_patch / ateam_github_write / ateam_patch   → lands on `dev`',
    '2. REVIEW  ateam_github_promote(solution_id, dry_run:true)         → shows exactly what would ship',
    '3. SHIP    ateam_github_promote(solution_id)                       → merges dev → main, tags prod-YYYY-MM-DD-NNN',
    '4. DEPLOY  ateam_build_and_run(solution_id)                        → deploys `main`',
  ]),

  // "Nothing on `dev` is live" used to end this line, a few lines above the
  // iterate loop that deploys `dev` to Core. Both were rendered into the same
  // CLAUDE.md. What is true: a repo-only write deploys nothing, and ateam_patch
  // deploys what it patched.
  write_side: 'Every write lands on `dev`: ateam_github_patch, ateam_github_write and ateam_patch all default there. '
    + 'ateam_github_patch and ateam_github_write only change the repo; nothing is deployed until a deploy tool runs. '
    + 'ateam_patch also redeploys what it patched, from `dev`.',
  // It said "ONLY ateam_github_promote writes it" and, in write_side, "Nothing
  // reaches `main` without a promote". Two writes do: ateam_github_rollback
  // (this same doc says it adds a commit on main), and any write that names
  // ref:'main' (ateam_github_patch documents that as the emergency hotfix).
  // Both are deliberate, which is the point: nothing lands on main BY DEFAULT.
  deploy_side: '`main` is production, and nothing writes it by default. Work reaches it through ateam_github_promote; '
    + 'the only other writes are deliberate ones: ateam_github_rollback, and a write that names ref:"main" (the emergency hotfix path). '
    + 'ateam_build_and_run(solution_id) deploys `main` and has no ref parameter; a part you pass it inline (solution, skills, mcp_store) deploys as you sent it.',
  // It used to say "NOTHING you wrote is running". That is false the moment
  // ateam_patch has run: it deploys from `dev`. The real trap is the next step.
  // build_and_run then deploys `main` over what was just tested.
  //
  // A whole sentence on purpose: developer_loop step 6 renders it after
  // "…deploys `main`.", where a bare "Running X before promoting." read as a
  // fragment. And it does not promise the refusal everywhere: a Builder from
  // before MAIN_BEHIND_DEV deploys and reports success, and this client is
  // rolled out before the Builder.
  the_silent_mistake:
    'The silent mistake is running ateam_build_and_run before promoting. It deploys `main`, so whatever is still only on `dev` is NOT in this deploy, '
    + 'and it REPLACES what ateam_patch, ateam_upload_connector or ateam_redeploy had already deployed from `dev`: the change you just tested disappears from Core. '
    + 'A current Builder refuses that deploy with MAIN_BEHIND_DEV, naming the files `dev` changed that it would take from `main`; an older Builder deploys it and reports success. Promote first either way.',
  // Deliberately does NOT quote the wrong framing. An earlier version said
  // 'calling it "create a checkpoint" is what left agents believing…' — which
  // put the misleading phrase back into the very response meant to retire it,
  // where a first-turn agent reads it before the correction lands.
  promote_is_a_ship_not_a_checkpoint:
    'ateam_github_promote SHIPS: it merges dev → main, which is what makes your work deployable. The prod-YYYY-MM-DD-NNN tag it writes is a side effect for rollback, not the reason to call it.',
  // THE ITERATION LOOP, which is NOT the ship loop and kept being mistaken for it.
  //
  // ateam_build_and_run deploys `main` and has no ref parameter, so reading the
  // ship loop alone leaves you believing NOTHING can be tested before it is in
  // production. That is false, and the doc that said it shipped into a tenant
  // repo. ateam_patch and ateam_upload_connector deploy to Core from `dev`
  // WITHOUT a promote — that is how you test before shipping.
  //
  // Every argument is NAMED, so a line copied from the rendered CLAUDE.md is a
  // valid call once the <placeholders> are filled in. agentDoc fills in
  // solution_id. The scope of each redeploy is stated because it differs:
  // target:"solution" redeploys the whole solution, not one skill.
  iterate_without_promote: Object.freeze([
    'ateam_patch(solution_id, target: "skill", skill_id: "<skill-id>", updates: {…}) — writes `dev`, then redeploys THAT skill from `dev`',
    'ateam_patch(solution_id, target: "solution", updates: {…}) — writes `dev`, then redeploys the WHOLE solution, every skill, from the Builder\'s copy of `dev`',
    'ateam_upload_connector(solution_id, connector_id: "<connector-id>", github: true) — deploys that connector\'s code from `dev`, laid over the files Core already runs for it; skills untouched',
    'ateam_redeploy(solution_id, skill_id: "<skill-id>") — redeploys one skill from the Builder\'s copy, which the pre-deploy check first refreshes from `dev` (a change pushed to `dev` by hand or by ateam_github_patch is picked up; if the Builder\'s copy of that file ALSO changed since the two last agreed, the redeploy is refused and names the file rather than pick a side); no definition change',
    'then test with ateam_conversation / ateam_test_skill / ateam_test_voice against the running solution',
  ]),
  // Self-contained on purpose. It opened with "These deploy…" and was also
  // rendered into developer_loop step 5, where no list precedes it.
  iterate_note:
    'ateam_patch, ateam_upload_connector and ateam_redeploy deploy to Core from `dev` without touching `main`: test there, and promote when it is right. '
    + 'ateam_build_and_run is the HEAVY full path (the first deploy, or deploying `main` after a promote) and it deploys `main`. '
    + 'On a solution with 5+ skills it can hit the 100s edge timeout, which is the other reason not to reach for it every iteration.',

  // Rollback writes `main` only. A deploy used to paper over that by writing
  // what it deployed back to `dev`; since Builder #50 it does not. The Builder
  // now keeps the rolled-back copy as a change `dev` lacks (its sync record),
  // so a plain ateam_redeploy no longer undoes the rollback — but `dev` still
  // holds the rolled-back change, and an edit of that file ON dev builds on it.
  rollback: 'ateam_github_rollback(solution_id, target) rolls `main` back to a previous prod-* tag or SHA. Additive: it creates a new commit and preserves history. '
    + 'Then ateam_build_and_run(solution_id) deploys it, and ateam_github_sync_from_main(solution_id) brings `dev` along: otherwise `dev` still holds the rolled-back change, and the next edit of that file on `dev` (ateam_patch, ateam_github_patch) deploys it again.',
  no_git_at_all:
    'A tenant with no repo connected works entirely on the Builder\'s own store — no branches, no promote. ateam_patch(source:\'local\') is the explicit form. Connect a repo later and writes start landing on `dev` from that point on.',
});

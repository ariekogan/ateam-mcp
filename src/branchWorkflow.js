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

  write_side: 'Every write lands on `dev`: ateam_github_patch, ateam_github_write and ateam_patch all default there. Nothing on `dev` is live.',
  deploy_side: '`main` is production, and ONLY ateam_github_promote writes it. ateam_build_and_run deploys `main` — there is no ref parameter.',
  the_silent_mistake:
    'Skipping the promote. Your patches succeed, build_and_run reports success, and NOTHING you wrote is running — because `main` never moved. ' +
    'If a deploy behaves as though your changes do not exist, that is this. ateam_build_and_run now refuses with MAIN_BEHIND_DEV and names the tool rather than letting you find out by reading a diff.',
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
  iterate_without_promote: Object.freeze([
    'ateam_patch(solution_id, target, updates)     — skill/solution definition: writes `dev` AND redeploys that skill to Core',
    'ateam_upload_connector(solution_id, c, github:true) — connector code: deploys the `dev` state, skills untouched',
    'ateam_redeploy(solution_id, skill_id)         — redeploy one skill with no definition change',
    'then ateam_conversation / ateam_test_skill / ateam_test_voice against the running solution',
  ]),
  iterate_note:
    'These deploy to Core from `dev` without touching `main`. Test here, promote when it is right. '
    + 'ateam_build_and_run is the HEAVY full path (first deploy, or a multi-file change) and it deploys `main` — '
    + 'on a solution with 5+ skills it can hit the 100s edge timeout, which is the other reason not to reach for it every iteration.',

  rollback: 'ateam_github_rollback(solution_id, target) rolls `main` back to a previous prod-* tag or SHA. Additive: it creates a new commit and preserves history.',
  no_git_at_all:
    'A tenant with no repo connected works entirely on the Builder\'s own store — no branches, no promote. ateam_patch(source:\'local\') is the explicit form. Connect a repo later and writes start landing on `dev` from that point on.',
});

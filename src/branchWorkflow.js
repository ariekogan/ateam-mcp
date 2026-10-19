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
  // A chat agent with no shell (ChatGPT, Claude.ai) edits many files with real commands in a workspace instead of
  // one file per call. Plain words by design: the user of such an agent is a business user, so this text
  // names no branch, commit or other git term, and tells the agent to show the user none.
  workspace: 'No shell of your own? ateam_workspace_open gives you one workspace for this conversation: your files are in /workspace and ateam_workspace_exec runs any command there. '
    + 'The other ateam_* tools cannot see your edits until ateam_workspace_save; only saving makes them live. '
    + 'While it is open the single-file write tools are switched off; ateam_workspace_close brings them back. '
    + 'Show the user only each answer\'s `summary`, never branches, commits or git words. A refusal lists the single-file tools to use instead: use them.',
  // It said "ONLY ateam_github_promote writes it" and, in write_side, "Nothing
  // reaches `main` without a promote". One write does: any write that names
  // ref:'main' (ateam_github_patch documents that as the emergency hotfix).
  // It is deliberate, which is the point: nothing lands on main BY DEFAULT.
  // (ateam_github_rollback no longer writes main: going back is a Restore onto dev, then a promote.)
  deploy_side: '`main` is production, and nothing writes it by default. Work reaches it through ateam_github_promote; '
    + 'the only other write is a deliberate one: a write that names ref:"main" (the emergency hotfix path). Going back to an older version is a Restore onto `dev`, then a promote. '
    + 'ateam_build_and_run(solution_id) deploys `main`; pass ref (a branch, tag or commit) to deploy exactly that commit of the bound repository instead. A part you pass it inline (solution, skills, mcp_store) deploys as you sent it, and cannot be combined with ref.',
  // WITH GIT, OR WITHOUT (git plan A5). The Git path is the preferred one for an
  // agent that can run Git; the ateam_github_* tools are the fallback, not a
  // second flow: both write the same `dev` and both end in the same promote.
  // Every tool named here exists (ateam_get_repository_binding, ateam_inspect_data,
  // ref on ateam_build_and_run, `running` on ateam_get_solution status/health).
  git_or_tools:
    'If you can run Git, clone the repository and use it: ateam_get_repository_binding(solution_id) says which repository (clone_url, development and production branch); '
    + 'commit and push to `dev`, then deploy that exact commit with ateam_build_and_run(solution_id, ref: "<sha>"). '
    + 'ateam_get_solution(solution_id, view: "status" or "health") shows the commit that is running (`running`). '
    + 'ateam_inspect_data reads what is stored (read-only, this workspace only; it may be switched off, DATA_INSPECT_DISABLED). '
    + 'If you cannot run Git, or the clone is refused, use the ateam_github_* tools: they write the same `dev` branch. '
    + 'Either way `main` changes only by an explicit ateam_github_promote, and no tool here hands out a GitHub token: never ask for one or put one in the chat.',
  // What ref does to a commit that is NOT main's tip, stated once and rendered
  // into the schema text, bootstrap and CLAUDE.md. Facts, from the Builder's
  // refDeployVerdict / replaceFoldersWithCommit: it warns instead of refusing
  // (you named the commit), writes nothing to the repository, and what Core runs
  // is the commit's files.
  ref_deploy_note:
    'ref deploys exactly one commit: it is resolved once to a SHA of this workspace\'s own repository (another repository is refused) and `deployed_commit` names it. '
    + 'Main\'s tip deploys as a call without ref does. Any other commit (a `dev` commit you pushed, an older prod-* tag) is deployed as you named it and the answer WARNS (deploy.warnings, REF_DEPLOY): '
    + 'whether the commit is part of `main`, and which files `dev` changed that it lacks, which replaces what an earlier deploy from `dev` put in Core. '
    + 'It never pushes to `dev` or `main` and writes no CLAUDE.md; the connector files Core runs are the commit\'s files and no others (connector_files_removed lists any it dropped). '
    + 'Deployed is not shipped: a commit that is not part of `main` is still not production, and the next ateam_build_and_run without ref deploys `main` over it.',
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
    'ateam_github_promote SHIPS: it moves main forward to the exact version tried on dev, which is what makes your work deployable. The prod-YYYY-MM-DD-NNN tag it writes is a side effect for rollback, not the reason to call it.',
  // THE ITERATION LOOP, which is NOT the ship loop and kept being mistaken for it.
  //
  // ateam_build_and_run deploys `main` unless it is given a ref, so reading the
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
    'ateam_redeploy(solution_id, skill_id: "<skill-id>") — redeploys one skill from the Builder\'s copy, which the pre-deploy check first refreshes from `dev` (a change pushed to `dev` by hand or by ateam_github_patch is picked up; if the Builder\'s copy of that file ALSO changed since the two last agreed, or holds `main` content `dev` does not have — a hotfix or rollback a build_and_run deployed — every redeploy of the solution is refused, not only that file\'s, and names the file rather than pick a side); no definition change',
    'then test with ateam_conversation / ateam_test_skill / ateam_test_voice against the running solution',
  ]),
  // Self-contained on purpose. It opened with "These deploy…" and was also
  // rendered into developer_loop step 5, where no list precedes it.
  iterate_note:
    'ateam_patch, ateam_upload_connector and ateam_redeploy deploy to Core from `dev` without touching `main`: test there, and promote when it is right. '
    + 'ateam_build_and_run is the HEAVY full path (the first deploy, or deploying `main` after a promote) and it deploys `main`. '
    + 'On a solution with 5+ skills it can hit the 100s edge timeout, which is the other reason not to reach for it every iteration.',

  // CHANGES AS CARDS (Dev Studio). The whole text has ONE home, the Builder's
  // /spec/solution -> change_cards; this is the outside agent's short version and
  // a pointer, not a copy of the rules. The outside agent has no card tools.
  changes_as_cards:
    'An owner or admin can ask the Builder chat to put a change on the board as a card; the Builder files it and hands it to Dev Desk, which runs it on `dev` (the board groups cards in phases such as Current sprint and Backlog; an Activity screen shows what runs and what waits for the person) and tells the card\'s owner when a run reports or is treated as stopped. '
    + 'ateam-mcp has no card tools: you cannot file, start or approve a card; keep working on `dev` with the ateam_* tools. '
    + 'The whole text: ateam_get_spec({ topic: "solution", search: "change_cards" }).',

  // Rollback writes `main` only. A deploy used to paper over that by writing
  // what it deployed back to `dev`; since Builder #50 it does not. The Builder
  // records the rolled-back copy as `main` content `dev` does not have (its
  // sync record), and refuses to deploy the solution from the Builder until
  // `dev` has it too (its guard walks every file) — neither shipping dev's copy
  // over the rollback nor writing the rollback over dev. ateam_upload_connector reads `dev` directly and has no
  // such check.
  rollback: 'Production is never rolled back directly. To go back: find a prod-* tag with ateam_github_list_versions, put that version back on `dev` with ateam_github_rollback(solution_id, target) (the Restore button in the A-Team app does the same), try it, then ateam_github_promote.',
  no_git_at_all:
    'A tenant with no repo connected works entirely on the Builder\'s own store — no branches, no promote. ateam_patch(source:\'local\') is the explicit form. Connect a repo later and writes start landing on `dev` from that point on.',
});

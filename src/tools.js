/**
 * A-Team MCP tool definitions and handlers.
 *
 * Tools are split into two tiers:
 *   - Core tools (core: true)  — shown in tools/list, the simplified developer loop
 *   - Advanced tools (core: false) — hidden from tools/list, still callable by name
 *
 * Core loop: bootstrap → auth → get_spec/examples → build_and_run → test → patch → test → done
 */

import {
  get, post, patch, del,
  setSessionCredentials, isExplicitlyAuthenticated,
  getCredentials, parseApiKey, whoami, baseUrlForKeyEnv, envForBaseUrl, touchSession, getSessionContext,
  setAuthOverride, switchTenant, runAsTenant, isMasterMode, listTenants, getWhere, getBaseUrl, resetPlatformSession,
  servedBy, KEY_ENVIRONMENTS, signInContext, sessionEnvironment, beginSignIn, shownBase, envApiKeyPresent,
} from "./api.js";

// Mutating / stateful tools whose result should carry a `_where` stamp
// (tenant + the app URL to view the change). ateam-mcp is a PUBLIC MCP used
// from non-desktop clients too, so the location must live IN the tool result
// — not only in a desktop plugin's SKILL.md. Read-only/global tools skip it.
// Tools that START a run and therefore MINT the actor that ran it. Only these
// may rebind the session's actor — see the call site for what accepting it from
// any result cost.
const ACTOR_MINTING_TOOLS = new Set([
  "ateam_conversation",
  "ateam_test_skill",
  "ateam_solution_chat",
  "ateam_test_pipeline",
  "ateam_test_voice",
]);

const STAMP_WHERE_TOOLS = new Set([
  "ateam_build_and_run", "ateam_patch", "ateam_upload_connector", "ateam_redeploy",
  "ateam_create_skill", "ateam_create_connector", "ateam_create_plugin",
  "ateam_delete_skill", "ateam_delete_connector", "ateam_delete_solution",
  "ateam_github_patch", "ateam_github_write", "ateam_github_push",
  "ateam_github_promote", "ateam_github_rollback",
  "ateam_test_skill", "ateam_test_pipeline", "ateam_test_connector", "ateam_test_notification",
  "ateam_verify_surface",
]);

// ─── Signing in, switching workspace, and which environment ────────────────
//
// The steps live in signInSteps.js, ONE statement rendered word for word here,
// in the auth gate, in every not-in-this-workspace refusal and in the server
// instructions. It replaced SIGN_IN_IN_THE_BROWSER (0f5f4d3, MGAP-A1), which
// said how to sign in but not which workspace a session was on or how to move.
//
// MGAP-A31: since bff5934 the key picks its API, and `url` is only for a host
// that is not A-Team's own. PUBLIC TEXT NAMES PRODUCTION ONLY (Arie,
// 2026-10-01): this line listed every KEY_ENVIRONMENTS entry with its host.
// KEY_ENVIRONMENTS itself, and every route it decides, are unchanged.
const KEY_PICKS_ENVIRONMENT =
  `An A-Team key names its own API, so it needs no url (adas_prod_… → ${KEY_ENVIRONMENTS.prod}).`;

/**
 * The opening of ateam_bootstrap and of the server instructions: where THIS
 * session is and how it moves, from what it really holds (api.js
 * signInContext). One composition for both surfaces; `transport` is for the
 * caller outside a tool call (createServer).
 */
export function openingFor(sessionId, opts) {
  return sessionOpening(signInContext(sessionId, opts));
}

/**
 * Why the API refused a key given to ateam_auth, built AFTER beginSignIn put
 * the session back — from the error's status and body, for the session as it
 * now stands. The request layer built err.message while the unverified key was
 * still in the session, so a session that had never signed in was told that
 * "the key this session signed in with" may have been rotated, with switch
 * steps. A failure with no HTTP answer (a timeout) keeps its own message.
 */
function signInRefusal(err, base, sessionId, path = "/deploy/solutions") {
  if (!err?.status) return err?.message || String(err);
  return formatError("GET", path, err.status, err.body, base, { read: true, signIn: signInContext(sessionId), refusedSignIn: true });
}

// ─── A discovered UI plugin needs no declaration ────────────────────────────
//
// MGAP-A29 (+ the connectors[] half of A13). ateam_create_plugin's description
// (02d4321) and its next_steps (3e7c8c0) said "Then declare it at solution
// ui_plugins[]". Two months earlier the Builder's Phase 5 had started MERGING
// what it discovers into solution.ui_plugins[] on every deploy ({...disc,
// ...prev}, Builder 7ebab07, routes/deploy.js), so the instruction produced a
// hand-copied second manifest — and a partial one silently replaced the
// discovered render. One statement, rendered in both places.
//
// WHEN IT HAPPENS (CHECK A, Run 5, 2026-10-03). The texts said "At deploy,
// Phase 5 discovers plugins" (02d4321) and "every deploy" (0f5f4d3). An in-app
// builder then logged the lesson "the plugin list is only populated during
// ateam_build_and_run Phase 5 … must promote", and every later run read it
// first. What the code does (Builder origin/dev dd24337e, Core 3a9ba8f13): the
// Builder's introspection runs in the full deploy (POST /deploy/solution —
// ateam_build_and_run, ateam_deploy_solution) on EVERY run (the Builder has a
// TEST-ONLY switch, solution._skip_introspection, deploy.js; it is deliberately
// not taught in any served text), and in the
// whole-solution redeploy only while ui_plugins is empty; the connector upload
// and a one-skill redeploy never run it. Core (cp.listContextPlugins) asks
// every connected connector the solution uses for its ui.listPlugins live, so a
// running connector's plugin is listed with no deploy at all; a connector not
// started yet is listed from the recorded solution.ui_plugins[] alone.
const PLUGIN_LISTED_LIVE =
  "Core lists a running connector's plugins live, so ateam_upload_connector needs no deploy and no promote to show one.";
const DISCOVERED_PLUGIN_IS_MERGED =
  "Nothing to declare: ateam_build_and_run's deploy, on every run, calls ui.listPlugins + ui.getPlugin on each connector listed in platform_connectors or in a skill's connectors[] " +
  "(list this connector in the skill that opens the plugin) and MERGES each plugin it finds into solution.ui_plugins[], a shallow merge in which the fields you set yourself win. " +
  "Add a solution.ui_plugins[] entry only to override surface, roles or uiActions, or for a runtime:'device' connector, which is never introspected; " +
  "do not restate render, native or stateDomains (a partial render replaces the discovered one whole). " +
  "A skill opens the plugin with sys.focusUiPlugin — see ateam_get_spec(topic:'widgets').";

// Tools whose top-level `ok` is the ANSWER of a probe that ran, not whether the
// call worked. Their owners say so: ateam_verify sets ok = "no gaps found";
// ateam_verify_surface hands the probe's negative verdict back as a result on
// purpose (its handler); Core's connector.logs answers ok:false for a connector
// with no stdio process and says "Not a fault". handleToolCall flagged every
// top-level ok:false as isError, so each of these read as a BROKEN CALL when it
// had worked and found something. A verdict tool's call failed only when it says
// so in `error` (mcpFailure.isLogicalFailure).
//
// THAT IS AN OBLIGATION ON EACH HANDLER, not a property of the payloads: a probe
// that could not run must set `error`, or it reads as an answer. ateam_verify
// sets it when any check could not run (a refused or failed Builder read);
// ateam_verify_surface sets it for every verdict but "surface_failed"; Core's
// connector.logs already puts its refusal in `error`. A tool added here without
// that turns a failed call — a rotated key, a Builder 5xx — into a verdict.
//
// Not ateam_verify_consistency: its answer is `consistent`, and `ok` is true on
// every probe that ran (Builder routes/deploy.js /verify, since 9e51bef).
const VERDICT_TOOLS = new Set([
  "ateam_verify",
  "ateam_verify_surface",
  "ateam_connector_logs",
]);
import { renderAgentDocHeader, mergeAgentDoc, AGENT_DOC_SENTINEL } from "./agentDoc.js";
import { BRANCH_WORKFLOW } from './branchWorkflow.js';
import { EXAMPLE_PATHS, EXAMPLE_TYPES } from './exampleTypes.js';
import { deriveErrorCode, isLogicalFailure } from "./mcpFailure.js";
import { ATTACHMENTS_INPUT_SCHEMA, prepareTestAttachments } from "./testAttachments.js";
// Who a test job runs as: ONE pointer to the Builder's /spec, never a copy of its words.
import { TEST_RUNS_AS_AT } from "./testRunsAs.js";
// Signing in and switching workspace: ONE statement of the steps, rendered where it is read.
import { connectSteps, NO_KEY_IN_CHAT, notInThisWorkspace, sessionOpening } from "./signInSteps.js";
// The ONE list of tools that need no sign-in; every other tool is gated (handleToolCall).
import { PUBLIC_TOOLS, NO_SIGN_IN_NEEDED } from "./publicTools.js";
import { isTimeoutError, jsonBodyOf, jsonVerdictOf, callTransport, formatError, personRefused } from "./api.js";

// A step that waits for a person: the Builder's human_step_testing words, verbatim.
import { WAITING_ON_THE_USER, PLAY_THE_PERSON, TEST_CONNECTOR_NEVER } from "./humanStep.js";
import { apiPath, pathSeg, rawQuery } from "./pathParam.js";
import { createHash, randomUUID } from "node:crypto";

// Where a connector's data goes and who is calling — the Builder's ONE
// decision (capabilitySpecs.js CONNECTOR_STORAGE_DECISION_AT, the same words).
// ateam-mcp POINTS at it; it never carries a copy of the decision or of store().
const STORAGE_DECISION_AT = "ateam_get_spec('connector-multi-user') → storage_decision";

// Where a plugin's data rules are read WHOLE — the Builder's DATA_FIDELITY_AT
// (uiPluginRules.js), the same call. /spec/widgets is larger than one
// ateam_get_spec response (MAX_RESPONSE_CHARS below; 53,368 characters
// pretty-printed on production, 2026-10-02), so a plain read stubs its largest
// section, `sections`, and data_fidelity with it. `search` goes to
// GET /spec/widgets?search=…, which returns the matching branch whole: 7,494
// characters, with MEANING_FIELDS_RULE, ACTIONABLE_STATE_RULE and the
// TEST_ROW_DONE_RULE that MEANING_FIELDS_RULE ends with. ateam-mcp POINTS at
// those rules; it carries no copy.
const DATA_FIDELITY_AT = 'ateam_get_spec({ topic: "widgets", search: "data_fidelity" })';

// WHERE THE BUILDER STATES WHAT ateam_github_push WRITES — /spec
// also_available, read by its search form (Builder #144, BL-21).
const PUSH_WRITES_AT = 'ateam_get_spec({ topic: "overview", search: "github/push" })';

/**
 * build_and_run's answer when pull-bundle refused. A refusal that names its
 * `code` is the Builder's verdict: its error, hint and recovery go through as
 * they are (CORE on #58, B58R-3). The guess "the repo may not exist yet —
 * deploy with mcp_store first" contradicted those (a branch that could not be
 * read, a file that does not parse) and sent the agent to re-send connector
 * code inline. It stays only for an answer with no code (a 404 with no repo).
 * @param {{ code?: string, error?: string, hint?: string, recovery?: string }} said
 * @param {string} error
 */
function pullRefused(said, error) {
  if (typeof said.code === "string" && said.code) {
    return {
      ok: false,
      phase: "github_pull",
      code: said.code,
      error: said.error || error,
      ...(said.hint && { hint: said.hint }),
      ...(said.recovery && { recovery: said.recovery }),
    };
  }
  return {
    ok: false,
    phase: "github_pull",
    error,
    hint: said.hint || "Deploy the solution first (with mcp_store) to auto-create the GitHub repo.",
    message: "Cannot pull from GitHub. The repo may not exist yet — deploy with mcp_store first.",
  };
}

// What `main` is said to lack, per part (deployBranchHoldsNo).
const WHAT_MAIN_LACKS = Object.freeze({
  solution: "holds no solution.json: nothing has been promoted to it.",
  skills: "lacks skills (skills/<id>/skill.json).",
});

/**
 * build_and_run's answer when it read an EXISTING repo's deploy branch and
 * that branch lacks a part of the definition: the solution (`solution.json`)
 * or the skills (CHECK A, M2). The only road the old pre_check texts gave was
 * "Pass solution inline" / "Pass skills inline", written when a missing part
 * meant no repo at all (8c5a114, 2026-03-21); since deploys moved to `main`
 * (45010fa) an existing repo whose `main` lacks them is the normal state of
 * work that has not been promoted yet, and sending the part inline there
 * recreates what the repo already holds on `dev`. ONE helper for both parts:
 * the roads are the same. The first-deploy answers (no repo) stay where the
 * guards are.
 * What it says depends on what is missing. No solution at all means nothing
 * has been promoted. No skills does NOT: a `main` that lacks skills may hold a
 * solution (or the caller sent one inline), so it says only that the skills
 * are not there.
 * @param {"solution"|"skills"} missing  what `main` does not hold
 * @returns {object}
 */
function deployBranchHoldsNo(missing) {
  const said = WHAT_MAIN_LACKS[missing];
  if (!said) throw new Error(`deployBranchHoldsNo: unknown part "${missing}"`);
  const { deploy_branch: deploy, write_branch: write, promote_tool: promote } = BRANCH_WORKFLOW;
  return {
    ok: false,
    phase: "pre_check",
    error: `\`${deploy}\`, the branch ateam_build_and_run deploys, ${said}`,
    message:
      `Ship what is on \`${write}\`: ${promote}(solution_id, dry_run:true) previews it, ${promote}(solution_id) ships it, then run this call again. ` +
      `Or deploy \`${write}\` work without shipping it: ateam_upload_connector(solution_id, connector_id, github:true) for a connector's code, ` +
      `ateam_patch for a skill or solution definition.`,
    recovery: `${promote}(solution_id)`,
  };
}

/**
 * A bundle pull-bundle could not read in full is refused, never deployed in
 * part (Builder #144, B144R-6): `solution_unreadable` names the first
 * definition file (solution.json, a skill) that could not be read or parsed;
 * `connectors_unreadable` the connectors with a file that could not be read.
 * @param {object} pull  pull-bundle's answer
 * @returns {object|null}
 */
function bundleNotRead(pull) {
  const branch = BRANCH_WORKFLOW.deploy_branch;
  const u = pull.solution_unreadable;
  if (u) {
    const path = u.path || "solution.json";
    const parse = u.stage === "parse";
    return {
      ok: false,
      phase: "github_pull",
      code: parse ? "SOLUTION_JSON_INVALID" : "BRANCH_NOT_READ",
      path,
      ...(u.code && { cause_code: u.code }),
      error: `${path} on ${branch} ${parse ? "does not parse" : "could not be read"}: ${u.error}. Nothing was deployed.`,
      hint: parse
        ? `Fix it with ateam_github_patch(solution_id, path:'${path}'), ship it with ateam_github_promote, then deploy again.`
        : "Retry the deploy; GitHub reads are usually back within a minute.",
    };
  }
  const ids = Array.isArray(pull.connectors_unreadable) ? pull.connectors_unreadable : [];
  if (ids.length > 0) {
    return {
      ok: false,
      phase: "github_pull",
      code: "BRANCH_NOT_READ",
      connectors_unreadable: ids,
      error: `GitHub did not let every file of ${ids.join(", ")} be read on ${branch}; deploying now would ship ${ids.length === 1 ? "that connector" : "those connectors"} without them. Nothing was deployed.`,
      hint: "Retry the deploy; GitHub reads are usually back within a minute.",
    };
  }
  return null;
}

// WHAT CONTINUES A CONVERSATION, and the window an answer has — what Core does
// today, from Core and Builder origin/dev (2026-10-02). The Builder serves no
// constant for this, so these are ateam-mcp's words, rendered in
// ateam_conversation's description, its kickoff result and bootstrap's
// conversation_flow, and written nowhere else.
//   - Each call is a new chain. The Builder's startChat sends no chainRouting
//     (adasCoreClient.js:686-693), so Core's POST /api/chat starts a new job
//     every time (server.js:2628-2635, 2748), and sys.askUser ENDS its chain:
//     the answer is an ordinary new message (server.js:2771-2776).
//   - actor_id continues nothing. Core drops a body actorId from an API-key or
//     JWT caller (server.js:2578-2580, utils/callerContext.js:149-154); the job
//     runs as X-ADAS-ACTOR-ID, the key's person (Builder testIdentity,
//     routes/solutions.js:101-105, 2776-2777), or as _system_service for a key
//     no person minted. Core keys the conversation by that actor.
//   - The window. Core's continuity routing (skills/skillLoader.js:216-251)
//     sends a message to the skill of that actor's last turn only when the turn
//     ended within FOLLOWUP_TTL_MS (60 s) — FOLLOWUP_SHORT_TTL_MS (5 min) for a
//     message of SHORT_MSG_THRESHOLD (25) characters or fewer — and never when
//     it opens with a TOPIC_SHIFT_VERBS verb. Otherwise the message goes
//     through the entry routing a first message takes (skillLoader.js:259-300).
//     No deployment sets CONTINUITY_TTL_MS / CONTINUITY_SHORT_TTL_MS (checked
//     2026-10-02), so the defaults are what runs.
// Before this, ateam_conversation said "pass the reply's actor_id (the thread)
// back in to continue that thread" and its actor_id "to continue it"
// (7d44113); before that, "the same actor_id maintains conversation context"
// (ff1cbd2). Whether an answer must always reach the question it answers is
// CORE's decision; this only says what happens today.
const CONVERSATION_CONTINUES =
  "Each call is a new chain, and your key, not actor_id, continues the conversation: Core keys it by the actor the job runs as (passing the reply's actor_id back is harmless).";
const REPLY_WINDOW =
  "Core sends a message to the skill of that actor's last turn only within 60 s of it (5 min if the message is 25 characters or fewer), never when it starts with a new-task verb (build, create, make, …); later it is routed like a first message, so an answer can miss its question.";

// The RUNNING version, read from package.json — never hardcoded. "Deployed" means
// three different things here (the mac1 container, npm, and each developer's local
// checkout+process), and a stale local PROCESS is indistinguishable from a broken
// fix without this. Surfaced in the MCP handshake and in ateam_bootstrap so
// "which build am I talking to?" is a five-second check, not a three-message
// round-trip (2026-08-16).
import { createRequire as _createRequire } from "node:module";
export const MCP_VERSION = (() => {
  try { return _createRequire(import.meta.url)("../package.json").version; }
  catch { return "unknown"; }
})();

// ─── Async deploy helper ────────────────────────────────────────────
//
// All long-running deploy endpoints (build_and_run, redeploy, github_pull)
// support async mode: POST returns {job_id, poll_url} in <1s, the work runs
// in the background, and the client polls /deploy/jobs/:jobId until status
// is "done" or "failed". This bypasses the upstream Cloudflare 100s timeout
// that used to kill bulk redeploys with 524.
//
// pollDeployJob is the client side of that contract: it polls the job and
// returns the final job entry (which is the same shape as the original
// sync response would have been, plus job metadata). MCP tool wrappers use
// this so the agent gets a normal response from a long-running tool call —
// no async API leaks out to agent prompts. That keeps THIS process's hop to the
// Builder under the edge's limit. The caller's hop to a hosted ateam-mcp has
// the same limit, and polling here does nothing for it: see "The hosted call's
// budget" below.
async function pollDeployJob(jobId, sid, { label = 'deploy', maxMs = 15 * 60_000, intervalMs = 2000 } = {}) {
  const start = Date.now();
  let lastStatus = null;
  // Built ONCE, before the loop. Inside the try, an id apiPath refuses was
  // caught as a "transient" poll error and retried for the whole budget, then
  // reported as "polling timed out". Refused now, at once, with nothing sent.
  const jobPath = apiPath`/deploy/jobs/${jobId}`;
  while (Date.now() - start < maxMs) {
    await new Promise(r => setTimeout(r, intervalMs));
    try {
      const job = await get(jobPath, sid);
      lastStatus = job?.status;
      if (job?.status === 'done' || job?.status === 'failed') {
        return job; // job entry has the full result merged in
      }
    } catch (err) {
      // Transient — keep polling. Log at debug level if requested.
      if (process.env.MCP_DEBUG_POLLS) console.warn(`[pollDeployJob:${label}] poll error (will retry): ${err.message}`);
    }
  }
  return {
    ok: false,
    error: `${label} polling timed out after ${Math.round(maxMs / 60_000)}min`,
    last_status: lastStatus,
    job_id: jobId,
    hint: 'The job may still be running on the server. Call get(`/deploy/jobs/<job_id>`) directly to check.',
  };
}

// ─── The hosted call's budget ───────────────────────────────────────
//
// A CALL TO THE HOSTED SERVER MUST ANSWER BEFORE THE EDGE DROPS IT. src/http.js
// answers tools/call with ONE JSON body (enableJsonResponse, 11bd691, for
// ChatGPT) and sends nothing until the tool returns, and Cloudflare in front of
// the hosted server drops a proxied request that has been silent for ~100s.
// ateam_build_and_run runs validate → deploy → connector re-upload → health →
// GitHub push → agent doc → widget health one after another in this process:
// ~133s on the Ada Guide first deploy (K15, 2026-09-28). The client got "the
// server isn't responding", with no result and nothing to ask about, while the
// run went on and deployed. The Builder hop was never the problem: it answered
// in 27s, so pollDeployJob's fallback had nothing to do.
//
// So a call on any transport but a stated "stdio" (api.js callTransport: null
// is not local) runs the pipeline as a RUN held here, and waits for it at most
// HOSTED_CALL_BUDGET_MS. A run not finished by then goes on: it is not stopped,
// and nothing of it is sent again. The call answers status:"running" with the
// run's run_id, and ateam_build_and_run(resume:true) waits for THAT run again,
// under the same budget, and answers with its result. resume never deploys. A
// call identical to the run in flight joins it, as the Builder's deploy door
// joins an identical payload (routes/deploy.js payloadHash); any other call
// starts a run of its own, and the door queues its deploy behind this one.
//
// A stdio call is unchanged: the caller's own process holds it as long as the
// pipeline takes, and nothing is held here.
//
// Runs live in this process's memory. A restart forgets them (the deploy is the
// Builder's and goes on regardless), and resume then says there is no run.
export const HOSTED_CALL_BUDGET_MS = 75_000;

// How long a finished run can still be resumed: as long as the Builder keeps a
// finished deploy job (startAsyncDeployJob evicts after 30 minutes).
const FINISHED_RUN_KEPT_MS = 30 * 60_000;

const buildRuns = new Map();       // run_id → run
const latestBuildRun = new Map();  // owner → run_id of the last run started for it

/**
 * WHOSE run: the API this session deploys to, the credentials it deploys with,
 * and the solution. A run_id from another tenant, another key or another
 * solution finds nothing. Hashed, so no key sits in a map key.
 */
function buildRunOwner(sid, solutionId) {
  const { tenant, apiKey } = getCredentials(sid);
  return createHash("sha256")
    .update([getBaseUrl(sid), tenant || "", apiKey || "", solutionId].join("\n"))
    .digest("hex");
}

/** Key-sorted JSON: the same arguments in another order are the same call. */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function startBuildRun(owner, solutionId, deployArgs, argsKey, sid) {
  const run = {
    run_id: `bar_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
    owner,
    solution_id: solutionId,
    args_key: argsKey,
    started_at: new Date().toISOString(),
    started_ms: Date.now(),
    outcome: null, // { value } or { error }, once the pipeline has settled
  };
  // Settles, never rejects: every caller waiting on it reads `outcome`.
  run.done = runBuildAndRun(deployArgs, sid).then(
    (value) => { run.outcome = { value }; },
    (error) => { run.outcome = { error }; },
  ).then(() => {
    setTimeout(() => {
      buildRuns.delete(run.run_id);
      if (latestBuildRun.get(owner) === run.run_id) latestBuildRun.delete(owner);
    }, FINISHED_RUN_KEPT_MS).unref?.();
  });
  buildRuns.set(run.run_id, run);
  latestBuildRun.set(owner, run.run_id);
  return run;
}

/** The run's own answer, if it has one within what is left of this call's budget; else "running". */
async function answerWithinBudget(run, callStartMs) {
  if (!run.outcome) {
    let timer;
    const outOfBudget = new Promise((resolve) => {
      timer = setTimeout(resolve, Math.max(0, HOSTED_CALL_BUDGET_MS - (Date.now() - callStartMs)));
    });
    await Promise.race([run.done, outOfBudget]);
    clearTimeout(timer);
  }
  if (!run.outcome) return stillRunning(run);
  if (run.outcome.error) throw run.outcome.error;
  return run.outcome.value;
}

function stillRunning(run) {
  const secs = Math.round((Date.now() - run.started_ms) / 1000);
  const resume = `ateam_build_and_run({ solution_id: "${run.solution_id}", resume: true, run_id: "${run.run_id}" })`;
  return {
    // No verdict yet: neither a success nor a failure.
    ok: null,
    status: "running",
    solution_id: run.solution_id,
    run_id: run.run_id,
    started_at: run.started_at,
    running_for_s: secs,
    message:
      `The deploy of "${run.solution_id}" is still running (${secs}s so far). This call answers now because a hosted ` +
      `connection is cut off after about 100s without an answer. The run was not stopped, and nothing of it is sent again.`,
    _next:
      `${resume} waits for THIS run again (up to ${HOSTED_CALL_BUDGET_MS / 1000}s) and answers with its result, and it deploys nothing. ` +
      "ateam_build_and_run without resume:true is a new deploy, unless its arguments are identical to this run's: then it joins this run.",
  };
}

function noRunToResume(solutionId, runId) {
  const which = runId ? ` with run_id "${runId}"` : "";
  return {
    ok: false,
    code: "NO_RUN_TO_RESUME",
    ...(solutionId && { solution_id: solutionId }),
    ...(runId && { run_id: runId }),
    error:
      `There is no ateam_build_and_run of "${solutionId || "?"}"${which} to resume on this server. A run can be resumed for ` +
      `${FINISHED_RUN_KEPT_MS / 60_000} minutes after it finishes, only with the credentials that started it, and only until this ` +
      "server restarts. A stdio call is never resumed: it answers when its run is done.",
    _next: solutionId
      ? `This call deployed nothing. Before you deploy again, see what is deployed: ateam_get_solution(solution_id: "${solutionId}", view: "status").`
      : "Pass the solution_id of the run to resume, and the run_id its answer gave.",
  };
}

/**
 * ateam_build_and_run: the pipeline (runBuildAndRun), on stdio as it always
 * ran; on any other transport within HOSTED_CALL_BUDGET_MS. resume:true answers
 * from a run already started, and never deploys.
 */
async function buildRunWithinBudget(args, sid) {
  const callStartMs = Date.now();
  const { resume, run_id: runId, ...deployArgs } = args || {};
  const solutionId = deployArgs.solution?.id || deployArgs.solution_id;
  if (resume === true || resume === "true") {
    if (!solutionId) return noRunToResume(null, runId);
    const owner = buildRunOwner(sid, solutionId);
    const run = buildRuns.get(runId || latestBuildRun.get(owner));
    if (!run || run.owner !== owner) return noRunToResume(solutionId, runId);
    return answerWithinBudget(run, callStartMs);
  }
  // With no solution id the pipeline answers its pre_check at once.
  if (callTransport() === "stdio" || !solutionId) return runBuildAndRun(deployArgs, sid);

  const owner = buildRunOwner(sid, solutionId);
  const argsKey = createHash("sha256").update(stableJson(deployArgs)).digest("hex");
  const inFlight = buildRuns.get(latestBuildRun.get(owner));
  const run = inFlight && !inFlight.outcome && inFlight.args_key === argsKey
    ? inFlight
    : startBuildRun(owner, solutionId, deployArgs, argsKey, sid);
  return answerWithinBudget(run, callStartMs);
}

// ─── The redeploy verdict ───────────────────────────────────────────
//
// ONE answer to "did this redeploy work?" — ateam_redeploy's summary and
// ateam_patch's rebuild phase both ask it — on every path (async job, sync
// body, poll timeout) and against every Builder in service:
//
//   Builder #44+ (dev)   the async job carries the deploy's own outcome as
//                        `deploy_status`; `status` is only the job lifecycle.
//   Builder c6c20d3      (mac1 dev) normalizeSkillRedeploy, but NO
//                        deploy_status — the job runner overwrites the
//                        outcome with the lifecycle word 'done'.
//   Builder 2e8cab5      (prod) no normaliser: a degraded skill arrives as
//                        ok:false, lifecycle 'failed'.
//
// Three verdicts: failed | degraded (reached Core, did not come up clean) | clean.

// The words startAsyncDeployJob writes into `status` OVER the deploy's own:
// they say the JOB stopped, never what the deploy decided.
const JOB_LIFECYCLE_STATUSES = new Set(["in_progress", "done", "failed"]);

// The stated outcomes that mean "came up clean". An allow-list on purpose: an
// outcome this code has never heard of is degraded, never a success.
const CLEAN_REDEPLOY_OUTCOMES = new Set(["deployed"]);

/**
 * THE DEPLOY'S OWN SENTENCE, OR NOTHING. A job entry's `message` is either what
 * the deploy said or the leftover PROGRESS text ("Redeploying skill from GitHub
 * or Builder FS..."), and quoting the second as a verdict is a false report. It
 * is the deploy's sentence only when a SINGLE-skill runFn RETURNED: every
 * Builder's single-skill result carries one (the normaliser always writes it;
 * prod spreads deploySkillToADAS's, which always has one). A bulk runFn returns
 * none, and a runFn that THREW returned nothing at all, so in both cases the
 * progress text is what is left standing.
 */
function deploySentence(r, single) {
  return single && typeof r.message === "string" && r.message.trim() ? r.message.trim() : undefined;
}

/**
 * @param {object} result  a finished job entry, a sync body, or pollDeployJob's timeout object
 * @param {{ single?: boolean }} [opts]  a single-skill redeploy (see deploySentence)
 * @returns {{ failed: boolean, degraded: boolean, outcome: string|undefined, reason: string|undefined }}
 *   `reason` is the deploy's own explanation, when it gave one: its error, or
 *   (single-skill only) its message.
 */
function redeployVerdict(result, { single = false } = {}) {
  const r = result && typeof result === "object" ? result : {};
  // What the deploy itself STATED. Never a lifecycle word.
  const stated = r.deploy_status ?? (JOB_LIFECYCLE_STATUSES.has(r.status) ? undefined : r.status);

  // 1. FAILED — decided first. A success is STATED: ok === true. A job whose
  //    runFn THREW (the Builder answered an HTML 502, so resp.json() threw; or
  //    the 300s AbortSignal fired) is written as {status:'failed', error} with
  //    NO ok key and the progress text still standing — `ok !== false` read
  //    that as "reached Core WITH ERRORS". Lifecycle 'failed' alone is not the
  //    test: pollDeployJob's timeout is ok:false with no status at all.
  //    And ok:true is not the whole statement either: a body that ALSO carries
  //    a top-level `error` has told us something failed, and a verdict that
  //    reads only `ok` would call it a clean success.
  if (r.ok !== true || r.error) {
    // ok === false EXPLICITLY means the runFn RETURNED — prod (2e8cab5, no
    // normaliser) hands back deploySkillToADAS's own ok:false with its own
    // message and no `error`. That sentence is the reason; "gave no reason"
    // would be false. A crashed job has no ok key, so it never gets here with
    // only a message.
    const reason = r.error || (r.ok === false ? deploySentence(r, single) : undefined);
    return { failed: true, degraded: false, outcome: stated ?? "failed", reason };
  }

  // 2. DEGRADED. With no stated outcome (a Builder before #44, async path),
  //    re-derive it by the Builder's OWN rule — deploySkillToADAS:
  //    `degraded = uiHardFail || importBad`, importBad being
  //    tool_import.verdict !== 'SUCCESS'. uiHardFail cannot occur on a redeploy:
  //    a skill-only deploy skips connector sync, leaving no healthy connector to
  //    run UI verification against; a bulk one reports a degraded skill as
  //    failed (ok:false). So tool_import IS the verdict on this path.
  //    NOT verification.needs_attention: the Builder sets it on EVERY deploy
  //    (it defaults hasGetSkillDefinition to false, and Core's deploy-mcp has
  //    not returned that field since b6a83a035) — it would call every
  //    redeploy degraded.
  const importVerdict = r.verification?.tool_import?.verdict;
  const inferred = importVerdict == null ? undefined
    : importVerdict === "SUCCESS" ? "deployed" : "deployed_with_errors";
  const outcome = stated ?? inferred;
  const degraded = (Number(r.failed) || 0) > 0
    || (outcome != null && !CLEAN_REDEPLOY_OUTCOMES.has(outcome));
  return {
    failed: false,
    degraded,
    outcome: outcome ?? (degraded ? "deployed_with_errors" : undefined),
    reason: degraded ? deploySentence(r, single) : undefined,
  };
}

/** A quoted sentence that ends like one, so the next sentence does not run into it. */
function asSentence(text) {
  const t = String(text).trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * Is GitHub connected for this tenant? ONE answer to one question: ateam_patch
 * asks it to decide whether to degrade to the Builder store, ateam_build_and_run
 * to decide whether it has a branch story to tell at all. The probe is the
 * definitive source — a failed github read or push alone is ambiguous.
 * @returns {Promise<boolean|null>} true/false from the probe; null when the probe
 *   itself failed, which callers must treat as UNKNOWN, never as "not connected".
 */
async function probeGithubConnected(solution_id, sid) {
  try {
    const probe = await get(apiPath`/deploy/solutions/${solution_id}/github/connected`, sid);
    return probe?.connected !== false && probe?.enabled !== false;
  } catch {
    return null;
  }
}

/**
 * The BRANCH half of ateam_build_and_run's envelope, decided in ONE place from
 * what the deploy actually did. Exported so it is tested by calling it.
 *
 * `deployed_from_branch` and a `_next` about unpromoted work on `dev` used to be
 * literals in the return object, emitted for every tenant — so a tenant with NO
 * repo was told which branch it deployed and to promote a branch that does not
 * exist, contradicting BRANCH_WORKFLOW.no_git_at_all. And a deploy of an INLINE
 * payload claimed to have deployed `main`, which it never read.
 *
 * @param {object} p
 * @param {boolean} p.pulledFromRepo   Core was built from the repo's bundle
 * @param {object}  [p.githubResult]   the phase-5 push result (or its error/skip)
 * @param {boolean|null} p.githubConnected  probeGithubConnected's answer; only
 *   `false` means "no repo" — null is unknown and keeps the branch story
 * @param {object}  [p.widgetHealth]
 */
export function describeDeployBranches({ pulledFromRepo, githubResult, githubConnected, widgetHealth }) {
  const W = BRANCH_WORKFLOW;
  const noRepo = githubConnected === false && !pulledFromRepo && !githubResult?.branch;
  const pushLine = noRepo
    ? '— no GitHub repo is connected, so nothing was pushed; the Builder store is this solution\'s source of truth'
    : githubResult?.error ? `⚠️ GitHub push FAILED: ${githubResult.error}`
      // A SKIP IS NOT ALWAYS A DIVERGENCE. When the deploy PULLED from GitHub,
      // the push-back is skipped precisely because Core was built from that
      // content — they agree exactly, and telling the caller they "now differ"
      // sends them to reconcile a repo that is already correct. The divergence
      // that DOES exist on that path is the one nobody mentions: dev may be
      // ahead of the main we deployed.
      : githubResult?.skipped ? `⚠️ GitHub push skipped${githubResult.reason ? ` (${githubResult.reason})` : ''}`
        + (/from github/i.test(githubResult.reason || '')
            ? ` — Core matches the branch it was built from. If you have unpromoted work on \`${W.write_branch}\`, it is NOT in this deploy: ${W.promote_tool}(solution_id), then deploy again.`
            : ' — Core and GitHub now differ')
      : githubResult ? `+ pushed to ${githubResult.branch || W.write_branch}`
      : '⚠️ no GitHub push attempted — Core and GitHub may differ';
  return {
    // WHAT WAS DEPLOYED vs WHERE THE PUSH LANDED are two different facts.
    ...(pulledFromRepo && { deployed_from_branch: W.deploy_branch }),
    ...(githubResult?.branch && { pushed_to_branch: githubResult.branch }),
    _status: [
      '✅ Deployed to Core',
      pushLine,
      ...(widgetHealth && !widgetHealth.ok
        ? [`⚠️ ${widgetHealth.issues?.length || 0} widget(s) not rendering — see widget_health.`]
        : []),
    ].join(' '),
    // promote is a SHIP, not a checkpoint: it merges dev → main; the tag is a
    // side effect.
    _next: noRepo
      ? `No GitHub repo is connected, so there are no branches and nothing to promote. ${W.no_git_at_all}`
      : pulledFromRepo
        ? `This deployed \`${W.deploy_branch}\`. Anything you patched since the last promote is still on \`${W.write_branch}\` and is NOT in this deploy — ${W.promote_tool}(solution_id) merges ${W.write_branch} → ${W.deploy_branch} (dry_run:true to preview), then deploy again.`
        : `This deployed the payload you passed, not a branch. ${W.deploy_side} ${W.promote_tool}(solution_id) (dry_run:true to preview) is what ships \`${W.write_branch}\` there.`,
  };
}

// ─── Widget health verification ────────────────────────────────────
//
// A skill/solution that declares UI plugins (ui_plugins[]) can silently ship
// a NON-RENDERING widget: the connector may not expose the plugin via
// ui.listPlugins, the manifest may lack a render block, or the declared id may
// be mistyped. Core's live catalog (GET /api/ui-plugins) reflects what Core
// ACTUALLY discovered — it calls each connector's ui.listPlugins live — so we
// cross-check every declared plugin against it AND assert a usable render
// block. Callers fold the report into deploy/verify output so a broken widget
// is surfaced at deploy time, not discovered later as a blank panel.
//
// Returns null when the solution declares no widgets (nothing to check), else
// { ok, checked, healthy, plugins[], issues[]?, hint? }.
// ─────────────────────────────────────────────────────────────────────────────
// Authored-source representation marker
//
// A skill/solution definition read from GitHub is NOT the runtime. It is a
// mirror that drifts: on solution 'ada' (2026-08-04) the `dev` copy declared 29
// tools while production was running 66, because deploy-time connector imports
// are regenerated on every deploy and only mirrored to `main`. An agent that
// answers "what tools does this skill have?" from a repo read gets a wrong
// answer today, and would get an emptier one once generated data leaves the
// committed file.
//
// So every read of a definition path carries an ADDITIVE `_ateam_representation`
// telling the caller what it is holding and which tool returns the live view.
// Additive on purpose — wrapping or reshaping the existing response would break
// callers that expect the raw payload.
//
// `kind` reports what the file ACTUALLY is right now, not what we intend it to
// become: files without `source_schema_version >= 2` still carry generated data,
// so calling them "authored_source" today would be a lie.
// See Docs/WIP/SKILL_JSON_SPLIT_PLAN_2026-08-04.md (Phase C).
// ─────────────────────────────────────────────────────────────────────────────
const _SKILL_JSON_RE = /^skills\/([^/]+)\/skill\.json$/;

function _representationFor(filePath, content, solution_id) {
  const p = String(filePath || "");
  const skillMatch = p.match(_SKILL_JSON_RE);
  if (p !== "solution.json" && !skillMatch) return null;

  let schemaVersion = null;
  try {
    const parsed = typeof content === "string" ? JSON.parse(content) : content;
    schemaVersion = parsed?.source_schema_version ?? null;
  } catch { /* not JSON, or truncated — fall through to the v1 wording */ }

  const authoredOnly = typeof schemaVersion === "number" && schemaVersion >= 2;

  return {
    kind: authoredOnly ? "authored_source" : "git_mirror_v1",
    is_runtime_state: false,
    runtime_state_may_differ: true,
    may_include_generated_fields: !authoredOnly,
    ...(authoredOnly
      ? { generated_fields_omitted: ["auto_imported_tools", "deployment_timestamps"] }
      : { contains_generated_fields: ["auto_imported_tools", "deployment_timestamps"] }),
    warning: authoredOnly
      ? "Authored source only. Connector-imported tools are NOT in this file — they are regenerated at deploy time. Do not answer capability questions from it."
      : "This is a git mirror, not runtime state. Its tools[] and timestamps are a snapshot from the last write to this branch and may not match what is deployed. Do not answer capability questions from it.",
    live_state_tool: {
      name: "ateam_get_solution",
      arguments: {
        solution_id,
        ...(skillMatch ? { skill_id: skillMatch[1], section: "tools" } : {}),
      },
    },
  };
}

// Compress a skill/solution definition to a small, non-truncating summary for
// tool results — enough to confirm the shape without the 10s-of-KB full doc.
function _summarizeDef(def) {
  if (!def || typeof def !== "object") return def;
  const pick = (arr, key) => Array.isArray(arr) ? arr.map((x) => (typeof x === "string" ? x : x?.[key] || x?.id)).filter(Boolean) : undefined;
  return {
    id: def.id,
    name: def.name,
    version: def.version,
    phase: def.phase,
    ...(def.linked_skills && { linked_skills: pick(def.linked_skills, "id") }),
    ...(def.skills && { skills: pick(def.skills, "id") }),
    ...(def.connectors && { connectors: pick(def.connectors, "id") }),
    ...(def.platform_connectors && { platform_connectors: pick(def.platform_connectors, "id") }),
    ...(def.ui_plugins && { ui_plugins: pick(def.ui_plugins, "id") }),
    // OPEN-20: `tools_declared` is THIS FILE's tools[], which can differ from
    // what is deployed. The note says the one thing a reader gets wrong from
    // it: a deployed non-empty tools[] is a WHITELIST (Core 1f2513ff1), so a
    // linked connector's tool it does not name is not callable. ad5b085 said
    // "tools_declared + ALL tools from linked connectors", which made a refused
    // tool read as callable (RUN5-3). How the list is built and refreshed has
    // one home, the skill spec; the note points there and keeps no copy.
    ...(def.tools && { tools_declared: pick(def.tools, "name") }),
    ...((Array.isArray(def.connectors) && def.connectors.length > 0 && !def.skills && !def.linked_skills) && {
      _tools_note: `tools[] is a WHITELIST once deployed: Core lets this skill call only the connector tools the deployed tools[] names (or a "<connector-id>:*" / "<prefix>.*" entry matches); a tool of [${pick(def.connectors, "id").join(", ")}] not in it is NOT callable. tools_declared is this file's copy and can differ from the deployed list. How the list is built and refreshed: ateam_get_spec('skill') → agent_guide.key_concepts.how_a_skill_gets_its_tools. The Builder's copy of the list (not necessarily what Core runs): ateam_get_solution(solution_id, skill_id:"${def.id}", section:"tools").`,
    }),
    _fields: Object.keys(def),
    _note: "compact summary — pass include_definition:true to ateam_patch for the full definition.",
  };
}

/**
 * ateam_get_solution(solution_id, skill_id, section:"tools") — the tools a
 * skill's deploy sends, from the Builder's skill read: `deployed.tools`
 * ({name, description, connector}), with the author's own list beside it.
 * A Builder that sends no `deployed` (one before BL-38) or a skill with no
 * deploy recorded (`deployed: null`) answers with the file's list, and says
 * that is all it is.
 */
function toolsSectionOf(r, solution_id, skill_id) {
  const skill = r?.skill || r?.definition || r || {};
  const inFile = Array.isArray(skill.tools) ? skill.tools : [];
  // A skill the Builder has not yet migrated (BL-38) still holds in skill.json
  // the tools an earlier import wrote there, marked `_auto_imported`. They come
  // from a connector, not from the author: listed as authored they send an
  // agent to edit, with ateam_patch, a tool the next deploy rewrites (BL-43).
  const authored = inFile.filter((t) => t?._auto_imported !== true);
  const deployed = r?.deployed;
  if (deployed && Array.isArray(deployed.tools)) {
    return {
      ok: true, solution_id, skill_id, section: "tools",
      tools: deployed.tools,
      ...(deployed.imported_from && { imported_from: deployed.imported_from }),
      authored_tools: authored,
      _note: "tools = every tool this skill's deploy sends: the ones you wrote (authored_tools, skill.json) and the ones imported from its connectors (imported_from), as the Builder last built them. What Core runs right now can differ until the next deploy. Edit authored_tools with ateam_patch; imported tools come from the connector.",
    };
  }
  return {
    ok: true, solution_id, skill_id, section: "tools",
    tools: inFile,
    authored_tools: authored,
    _note: deployed === null
      ? "No deploy is recorded for this skill, so these are only the tools you wrote (skill.json). Tools imported from its connectors appear here once it is deployed."
      : "This Builder sent no deployed state, so these are only the tools written in skill.json; tools imported from the skill's connectors are not listed.",
  };
}

// OPEN-8: byte offset/limit paging for reads that can exceed the ~50KB output
// cap. Serializes the result to pretty JSON and returns a [offset, offset+limit)
// slice plus a cursor so an agent can page the rest (like Read offset/limit).
function _pageJson(data, offset = 0, limit) {
  const full = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const total = full.length;
  const start = Math.min(Math.max(0, Math.trunc(offset) || 0), total);
  const size = (limit != null) ? Math.max(1, Math.trunc(limit)) : (total - start);
  const chunk = full.slice(start, start + size);
  const end = start + chunk.length;
  return {
    ok: true,
    _paging: {
      offset: start,
      limit: (limit != null) ? size : null,
      returned_bytes: chunk.length,
      total_bytes: total,
      next_offset: end < total ? end : null,
      has_more: end < total,
      note: end < total ? `Truncated to bytes ${start}-${end} of ${total}. Fetch the next page with offset:${end}.` : `Complete (bytes ${start}-${end} of ${total}).`,
    },
    // Raw JSON text slice — parse only once you've concatenated all pages.
    content: chunk,
  };
}

function _widgetHasRender(r) {
  if (!r || typeof r !== "object" || !r.mode) return false;
  const hasIframe = !!(r.iframeUrl || r.iframe?.iframeUrl);
  const hasRn = !!(r.reactNative?.component);
  if (r.mode === "iframe") return hasIframe;
  if (r.mode === "react-native") return hasRn;
  if (r.mode === "adaptive") return hasIframe || hasRn;
  return true; // unknown mode — don't false-positive on a custom render
}


// ── WIDGET POSTMESSAGE PROTOCOL: the failure that RENDERS FINE ────────────────
//
// A widget using the wrong postMessage shape draws its chrome, calls the host,
// and hangs until its own timeout. Nothing errors: the connector is healthy,
// tools/list is correct, the plugin "renders", and only the DATA is missing.
// A clinic dashboard shipped that way and was reported as working (2026-08-29).
//
// The host matches action === "mcp-call" with payload.requestId. Three shapes
// are fatal on their own, and a widget can get two right and still hang:
//   type:"tool.call"        — never existed in the host, at any version
//   correlationId           — the host echoes requestId; the pending map misses
//   type:"mcp-call" on SEND — send is matched on message.action, not .type
//
// Detected here rather than left to a person noticing an empty panel, and
// reported with the repair attached — a signal the reasoning engine can act on.

// Index of the character after the `}` that closes the `{` at `open`, or -1
// when it never closes (minified truncation, template weirdness).
function _closingBrace(html, open) {
  let depth = 0, inStr = null, esc = false;
  for (let i = open; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

// Extract the FULL argument object of each postMessage(...) call by matching
// braces, so every call is judged on its own text. The previous version took a
// fixed 400-character window and concatenated all of them: a send object longer
// than the window was inspected in part, and `source:"adas-plugin"` in one call
// could make an unrelated postMessage elsewhere on the page be judged as the
// ADAS protocol. Both were rejected in review, correctly — an approximate
// boundary is not a structural one.
//
// Each entry also says whether the call is addressed to the PARENT window
// (`window.parent.`, `parent?.`, `window.top.`): the only place the host ever
// listens. A message to the parent is the protocol whatever it says about
// itself; that is how a scaffold that signed itself `type:"adas-plugin"`
// (RUN5-16, ateam_create_plugin since ae85a46) was judged by nobody.
function _postMessageObjects(html) {
  const out = [];
  const re = /((?:[\w$]+\s*(?:\?\.|\.)\s*)*)postMessage\s*\(\s*\{/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const open = html.indexOf("{", m.index + m[1].length);
    const end = _closingBrace(html, open);
    // Unbalanced → skip rather than guess. A message we cannot delimit is one
    // we must not judge. (So is one built elsewhere and passed by name:
    // postMessage(msg, "*") is not judged.)
    if (end !== -1) {
      out.push({ obj: html.slice(open, end), toParent: /(?:^|[.?\s])(?:parent|top)\s*(?:\?\.|\.)\s*$/.test(m[1]) });
      re.lastIndex = Math.max(re.lastIndex, end);
    } else {
      re.lastIndex = Math.max(re.lastIndex, open + 1);
    }
  }
  return out;
}

// What the hosts act on when a plugin sends it. Core
// packages/widget-surface/src/attachHostBridge.js KNOWN_ACTIONS / KNOWN_TYPES
// (select-actor, mcp-call | plugin.command.result, plugin.event, open-job); the
// phone's usePluginBridge.ts also honours action "close" (the web host has no
// such action: it is accepted here, since sending it harms nothing).
const _HOST_SEND_ACTIONS = ["mcp-call", "select-actor", "close"];
const _HOST_SEND_TYPES = ["plugin.command.result", "plugin.event", "open-job"];
const _keyIs = (key, value) => new RegExp(`\\b${key}\\s*:\\s*["']${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`);

// The inline `payload: { ... }` literal of a message object, or null when there
// is none to read: built elsewhere (`payload` by name), or it spreads another
// object (its keys are not all visible). A key we cannot see is not one we may
// report missing.
function _inlinePayload(obj) {
  const at = /payload\s*:\s*\{/.exec(obj);
  if (!at) return null;
  const open = obj.indexOf("{", at.index);
  const end = _closingBrace(obj, open);
  if (end === -1) return null;
  const payload = obj.slice(open, end);
  return /[{,]\s*\.\.\.\s*[\w$({[]/.test(payload) ? null : payload;
}
const _hasKey = (payload, key) => new RegExp(`(?:^|[{,\\s])${key}\\s*[:,}]`).test(payload);

export function _widgetProtocolProblems(html) {
  if (typeof html !== "string" || !html.includes("postMessage")) return [];

  const problems = [];
  const seen = new Set();
  const add = (p) => { if (!seen.has(p)) { seen.add(p); problems.push(p); } };

  // Judge each host-directed send INDEPENDENTLY. A page may legitimately
  // postMessage to other targets (an analytics frame, a sibling iframe); only a
  // message that signs itself as the ADAS plugin channel, or that goes to the
  // PARENT window, is the protocol.
  for (const { obj, toParent } of _postMessageObjects(html)) {
    const signed = /source\s*:\s*["']adas-plugin["']/.test(obj);
    if (!signed && !toParent) continue;

    if (!signed) {
      add('posts to the parent without source:"adas-plugin" — the host drops every message that lacks it, so nothing reaches the app and the call never settles (it is "source", not "type"). Send { source:"adas-plugin", message:{ action:"mcp-call", payload:{ requestId, connectorId, tool, args } } }.');
    }

    const sendsKnown = _HOST_SEND_ACTIONS.some((a) => _keyIs("action", a).test(obj)) ||
      _HOST_SEND_TYPES.some((t) => _keyIs("type", t).test(obj));
    if (/type\s*:\s*["']tool\.call["']/.test(obj)) {
      add('sends message.type:"tool.call" — the host has NEVER accepted it, at any version (silent timeout, no error). Send message:{action:"mcp-call",payload:{requestId,connectorId,tool,args}}.');
    } else if (!sendsKnown) {
      const actionIsAType = _HOST_SEND_TYPES.find((t) => _keyIs("action", t).test(obj));
      if (/type\s*:\s*["']mcp-call["']/.test(obj)) {
        add('sends message.TYPE:"mcp-call" — the host matches on message.ACTION for sends, so this is ignored. Use message:{action:"mcp-call",payload:{...}}.');
      } else if (actionIsAType) {
        add(`sends message.ACTION:"${actionIsAType}" — the host matches "${actionIsAType}" on message.TYPE (only mcp-call and select-actor are matched on message.ACTION), so this is ignored. Use message:{type:"${actionIsAType}",payload:{...}}.`);
      } else {
        const act = /\baction\s*:\s*["']([^"']+)["']/.exec(obj);
        const typ = /\btype\s*:\s*["']([^"']+)["']/.exec(obj);
        const what = act ? `action:"${act[1]}"` : typ ? `type:"${typ[1]}"` : "no message.action and no message.type";
        add(`sends ${what} — not a message the host acts on, so it is ignored (silent timeout, no error). The host acts on message.action "mcp-call" | "select-actor" | "close" (phone only), and message.type "plugin.command.result" | "plugin.event" | "open-job". A tool call is message:{action:"mcp-call",payload:{requestId,connectorId,tool,args}} — action "mcp-call" with a hyphen.`);
      }
    }

    // "The request id as correlationId" is a statement about a TOOL CALL: only
    // an mcp-call keys on requestId. Judged on that alone. A message of any
    // other kind carries a correlationId for its own reasons: a command reply
    // (plugin.command.result) must, and one under a type the host does not act
    // on is already reported as that — calling its id "the request id" would
    // send the author to a requestId the message never had (BL-42 / AM64-R1).
    // type:"mcp-call" is the near-miss of action:"mcp-call", still a tool call.
    const isToolCall = _keyIs("action", "mcp-call").test(obj) || _keyIs("type", "mcp-call").test(obj);
    if (isToolCall && (/payload\s*:\s*\{[^}]*correlationId/.test(obj) || /correlationId\s*:\s*correlationId/.test(obj))) {
      add('sends the request id as correlationId — the host echoes payload.requestId, so responses never match the pending request and every call times out even when the host answered.');
    }

    // An mcp-call the host cannot route: it needs requestId (else it is ignored)
    // and connectorId + tool (else it answers "Missing connectorId or tool").
    // Judged only when the payload is an inline literal without a spread: a
    // payload built elsewhere is not one we can see into.
    if (_keyIs("action", "mcp-call").test(obj)) {
      const payload = _inlinePayload(obj);
      const missing = payload ? ["requestId", "connectorId", "tool"].filter((k) => !_hasKey(payload, k)) : [];
      if (missing.length) {
        add(`sends an mcp-call whose payload has no ${missing.join(" / ")} — the host ignores a call without requestId and answers "Missing connectorId or tool" to one without those, so the call never succeeds. Take connectorId from the host's init message (payload.connectorId).`);
      }
    }

    // A command reply the host cannot match to the command: it reads
    // payload.correlationId and ignores the message without it (Core
    // attachHostBridge.js:50), so the command waits out its 15 s and the
    // CALLING skill gets "Plugin command timeout" — nothing fails in the widget.
    if (_keyIs("type", "plugin.command.result").test(obj)) {
      const payload = _inlinePayload(obj);
      if (payload && !_hasKey(payload, "correlationId")) {
        add('sends plugin.command.result whose payload has no correlationId — the host ignores a reply without it (it reads payload.correlationId; a reply to a command keys on correlationId, not requestId), so the command times out after 15 s in the calling skill. Echo the correlationId the plugin.command carried.');
      }
    }
  }

  // RECEIVE side: only reading correlationId OFF THE HOST PAYLOAD counts — and
  // only where that payload answers a tool call. The host's plugin.command
  // carries a correlationId too (Core WidgetSurface.jsx dispatchToIframe: the
  // phone's usePluginBridge.ts dispatchToWebView the same), and a plugin that
  // answers it MUST read that id and echo it back in plugin.command.result: a
  // page that handles plugin.command is reading the command's, and is not
  // flagged. (A page that handles commands AND matches its mcp-result by
  // correlationId is not caught here; its mcp-call send is, and the send side
  // is checked either way.)
  const handlesCommands = /(?:\b(?:type|action)\s*[!=]==?\s*|\bcase\s+)["']plugin\.command["']/.test(html);
  if (!handlesCommands && (
      /payload\s*(\?\.|\.)\s*correlationId/.test(html) ||
      /payload\s*&&\s*[\w$.]*payload\.correlationId/.test(html) ||
      /\{\s*correlationId[^}]*\}\s*=\s*[\w$.]*payload/.test(html))) {
    add('reads payload.correlationId from the host response — the host sends payload.requestId, so the pending request is never matched.');
  }
  if (/type\s*===?\s*["']tool\.response["']/.test(html)) {
    add('listens for message.type:"tool.response" — the host replies with "mcp-result".');
  }
  if (/\btype\s*(?:!==?|===?)\s*["']adas-host["']/.test(html)) {
    add('compares a message\'s type to "adas-host" — the host identifies itself with source:"adas-host" (message.type is "init", "mcp-result", …), so this listener never matches a host message.');
  }

  return problems;
}


async function verifyWidgetHealth(solution_id, sid) {
  // 1. Declared plugins — solution.ui_plugins[]
  let declared = [];
  try {
    const def = await get(apiPath`/deploy/solutions/${solution_id}/definition`, sid);
    const sol = def?.solution || def?.definition || def || {};
    declared = Array.isArray(sol.ui_plugins) ? sol.ui_plugins : [];
  } catch (e) {
    return { ok: false, error: `widget health: could not read solution definition — ${e.message}` };
  }

  // 2. Live catalog — what Core actually discovered/serves right now. Includes
  // CONNECTOR-BUNDLED widgets that render WITHOUT being declared in ui_plugins[],
  // so we must consult it even when ui_plugins is empty (was the bug: verify
  // reported "no widgets declared / checked 0" while 16 widgets were live).
  // Go through the Builder proxy (reliable from any connection), NOT
  // ADAS_CORE_URL directly (unreachable from remote/desktop MCP).
  let live = [];
  try {
    const data = await get(apiPath`/deploy/solutions/${solution_id}/ui-plugins`, sid);
    live = Array.isArray(data?.plugins) ? data.plugins : [];
  } catch (e) {
    return { ok: false, error: `widget health: could not read live plugin catalog — ${e.message}` };
  }
  const liveById = new Map(live.map((p) => [p?.id, p]));

  // Nothing declared AND nothing served → genuinely no widgets.
  if (declared.length === 0 && live.length === 0) return null;

  // Nothing declared but connectors SERVE widgets → verify the live
  // (connector-bundled) set instead of falsely reporting "no widgets".
  if (declared.length === 0) {
    const plugins = live.map((p) => {
      const render_ok = _widgetHasRender(p?.render);
      return {
        id: p?.id || "(missing)", discovered: true, render_ok, source: "connector-bundled",
        problems: render_ok ? [] : ["no usable render block — need render.mode + iframeUrl (iframe) or reactNative.component (RN)"],
      };
    });
    const unhealthy = plugins.filter((p) => p.problems.length);
    return {
      ok: unhealthy.length === 0,
      checked: plugins.length,
      note: `${plugins.length} connector-bundled widget(s) served by connectors (none declared in solution.ui_plugins[])`,
      plugins,
      issues: unhealthy.flatMap((p) => p.problems.map((pr) => `${p.id}: ${pr}`)),
    };
  }

  // 3. Cross-check each declared plugin against live discovery + render block
  const plugins = declared.map((d) => {
    const id = typeof d === "string" ? d : d?.id;
    const problems = [];
    const found = id ? liveById.get(id) : null;
    if (!id) {
      problems.push("ui_plugins entry has no id");
    } else if (!found) {
      problems.push("not discovered by Core — the owning connector's ui.listPlugins does not return this id (check the plugin id, and that the connector is ui_capable + deployed)");
    }
    const render = found?.render || (typeof d === "object" ? d?.render : null);
    const render_ok = _widgetHasRender(render);
    if (found && !render_ok) {
      problems.push("no usable render block — need render.mode + iframeUrl (iframe) or reactNative.component (RN)");
    }
    return { id: id || "(missing)", discovered: !!found, render_ok, problems };
  });

  // 4. PROTOCOL CHECK on the served HTML. Steps 1-3 prove a widget is declared,
  //    discovered and renderable — none of which catches a widget that renders
  //    and then silently times out on every call.
  //    Read the SOURCE we serve rather than fetching the rendered iframe: the
  //    source is what a fix would edit, and it needs no browser or signed URL.
  //    Plugin ids are `mcp:<connector>:<name>`, so one source read per connector
  //    covers all of its widgets.
  const connectorsSeen = new Map();   // connectorId -> [{path, content}]
  for (const p of plugins) {
    const connectorId = String(p.id || "").startsWith("mcp:") ? String(p.id).split(":")[1] : null;
    if (!connectorId) continue;
    if (!connectorsSeen.has(connectorId)) {
      try {
        const src = await get(apiPath`/deploy/solutions/${solution_id}/connectors/${connectorId}/source`, sid);
        connectorsSeen.set(connectorId, Array.isArray(src?.files) ? src.files : []);
      } catch {
        connectorsSeen.set(connectorId, []);   // unreadable source is not a verdict
      }
    }
    const html = (connectorsSeen.get(connectorId) || [])
      .filter((f) => /ui-dist\/.*\.html$/.test(f?.path || ""))
      .map((f) => f?.content || "")
      .join("\n");
    const protoProblems = _widgetProtocolProblems(html);
    if (protoProblems.length) {
      p.problems.push(...protoProblems);
      p.fix_with = `Fix the widget's postMessage code and redeploy: ateam_github_patch(solution_id, "connectors/${connectorId}/ui-dist/<widget>/index.html", ...) then ateam_upload_connector(solution_id, "${connectorId}", github:true). The exact working shape is in ateam_get_examples(type:"ui-plugin-iframe").`;
    }
  }

  const unhealthy = plugins.filter((p) => p.problems.length);
  return {
    ok: unhealthy.length === 0,
    checked: plugins.length,
    healthy: plugins.length - unhealthy.length,
    plugins,
    ...(unhealthy.length && {
      issues: unhealthy.map((p) => `${p.id}: ${p.problems.join("; ")}`),
      hint: "A declared widget Core doesn't discover will render as a blank panel. If the connector was scaffolded by ateam_create_connector, confirm the plugin's ui-dist/<plugin>/manifest.json deployed; for a hardcoded-list connector, add the plugin to its ui.listPlugins/getPlugin. Re-check with ateam_get_widget_catalog.",
    }),
  };
}

// ─── Dotted-field resolver ─────────────────────────────────────────
//
// Given an object and a dotted field name, walk down the path creating
// missing intermediate objects, and return { parent, leaf } so the caller
// can mutate parent[leaf] directly. Used by ateam_patch's _push / _delete /
// _update mutators so they correctly traverse "intents.supported" instead
// of creating a top-level key with a literal dot in its name. (That bug
// silently corrupted skill.json with three different copies of the same
// field — see the bug report from the parallel agent.)
function _resolveDottedField(obj, dottedPath) {
  const parts = dottedPath.split('.');
  let parent = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!parent[k] || typeof parent[k] !== 'object' || Array.isArray(parent[k])) {
      parent[k] = {};
    }
    parent = parent[k];
  }
  return { parent, leaf: parts[parts.length - 1] };
}

// ─── Protected array fields (v0.4.0 sibling-loss guard) ─────────────
//
// Historically, `ateam_patch(target:"solution", updates:{ linked_skills:["only-one"] })`
// silently REPLACED the whole linked_skills array — wiping every other
// skill wired into the solution. Same footgun on ui_plugins, handoffs,
// grants, connectors, etc. The Solution Builder skill hit this in the
// wild and wiped a tenant's whole solution.
//
// From v0.4.0, ateam_patch REFUSES a bare array-replace on any of these
// fields unless the caller explicitly opts in via one of:
//   updates: { _replace: true, linked_skills: [...] }        // object-level
//   updates: { linked_skills: [...], linked_skills_replace: true } // field-level
// To ADD or REMOVE without opt-in, use the _push / _delete / _update
// suffix pattern that has always been the correct form.
const SOLUTION_ARRAY_FIELDS = new Set([
  'linked_skills',
  'ui_plugins',
  'platform_connectors',
  'handoffs',
  'grants',
  'triggers',
  'notification_routes',
  'channels',
  'actor_types',
  'admin_roles',
  'plugins',
  'security_contracts',
  'connectors',
  'skills',
]);

const SKILL_ARRAY_FIELDS = new Set([
  'tools',
  'connectors',
  'handoffs',
  'scenarios',
  'triggers',
  'notification_routes',
  'plugins',
  'bootstrap_tools',
]);

// Returns { ok:false, ... } if the write would REPLACE a protected array
// without an explicit opt-in; returns null if the write is safe to proceed.
function _guardArrayReplace({ target, key, value, current, updates }) {
  const knownFields = target === 'skill' ? SKILL_ARRAY_FIELDS : SOLUTION_ARRAY_FIELDS;
  if (!knownFields.has(key)) return null;
  if (!Array.isArray(value)) return null;
  const currentArr = Array.isArray(current) ? current : [];
  if (currentArr.length === 0) return null; // nothing to lose
  if (updates && updates._replace === true) return null;
  if (updates && updates[key + '_replace'] === true) return null;

  // Compute what would be dropped so the error message is actionable.
  const keyOf = (item) => (item && typeof item === 'object') ? (item.id ?? item.name ?? JSON.stringify(item)) : item;
  const newKeys = new Set(value.map(keyOf));
  const dropped = currentArr.map(keyOf).filter(k => !newKeys.has(k));
  const kept = currentArr.map(keyOf).filter(k => newKeys.has(k));
  const wouldAdd = value.map(keyOf).filter(k => !currentArr.map(keyOf).includes(k));

  return {
    ok: false,
    phase: 'patch',
    error:
      `⚠️ REFUSED: bare-array replace on ${target}.${key} would drop ${dropped.length} sibling item(s): ` +
      `[${dropped.slice(0, 8).join(', ')}${dropped.length > 8 ? ', ...' : ''}]. ` +
      `This footgun wiped a whole solution in the wild — v0.4.0 refuses it by default. ` +
      `\n\nWhat to do instead:` +
      `\n  • To ADD items: updates: { "${key}_push": ${JSON.stringify(wouldAdd)} }` +
      (dropped.length ? `\n  • To REMOVE items: updates: { "${key}_delete": ${JSON.stringify(dropped)} }` : '') +
      `\n  • To FULLY REPLACE (rare): updates: { "${key}": [...], "${key}_replace": true }` +
      `\n  • To replace many arrays in one call: updates: { _replace: true, "${key}": [...] }`,
    dropped_ids: dropped,
    kept_ids: kept,
    would_add: wouldAdd,
    safe_alternatives: {
      push: { [`${key}_push`]: wouldAdd },
      ...(dropped.length && { delete: { [`${key}_delete`]: dropped } }),
      force_replace: { [key]: value, [`${key}_replace`]: true },
    },
  };
}

// ─── Deletes: what they do, and how a forced solution delete answers ─
//
// SAID ONCE. The tool descriptions, the refusals and the preview's _next all
// quote these, so what a caller reads before a delete cannot drift between
// them. The recovery sentences are CORE's (2026-09-27). They replace "RECOVERY:
// ateam_github_pull rebuilds from main", which named a repo the delete itself
// empties, and a recovery for runtime data that has none.
const DELETE_SOLUTION_EFFECT =
  "It removes EVERY skill and connector from the tenant's Core registry, including any ORPHAN that no longer " +
  "belongs to a solution, and deletes the solution record and its Builder records. It WIPES the tenant's " +
  "conversations and history, memory facts and stored actor data, and clears the voice configuration. It KEEPS " +
  "the tenant account, its members and its settings.";
const GIT_RECOVERY =
  "Code and config can be recovered from git history, and rolling main back to a prod tag restores the files.";
const DELETE_SOLUTION_RECOVERY =
  `${GIT_RECOVERY} Conversations, memory and stored data are gone and cannot be recovered.`;

// THE BUILDER'S SOLUTION-ID RULE, the same pattern (apps/backend/src/store/
// solutions.js validateSolutionId). The id is a PATH SEGMENT. It was pasted
// into the URL raw, so solution_id:"walkmate?force=true" turned a PREVIEW into
// a forced delete that no confirm had approved, and "../x" left the route. An
// id the Builder would refuse is refused here before any request is sent, and
// every path still encodes it. Exported for the test that holds it to the
// Builder's pattern.
export const SOLUTION_ID_RX = /^[a-z0-9][a-z0-9_-]{0,127}$/i;

// ONE ATTEMPT, ANSWERED BEFORE THE EDGE GIVES UP. Cloudflare answers 524 at
// ~100s, and CORE budgets the whole delete at ~90s end to end (Core's job stop
// alone may take 20s). 95s is past the delete's budget and under the edge's.
// It used to be the request default: 120s, with two silent re-sends.
const FORCE_DELETE_TIMEOUT_MS = 95_000;

// Stopped part-way, and re-running finishes it: every step is idempotent for
// exactly this (Core Docs/SOLUTION_DELETE_CONTRACT.md).
const DELETE_RERUN_SAFE = new Set([
  "SOLUTION_TEARDOWN_INCOMPLETE", "SOLUTION_RESET_INCOMPLETE", "GITHUB_CLEANUP_INCOMPLETE",
]);
// The server answered, but only to say that what it waited on did not.
const DELETE_NO_ANSWER_CODES = new Set(["BUILDER_NO_ANSWER", "CORE_NO_ANSWER"]);

// Until the Builder joins a delete already in flight (its PR-1), re-issuing
// starts a second run, so the preview comes first.
const deleteNoAnswerNext = (id) =>
  `The delete may have run. Call the preview first (ateam_delete_solution(solution_id:"${id}") without force), ` +
  "then re-issue the forced delete only if it still shows the solution.";

// The socket died after the request went out: it may have run.
const SOCKET_LOST = new Set(["ECONNRESET", "UND_ERR_SOCKET", "EPIPE"]);

function forceDeleteNext(code, status, id, sid) {
  if (status === 504 || status === 524 || DELETE_NO_ANSWER_CODES.has(code)) return deleteNoAnswerNext(id);
  if (DELETE_RERUN_SAFE.has(code)) {
    return `The delete stopped part-way (${code}); the steps above say what ran. Re-running is safe and finishes it: ` +
      `ateam_delete_solution(solution_id:"${id}", confirm:true, confirm_solution_id:"${id}", force:true).`;
  }
  if (code === "SOLUTION_NOT_FOUND" || status === 404) {
    return `Do not retry: there is no solution "${id}" in this tenant, so nothing was deleted. ateam_list_solutions shows its id.\n${notInThisWorkspace(signInContext(sid))}`;
  }
  if (status === 401 || status === 403) {
    return "Do not retry: this key may not delete the solution, and the same call gets the same refusal. Fix the credentials first.";
  }
  if (status === 400) return "Do not retry: the request was refused as invalid. Fix what `error` says first.";
  return "The delete did not finish, and `error` above says where it stopped. It was NOT re-sent. Before issuing it " +
    `again, run the preview (ateam_delete_solution(solution_id:"${id}") without force) to see what is still there.`;
}

/**
 * What a forced delete that did not succeed hands back. It is sent ONCE
 * (retries:0), so this is the only answer the caller gets.
 *   - Nothing was sent (a refused connection): thrown as is.
 *   - The server answered: a verdict with a `code` (jsonVerdictOf), or any
 *     JSON 4xx. That body whole, plus http_status and a _next from its code.
 *   - Anything else: NO_ANSWER, and the delete may have run. That covers this
 *     call's timeout, a 5xx without a code (a gateway page, a Cloudflare 520,
 *     or the skill-validator's own {ok:false,error} for a hop it lost), and a
 *     socket that died after the request went out. A body that came with it
 *     is kept under `upstream`.
 */
function forceDeleteFailure(err, id, sid) {
  if (err?.neverSent) throw err;
  const status = err?.status;
  const body = jsonBodyOf(err?.body);
  const answer = jsonVerdictOf(err?.body) || (status >= 400 && status < 500 ? body : null);
  if (answer) {
    return { ...answer, ok: false, http_status: status, _next: forceDeleteNext(answer.code, status, id, sid) };
  }
  if (status >= 400 && status < 500) throw err;
  if (isTimeoutError(err) || status >= 500 || SOCKET_LOST.has(err?.cause?.code)) {
    const what = err.timedOut ? `no answer within ${FORCE_DELETE_TIMEOUT_MS / 1000}s`
      : status ? `HTTP ${status} with no verdict (no \`code\`)`
      : `the connection was lost after the request was sent (${err.cause?.code || err.message})`;
    return {
      ok: false,
      code: "NO_ANSWER",
      solution_id: id,
      http_status: status ?? null,
      error: `No verdict came back for the forced delete of "${id}" (${what}). It was sent once and NOT re-sent.`,
      ...(body && { upstream: body }),
      _next: deleteNoAnswerNext(id),
    };
  }
  throw err;
}

/**
 * ONE answer to "may an async kick that failed be sent again the old,
 * synchronous way?" Only when the kick provably never reached the server
 * (api.js marks a refused connection `neverSent`), or when the server said it
 * has no such door (404/405). Any other failure means the server may have
 * started the work: re-sending it is a second write, so the caller gets what
 * happened. The sync fallback was taken on ANY failure (redeploy, github_pull,
 * upload_connector, create_plugin): a JSON 502 verdict or a kick that took
 * longer than 30s was sent again.
 * @param {any} err  the error the async kick threw
 * @returns {boolean}
 */
function kickFallsBackToSync(err) {
  return err?.neverSent === true || err?.status === 404 || err?.status === 405;
}

/**
 * monitoring.latency_ms_p95 of every tool that reaches the connector upload
 * route (/deploy/solutions/<id>/connectors/<id>/upload). Core reads this field
 * from tools/list to size the tool's timeout (ai-dev-assistant
 * connectorManager.js timeoutForTool: ×4, capped at 300s, never below its 30s
 * default). The upload runs npm install + build + a connector restart: ~34s on
 * K15 (2026-09-28), up to ~7 min (61f5399). So the 30s default cut it off —
 * run 4's in-app ateam_create_plugin died "HTTP connector timeout after
 * 30000ms". NOT a measured p95: 75s is the smallest value whose ×4 reaches
 * Core's 300s cap. Core's own observed latency outranks it once it has samples.
 */
const CONNECTOR_UPLOAD_P95_MS = 75_000;

/**
 * WHAT ateam-mcp SAYS ABOUT AN UPLOAD THAT WOULD DROP FILES CORE CANNOT HAND
 * BACK — ONE place (Builder #160, AM50-R4). Core cannot return a binary or a
 * file over 512 KB, so a merge that does not carry one deletes it. The Builder
 * refuses that (409 UPLOAD_WOULD_DELETE, would_delete_unreadable) unless
 * replace:true accepts the loss. Whether it refuses always, only with if_absent,
 * or only warns is still open on the Builder's side: when it changes, change
 * these strings and the pins in test/create-connector-never-destroys.test.mjs,
 * and nothing else. Used by ateam_upload_connector (merge mode, replace) and by
 * the refusal ateam_create_plugin hands back.
 */
const UPLOAD_DROPS_UNREADABLE = {
  mergeMode: "except a binary or a file over 512 KB that Core runs: dropping it is refused (409 UPLOAD_WOULD_DELETE) unless replace:true",
  replaceParam: "It is also the only way to accept dropping a binary or a file over 512 KB that Core runs (otherwise 409 UPLOAD_WOULD_DELETE).",
  refusal: (what, lost) => `Adding ${what} would delete files Core runs and the Builder cannot read back${lost}. Nothing was uploaded.`,
  next: (args) => [
    `ateam_get_deployed_connector_source(${args}) lists what Core runs; get those files into the connector's source or repo so the upload carries them, then try again`,
    `ateam_upload_connector(${args}, files, replace:true) accepts the loss, and deletes everything the upload does not send: only if that is meant`,
  ],
};

// ─── Tool definitions ───────────────────────────────────────────────

export const tools = [
  // ═══════════════════════════════════════════════════════════════════
  // CORE TOOLS — the simplified developer loop
  // ═══════════════════════════════════════════════════════════════════

  {
    name: "ateam_bootstrap",
    core: true,
    description:
      "REQUIRED onboarding entrypoint for A-Team MCP. MUST be called when user greets, says hi, asks what this is, asks for help, explores capabilities, or when MCP is first connected. Returns platform explanation, example solutions, and assistant behavior instructions. Do NOT improvise an introduction — call this tool instead.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "ateam_auth",
    core: true,
    description:
      "Sign this session in to an A-Team workspace (tenant) with an API key — for a caller that holds the key OUTSIDE the chat: a local (stdio) ateam-mcp process reading it from a file, a platform proxy, a script, a self-hosted setup. A session must be signed in before any workspace operation. " +
      `${NO_SIGN_IN_NEEDED}\n\n` +
      `${NO_KEY_IN_CHAT}\n\n` +
      "How a user signs in depends on how this server is connected (the hosted connector signs in in the browser, with no ateam_auth call): ateam_bootstrap's `session` field says which workspace this session is on and gives the steps that apply to it.\n\n" +
      `${KEY_PICKS_ENVIRONMENT} ` +
      "An ADAS_API_KEY environment variable does NOT sign a session in: a key baked into a shared config could point work at the wrong workspace, so workspace tools refuse until the session signs in. For cross-tenant admin operations, use master_key instead of api_key.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: {
          type: "string",
          description: `An A-Team API key held outside the chat — never one a user typed or pasted into it. ${KEY_PICKS_ENVIRONMENT}`,
        },
        master_key: {
          type: "string",
          description: "Master key for cross-tenant operations. Authenticates across ALL tenants without per-tenant API keys. Requires tenant parameter.",
        },
        tenant: {
          type: "string",
          description: "Tenant (workspace) name, e.g. acme. Leave it out with api_key: the key names its own workspace (ateam_auth asks the API when the key does not spell it out). REQUIRED with master_key.",
        },
        url: {
          type: "string",
          description:
            "Only for a host other than A-Team's own API (localhost, a self-hosted deployment), or for an older key that names no API (adas_<tenant>_<hex>, which otherwise lands on this server's default API). " +
            "Leave it out for a current A-Team key: the key already names its API, and a url that contradicts it is refused.",
        },
      },
    },
  },
  {
    name: "ateam_get_spec",
    core: true,
    description:
      "Get the A-Team specification — schemas, validation rules, system tools, agent guides, and templates. Start here after bootstrap to understand how to build skills and solutions. Use 'section' to get just one part of the skill spec (much smaller than the full spec). Use 'search' to find specific fields or concepts across the spec. Needs no sign-in. Every answer carries `served_by`: the environment whose API answered (prod or dev, or the API base itself for any other host), the API this session talks to, so two environments' docs are never read as one.\n\nWhen designing a persona that orchestrates logic via run_python_script (the Python-as-orchestrator pattern), also fetch topic='python_helpers' — that returns the adas.* helper namespace reference. Skills designed without knowing about adas.* produce 5-10x larger / brittler scripts.\n\nWhen wiring widgets (UI plugins) into a solution, fetch topic='widgets' — that returns the widget spec (catalog model, how_to_use blocks, opener_call shape, persona phrasing rules, binding semantics) so you can declare `ui_plugins` correctly. For the live catalog of widgets actually available in a deployed tenant, use ateam_get_widget_catalog instead.",
    inputSchema: {
      type: "object",
      properties: {
        // Three lines below POINT at the Builder's homes rather than copy them:
        // - 'widgets' (2fc571c) and 'ui-plugins' never named the read that
        //   returns data_fidelity whole: DATA_FIDELITY_AT, above.
        // - 'ui-plugins' said "the DEEP React Native (mobile) plugin build
        //   guide … before authoring any MOBILE widget" (d7b92aa). The page
        //   (Builder spec.js buildUIPluginsSpec) is the build guide for iframe,
        //   react-native and adaptive: overview.render_modes, manifest_schema,
        //   device_tools, react_native_plugin_guide, iframe_plugin_guide,
        //   deployment.
        // - 'triggers' (a05eb2b) said only that a time word is a trigger. A
        //   recurring check the user gave no cadence for is answered by
        //   /spec/triggers decision_guide.implied_repetition_without_cadence
        //   (Builder #128, 3bc59da6): ask, add no trigger.
        topic: {
          type: "string",
          enum: ["capabilities", "realizations", "overview", "skill", "solution", "enums", "connector-multi-user", "python_helpers", "widgets", "ui-plugins", "actor-storage", "voice", "voice-native", "triggers", "sub-agent", "consumer-roles", "mobile-connector", "device-capabilities", "host-contract", "platform-connectors", "platform-truth", "sdk", "workflows", "finalization", "monitoring"],
          description:
            "What to fetch: 'realizations' = HOW to build a capability: for each one the valid physical routes with use_when / do_not_use_when / execution / freshness, so device-dependent design picks a route deliberately instead of by accident. 'capabilities' = START HERE IF YOU ARE NEW — the capability index, organised by what a solution DOES rather than by our build artifacts: can I see what the user sees? talk with them out loud? know where they are and that they are moving? act while they sleep? remember each user? show them something? Each question gets a one-word answer (yes / yes-with-gaps / not yet / unknown) and the topics to read next. Every other topic below is named after an ARTIFACT, so if you do not already know our vocabulary this is the only door you can find by thinking about your own problem. 'overview' = API overview + endpoints, 'skill' = full skill spec, 'solution' = full solution spec, 'enums' = all enum values, 'connector-multi-user' = multi-user connector guide, 'python_helpers' = adas.* helper namespace for run_python_script orchestration (read this when designing personas that read state → call tools → checkpoint → status; without it, scripts hand-roll JSON parsing and tool delegation = 5-10x larger and brittler), 'widgets' = widget (UI plugin) spec: catalog model, how_to_use block shape (solution.json snippet + opener_call + persona_phrasing + binding_notes), rules for declaring ui_plugins, and sections.data_fidelity: what a plugin that shows data must render, and when a test that wrote records is done. A plain read can arrive with that section stubbed (one response holds 50,000 characters), so read it whole with " + DATA_FIDELITY_AT + ". Pair with ateam_get_widget_catalog for the live per-tenant inventory. 'ui-plugins' = the UI plugin BUILD guide for every render mode: iframe (HTML under ui-dist/, rendered by the web and by the phone's WebView), react-native (phone only) and adaptive (both) — the manifest schema, the postMessage protocol, device tools, deployment, and the deep React Native build (author in rn-src/, compile with a build:rn esbuild script (format=cjs, target=es2015, external react/react-native/@adas/plugin-sdk) to rn-bundle/index.bundle.js, plain-object export). Read it before authoring any widget. What a plugin that shows data must render is read whole with " + DATA_FIDELITY_AT + " (that page only points there). 'device-capabilities' = THE DEVICE CAPABILITY MATRIX, GENERATED from the mobile SDK's own artefacts and stamped with their hashes: every native.* API (mechanical one-shot verbs), every deviceState.* domain (semantic state a reasoning loop reads, with freshness + confidence) and every server-called device.* tool, each with status (done / partial / shape-only / missing) and what is left. READ THIS before concluding the phone cannot do something — camera, video, scanning, vision, sensors, location, on-device storage. Absence from any other spec topic is NOT evidence. 'mobile-connector' = building functional connectors (background services) for ateam-mobile that use device capabilities through the Native Bridge SDK. 'actor-storage' = per-actor storage (production): a per-(tenant, actor, skill) SQLite database served by the actorstore-mcp platform connector — read this instead of hand-rolling per-user isolation in a connector. 'consumer-roles' = role-based access for your solution's END-USERS: you declare the config, the platform resolves and enforces one RoleProfile per request (roles decide WHO may act; actor-storage decides WHOSE data they touch). 'triggers' = the ONLY way a skill acts proactively — on a schedule or an event, with no user message; read before designing anything that must happen by itself, decision_guide first: any time word in a requirement (every day, at 8, weekly) is a trigger; a recurring check the user gave no cadence for gets none (ask, add no trigger: decision_guide.implied_repetition_without_cadence); and a trigger is done only when ateam_get_solution(view:'triggers') shows it registered:true with a next run and system_halted:false — anything less is not done: report what that result's done_rule says. 'sub-agent' = sub-agents are a TOOL CALL (sys.callAiWithTools with a curated toolNames set), not a definition-level construct; caveats stated inline. 'voice' = the voice channel: phone (Twilio) and web/mobile callers reach the SAME skill runtime as chat — what you control (solution.voice, routing.voice.default_skill, a per-skill voice block, ateam_test_voice) and what you do not. 'voice-native' = the exception to that model: a `voice_native` block puts a skill inside the live audio loop (persona layer, one server skill tool, plus local device tools), with the boundaries that come with it. 'platform-connectors' = the built-in platform connectors (memory, browser, gmail, whatsapp, …) with their LIVE tool schemas and the inter-connector calling pattern — read before writing a connector that duplicates one. 'sdk' = the @ateam-ai/sdk runtime API reference (platform, context, memory, progress, log, llm) for custom connector and skill code. 'host-contract' = the normative boundary between a host shell (mobile app, web shell, kiosk, watch) and the solutions it renders: ownership matrix, forbidden host behaviours, host capability allow-list — read when reviewing a host or designing a portable solution. 'platform-truth' = does this deployment's published sys.* tools and platform connectors agree with what the RUNNING Core exposes (including planner visibility)? Answers agrees:null when Core cannot be reached, never silence. 'workflows' = the Builder's step-by-step state machines for building skills and solutions (the same document ateam_get_workflows returns). 'finalization' = HOW A SKILL'S RUN ENDS, every way: finish with sys.finalizePlan, ask with sys.askUser, hand off with sys.handoffToSkill, or let role.finalize_tool decide; the checks a reply goes through before it goes out; what the platform does when a skill does not finish (step and stuck-loop limits); what a skill that called yours sees (ok, infra_ok, how long it waits); the settings that do nothing; and what does not work yet. It is the finalization part of the skill spec, returned whole. 'monitoring' = THE MONITORING CONTRACT: which tools are safe to call in a poll loop (with cost / poll interval / whether output stays bounded as the run grows), which are not and what to use instead, plus the running ateam-mcp version. Read this BEFORE writing any loop that watches a build — the safe poll is ateam_chain_status, never ateam_get_chain.",
        },
        section: {
          type: "string",
          enum: ["engine", "tools", "intents", "policy", "triggers", "connectors", "role", "template", "guide"],
          description:
            "Optional: get just one section of the skill spec (only works with topic='skill'). Sections: 'engine' = model/reasoning/planner optimization/bootstrap tools, 'tools' = tool definitions/meta tools, 'intents' = intents/problem/scenarios, 'policy' = access control/grants/workflows, 'triggers' = automation triggers, 'connectors' = connector linking/channels, 'role' = persona/goals, 'template' = minimal quick start, 'guide' = build steps/common mistakes",
        },
        search: {
          type: "string",
          description:
            "Optional: filter the spec to only sections containing this search term. Works with any topic. Example: search='bootstrap' returns only fields/sections mentioning 'bootstrap'.",
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "ateam_get_workflows",
    core: true,
    description:
      "Get the builder workflows — step-by-step state machines for building skills and solutions. Use this to guide users through the entire build process conversationally. Returns phases, what to ask, what to build, exit criteria, and tips for each stage.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "ateam_get_examples",
    core: true,
    description:
      "Get complete working examples that pass validation. Study these before building your own.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          // From the one owner (src/exampleTypes.js), so the schema cannot
          // accept a type the handler cannot serve, or refuse one it can.
          enum: [...EXAMPLE_TYPES],
          description:
            "Example type: 'skill' = Order Support Agent, 'connector' = stdio MCP connector, 'connector-ui' = UI-capable connector, 'solution' = full 3-skill e-commerce solution, 'script-cache-skill' = fat-tool skill with script_cache opt-in (reference implementation of script-level JIT shortcuts — study this before building any browser-automation skill), 'ui-plugin-native' = complete working React Native (mobile) UI plugin (rn-src/index.tsx + esbuild build:rn → rn-bundle, @adas/plugin-sdk, es2015), 'ui-plugin-iframe' = complete working web (iframe) UI plugin with the postMessage protocol, 'device-tools' = a solution's OWN tools that execute ON THE PHONE (runtime:\"device\") — BOTH halves and why they must agree: the plugin-bundle implementation, the connector manifest that declares it (Core cannot introspect a phone, so the manifest is the entire contract), and the skill wiring without which the skill gets none of them. Read this before designing anything that needs a LIVE device reading rather than the last synced one, 'index' = list all available examples",
        },
      },
      required: ["type"],
    },
  },
  {
    name: "ateam_design_advisor",
    core: true,
    // MEASURED, not estimated. 6 successful calls against dev on 2026-08-21,
    // distinct goals, spaced to avoid provider rate-limiting:
    //   19048 21123 23359 23739 24462 24699 ms  (median 23.7s, max 24.7s)
    // It is ONE LLM call over the capability catalog, so the cost is provider
    // latency and there is no meaningful warm path to under-report.
    //
    // WHY IT MATTERS: Core derives its timeout from this (p95 x 4, floored at
    // 30s). Undeclared, the advisor sat under a 30s default while taking ~25s —
    // one bad provider spike from failing, and it failed exactly that way on
    // 2026-08-21 ("HTTP connector timeout after 30000ms"). It is also the FIRST
    // call a building agent makes and it carries the storage decision, so when
    // it times out the run proceeds with no capability guidance at all.
    monitoring: { safe: true, cost: "normal", latency_ms_p95: 25000, output: "bounded" },
    // CORE CUTS EVERY TOOL DESCRIPTION AT 1200 CHARACTERS for an agent run
    // (ai-dev-assistant anthropicAgentBackend.js, openaiAgentBackend.js,
    // sys.callAiWithTools.js), and the in-app solution builder makes every
    // ateam_* call inside one. So this whole text stays within 1200, with the
    // failure sentence second (test/advisor-failure-text.test.mjs).
    //
    // BUILDER-2. job_wfkgyg5o (2026-09-28) asked this with the store already
    // chosen ("Use an in-memory / JSON store in a custom MCP connector"); the
    // call failed with Core's "circuit open for <tenant>::ateam-proxy-mcp;
    // cooling down" before it left Core, nothing pushed back, and the build
    // wrote that store. This text is the one channel that reaches an agent
    // whose call never got an answer. That error names no cool-down time
    // (Core utils/circuitBreaker.js), so this does not promise one. The
    // Builder reports a conflict only for an unambiguous form and anything
    // matched by words as words_to_check (Builder #109 round 3), so the text
    // names both fields for what they are.
    description:
      "CONSULT THIS DURING DESIGN — before and while you design a skill/solution. " +
      "If this call fails, your design is unchecked: do not write storage code on a store you picked before asking. ateam_get_spec('connector-multi-user') → storage_decision answers storage with no LLM (a failure the advisor answers carries it as `storage_decision`; on a 401 it may be cut — sign in and ask again for the full answer); retry after a short wait (a 'circuit open … cooling down' error names no time). " +
      "Describe what you're building; it returns POINTERS to the capabilities that fit (storage, widgets, triggers, sub-agents, mobile data, …), each with the ateam_get_spec topic to read next and the tool to wire it, plus 'missing' and lifecycle hints. " +
      "`conflicts_with_platform_rules` names a forbidden store your design plainly uses; `words_to_check` lists words that often mean one (a 'never /tmp' is listed too): check them against storage_decision. " +
      "ADVISORY ONLY — you own the design. Stateless: pass the current design_state each call. " +
      "`truncated: true` means the answer was CUT OFF: what is there is correct, but a capability's ABSENCE proves nothing — ask again with a narrower goal, or use ateam_spec_search.",
    inputSchema: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "What you're trying to build, in your own words (e.g. 'a coach that tracks each user's meals from photos and shows a dashboard').",
        },
        design_state: {
          type: "object",
          description: "Optional. The design so far (skills, connectors, capabilities already wired) so the advisor can point at what's still missing. Pass {} at the start.",
        },
      },
      required: ["goal"],
    },
  },
  {
    name: "ateam_spec_search",
    core: true,
    description:
      "Semantic search over the FULL ateam platform /spec documentation — the deep fallback behind ateam_design_advisor. Ask a natural-language 'how do I…' question and get the most relevant doc chunks (with their topic + heading), then read the full topic via ateam_get_spec(topic); an example a hit names or points to (examples/<type>, /spec/examples/<type>) is read via ateam_get_examples(type), which ateam_get_spec does not serve. Use this when the advisor's pointer isn't enough, or for details/examples on anything — including topics outside the curated capability list. Read-only. Needs NO sign-in, tenant or LLM, so it answers when the advisor refuses a session that has not signed in. The result carries `served_by` (prod or dev, or the base itself for any other host): the environment whose docs were searched.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural-language question, e.g. 'how do I send a proactive daily reminder?' or 'per-user persistence'.",
        },
        top_k: {
          type: "number",
          description: "How many chunks to return (default 8, max 25).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "ateam_build_and_run",
    core: true,
    // Reaches the upload route for each connector in mcp_store (connector_restart).
    monitoring: { safe: false, cost: "heavy", latency_ms_p95: CONNECTOR_UPLOAD_P95_MS, output: "bounded" },
    description:
      "DEPLOY THE CURRENT MAIN BRANCH TO A-TEAM CORE. ⚠️ HEAVIEST OPERATION (60-180s): validates solution+skills → deploys all connectors+skills to Core (regenerates MCP servers) → health-checks → optionally runs a warm test → then ateam_github_push (when it runs: its /spec entry).\n\n" +
      `OVER A HOSTED CONNECTION (HTTP), which is cut off after ~100s without an answer, the call answers within ${HOSTED_CALL_BUDGET_MS / 1000}s. A run not finished by then answers status:"running" with a run_id and goes on: nothing is stopped or sent again. ` +
      "ateam_build_and_run(solution_id, resume:true, run_id) then answers with THAT run's result (waiting up to the same time again) and deploys nothing. A local (stdio) connection waits for the whole run.\n\n" +
      "🌳 DEV/PROD WORKFLOW:\n" +
      "  1. Edit files → ateam_github_patch (writes to `dev` branch by default)\n" +
      "  2. (Optional) Preview what's about to ship → ateam_github_diff\n" +
      "  3. Ship dev → main → ateam_github_promote (merges + auto-tags `prod-YYYY-MM-DD-NNN`)\n" +
      "  4. Deploy main to Core → ateam_build_and_run\n\n" +
      "Whatever you do not pass inline comes from the `main` branch — there is no `ref` parameter. A part you DO pass (solution, skills, mcp_store) deploys as you sent it. To TEST dev work without shipping it, use the iterate tools (ateam_patch, ateam_upload_connector, ateam_redeploy), which deploy from `dev`; to SHIP it, promote first.\n\n" +
      "AUTO-DETECTS GitHub repo: if you omit mcp_store and a repo exists, connector code is pulled from main automatically. First deploy requires mcp_store. After that, edit via ateam_github_patch + promote, then build_and_run. For small changes prefer ateam_patch (faster, incremental). Requires authentication.\n\n" +
      "REFUSED, before anything is saved or deployed (409 UNPUSHED_BUILDER_CHANGE, naming the files), while a solution or skill file it would take from `main` holds a Builder change that no branch has: a Builder save held off `dev` (after a ref:'main' hotfix or a rollback) or one whose push to GitHub failed. Deploying would overwrite it and it would exist nowhere. " +
      "Place it: ateam_redeploy(solution_id) — the whole solution, not one skill — writes the Builder's copy of solution.json and of every skill to `dev` (run ateam_github_sync_from_main first when the file holds a hotfix — ateam_redeploy says so; its not_written_to_github says what it could not place), then ateam_github_promote and deploy again. Or drop it: ateam_github_pull(solution_id, discard_builder_changes:true) replaces the Builder's copy with `dev`'s.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID. Use this INSTEAD of passing the full solution object — the solution definition is auto-pulled from main. Required if solution object is omitted.",
        },
        solution: {
          type: "object",
          description: "Full solution definition. Required on first deploy. After first deploy, just pass solution_id instead — everything is auto-pulled from GitHub main.",
        },
        skills: {
          type: "array",
          items: { type: "object" },
          description: "Optional after first deploy: skill definitions. If omitted, auto-pulled from main (skills/{id}/skill.json).",
        },
        connectors: {
          type: "array",
          items: { type: "object" },
          description: "Optional: connector metadata (id, name, transport). Entry points auto-detected from mcp_store.",
        },
        mcp_store: {
          type: "object",
          description: "Optional: connector source code files. Key = connector id, value = array of {path, content}.",
        },
        github: {
          type: "boolean",
          description: "Optional: if true, pull connector source code from main. AUTO-DETECTED: if you omit both mcp_store and github, the system checks if a repo exists and pulls from main automatically.",
        },
        test_message: {
          type: "string",
          description: "Optional: send a test message after deployment to verify the skill works. Returns the full execution result.",
        },
        test_skill_id: {
          type: "string",
          description: "Optional: which skill to test (defaults to the first skill).",
        },
        resume: {
          type: "boolean",
          description: "Optional: true answers with the result of a run already started (one that answered status:\"running\") instead of deploying. Needs solution_id; every other deploy argument is ignored. Waits for the run up to the hosted call's budget again.",
        },
        run_id: {
          type: "string",
          description: "Optional, with resume:true: the run_id a status:\"running\" answer gave, so the answer is THAT run's. Omitted: the last run started for this solution with these credentials.",
        },
      },
      required: [],
    },
  },
  {
    name: "ateam_test_skill",
    core: true,
    description:
      "Send a test message to a deployed skill and get the execution result.\n\n" +
      "Wait modes (wait_for):\n" +
      "  • 'root' (default, back-compat) — wait until the message's root job completes, return single-job result. Fast, ignores any sub-skills the root delegated to via askAnySkill.\n" +
      "  • 'chain' — wait until EVERY job in the chain (root + handoffs + askAnySkill subcalls, recursively) reaches a terminal state, then return the full chain tree. Use when testing multi-skill flows (orchestrator → workers, builders → sub-builders, etc.). The response.chain field carries chainJobs[] with parentJobId/relation/depth and executionSteps[] with tool-nesting (opId/parentOpId/_toolDepth).\n\n" +
      "Legacy: wait:false is equivalent to wait_for:'never' — returns job_id immediately for polling via ateam_test_status. wait:true is the same as the default wait_for:'root'.\n\n" +
      "Attachments: pass `attachments` to send files with the message exactly as a file dropped into the chat (see the parameter).\n\n" +
      "The reply carries ran_as (with wait_for:'chain', inside response.kickoff) beside actor_id. " + TEST_RUNS_AS_AT,
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
        skill_id: {
          type: "string",
          description: "The skill ID to test (original or internal ID)",
        },
        message: {
          type: "string",
          description: "The test message to send to the skill",
        },
        wait: {
          type: "boolean",
          description:
            "Legacy: if false, return job_id immediately for polling. If true or omitted, behaves like wait_for:'root'. Prefer wait_for going forward.",
        },
        wait_for: {
          type: "string",
          enum: ["root", "chain", "never"],
          description:
            "What to wait for before returning. 'root' (default) = root job done; 'chain' = every chain job terminal (use for multi-skill flows); 'never' = return job_id immediately (poll via ateam_test_status). When 'chain', the response includes the chain tree under response.chain.",
        },
        chain_timeout_ms: {
          type: "number",
          description:
            "Optional. Max total ms to wait when wait_for:'chain'. Default 300000 (5 min). Long-running chains (skill-factory, large bundle builds) may need higher. Clamped to [10000, 900000].",
        },
        actor_id: {
          type: "string",
          description:
            "Optional: the conversation thread. Pass the actor_id from a previous test response to continue that thread. " + TEST_RUNS_AS_AT,
        },
        attachments: ATTACHMENTS_INPUT_SCHEMA,
      },
      required: ["solution_id", "skill_id", "message"],
    },
  },
  {
    name: "ateam_test_notification",
    core: true,
    description:
      "Fire a REAL notification at an existing actor in a deployed solution — for end-to-end testing of the system-initiated notification path (telegram/push/app channels).\n\n" +
      "Unlike ateam_test_skill and ateam_conversation (a test turn answered in the tool result; who it runs as: their actor_id), this calls the /api/internal/notify-user path that PCM and other sibling services use — so the actor's real enabled channels actually receive the message.\n\n" +
      "Use for:\n" +
      "  • Channel fan-out smoke (does telegram/push/app actually receive it?)\n" +
      "  • Delivery-result verification (per-channel ok/failed in the response).\n\n" +
      "Auth: forwards your authed api_key to Core (no master-secret involvement). Tenant is pinned by the key itself — cross-tenant targeting is structurally impossible.\n\n" +
      "⚠️ SAFETY:\n" +
      "  • The text is prefixed with [TEST] in the actual notification — visible to the user, anti-phishing.\n" +
      "  • Rate-limited: 10 calls/min per session.\n" +
      "  • Every call is audited (caller, tenant, actor, content hash) regardless of outcome.\n" +
      "  • actor_id is scoped to your tenant — cross-tenant targeting is rejected by Core's per-tenant Mongo isolation.\n" +
      "  • reply_handler is NOT supported via api-key auth (Core ignores it). Routing the user's next reply to an arbitrary skill is a privilege-escalation surface. For routing/engagement tests, use ateam_test_skill.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID (required for tenant scoping + audit context).",
        },
        actor_id: {
          type: "string",
          description: "Target actor ID in your tenant (e.g. 'usr_arie_admin_0001'). Must exist; Core rejects if not found in your tenant.",
        },
        content: {
          type: "string",
          description: "Notification text. Will be sent to all of the actor's enabled channels, prefixed with [TEST] for the recipient.",
        },
        urgency: {
          type: "string",
          enum: ["low", "normal", "high"],
          description: "Notification urgency. Default 'normal'.",
        },
        source: {
          type: "string",
          description: "Audit label for message.source. Default 'ateam-test'.",
        },
        metadata: {
          type: "object",
          description: "Optional metadata merged into message.metadata. Useful for correlation IDs.",
        },
      },
      required: ["solution_id", "actor_id", "content"],
    },
  },
  {
    name: "ateam_conversation",
    core: true,
    // CORE CUTS A TOOL DESCRIPTION AT 1200 CHARACTERS for an agent run
    // (ai-dev-assistant anthropicAgentBackend.js:618, openaiAgentBackend.js:242,
    // sys.callAiWithTools.js:157), and the in-app builder makes every ateam_*
    // call inside one. This one was 1,489, so that agent never read its last
    // ~290 characters (who a job runs as, attachments). It now fits whole
    // (test/conversation-continues.test.mjs). Parameter descriptions are not
    // cut there (agentSdk/toolSchema.js), so actor_id carries what is not in the
    // description.
    description:
      "Chat with a deployed solution (auto-routed; no skill_id).\n\n" +
      "ALWAYS ASYNC: returns a chain_id at once; the reply is NOT here. Poll ateam_chain_status(chain_id) every ~2s until chain_done === true (by chain, never by job); ateam_get_chain(chain_id) once at the end.\n\n" +
      "Multi-turn: " + CONVERSATION_CONTINUES + " " + REPLY_WINDOW + " " + WAITING_ON_THE_USER + " " +
      PLAY_THE_PERSON + " " + TEST_RUNS_AS_AT,
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
        message: {
          type: "string",
          description: "The message to send (e.g., 'send email to X' or 'I confirm')",
        },
        actor_id: {
          type: "string",
          description:
            "Optional: the conversation thread (the description says what continues a conversation, and the window an answer has). " +
            "ateam-mcp keeps the actor_id you pass, and the one the reply returns (a test_ id excepted), as this session's actor for later job reads such as ateam_chain_status, so pass only a real one: an id Core does not know makes those reads fail (401). " +
            TEST_RUNS_AS_AT,
        },
        attachments: ATTACHMENTS_INPUT_SCHEMA,
      },
      required: ["solution_id", "message"],
    },
  },
  {
    name: "ateam_test_pipeline",
    core: true,
    description:
      "Test the decision pipeline (intent detection → planning) for a skill WITHOUT executing tools. Returns intent classification, first planned action, and timing. Use this to debug why a skill classifies intent incorrectly or plans the wrong action.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
        skill_id: {
          type: "string",
          description: "The skill ID to test",
        },
        message: {
          type: "string",
          description: "The test message to classify and plan for",
        },
      },
      required: ["solution_id", "skill_id", "message"],
    },
  },
  {
    name: "ateam_test_voice",
    core: true,
    description:
      // It promised "the full voice pipeline … skill dispatch → response,
      // end-to-end" (32dec97), then said the voice layer was ALL a test shows.
      // Neither holds for every caller. Core c93563976 (D7, in prod since
      // prod-20260929-001): a voice test forwarded with a PERSON's API key
      // reaches the skill, the job running as that person. Core still refuses
      // the skill call for a key with no person (an anonymous run) and for a
      // phone caller (phone::<number>, an actor Core does not know) — C6. Who
      // the test runs as is the Builder's to say: the pointer.
      "Simulate a voice call with text, not audio. A person's key reaches the skill (skill job included); with no person on the key, or a phone caller, Core refuses the skill call today (C6): test it with ateam_conversation. Each turn returns response, verification, entities; ran_as repeats its actor_id.\n\n" +
      TEST_RUNS_AS_AT,
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
        messages: {
          type: "array",
          items: { type: "string" },
          description: "Array of user messages to send sequentially (simulates a multi-turn phone conversation)",
        },
        phone_number: {
          type: "string",
          description: "Optional: simulated caller phone number (e.g., '+14155551234'). If the number is in the solution's known phones list, the caller is auto-verified.",
        },
        skill_slug: {
          type: "string",
          description: "Optional: target a specific skill by slug instead of using voice routing.",
        },
        timeout_ms: {
          type: "number",
          description: "Optional: max wait time per skill execution in milliseconds (default: 60000).",
        },
      },
      required: ["solution_id", "messages"],
    },
  },
  {
    name: "ateam_patch",
    core: true,
    description:
      "Surgically update ANY field in a skill or solution definition, redeploy, and optionally re-test — all in one step.\n\n" +
      "⚠️ MERGE-BY-DEFAULT (v0.4.0) — Arrays are protected from silent replace. Bare array writes on solution.linked_skills / ui_plugins / platform_connectors / handoffs / grants / triggers (etc.) and skill.tools / connectors / handoffs / scenarios are REFUSED to prevent sibling loss. Add or remove items with the _push / _delete / _update suffixes; opt into a full-array replace only when you really mean it.\n\n" +
      "OPERATIONS (safe by construction):\n" +
      "1. Scalar (dot notation): { \"problem.statement\": \"new value\", \"role.persona\": \"You are...\" }\n" +
      "2. Deep nested: { \"intents.thresholds.accept\": 0.9, \"policy.escalation.enabled\": true }\n" +
      "3. Array APPEND: { \"tools_push\": [{ name: \"new_tool\", description: \"...\" }] }\n" +
      "4. Array REMOVE: { \"tools_delete\": [\"tool_name\"] }\n" +
      "5. Array MODIFY-ONE: { \"tools_update\": [{ name: \"existing_tool\", description: \"updated\" }] }\n" +
      "6. Full-array REPLACE (opt-in): { \"linked_skills\": [...], \"linked_skills_replace\": true } — or { _replace: true, ... } to opt every array in this call.\n\n" +
      "SOLUTION-LEVEL EXAMPLES (target='solution'):\n" +
      "- ADD a skill to the solution: updates: { \"linked_skills_push\": [\"my-new-skill\"] } ← NOT { linked_skills: [\"my-new-skill\"] } (that would REFUSE — it drops your other skills)\n" +
      "- REMOVE a skill: updates: { \"linked_skills_delete\": [\"old-skill\"] }\n" +
      "- ADD a UI plugin: updates: { \"ui_plugins_push\": [{ id: \"mcp:conn:panel\", ... }] }\n" +
      "- ADD a handoff: updates: { \"handoffs_push\": [{ id: \"h1\", ... }] }\n\n" +
      "SKILL-LEVEL EXAMPLES (target='skill' + skill_id):\n" +
      "- Change persona: updates: { \"role.persona\": \"You are a friendly assistant\" }\n" +
      "- Append to persona: updates: { \"persona_append\": \"\\n\\nALWAYS respond in 2 sentences.\" }\n" +
      "- Add a guardrail: updates: { \"policy.guardrails.never_push\": [\"Never share passwords\"] }\n" +
      "- Add a tool: updates: { \"tools_push\": [{ name: \"conn.tool\", description: \"...\", inputs: [...], output: {...} }] }\n" +
      "- Change intent: updates: { \"intents.supported_update\": [{ id: \"i1\", description: \"new desc\" }] }\n" +
      "- CREATE a new skill: target='skill', skill_id='my-new-skill', updates: { \"problem.statement\": \"...\", \"role.persona\": \"...\" } — auto-scaffolded and added to solution topology.\n\n" +
      "PREVIEW BEFORE WRITING: pass dry_run:true to see the diff (arrays_merged, arrays_replaced, dropped_ids, added_ids) without applying. Use this before any destructive-looking edit.\n\n" +
      "VERDICT (skill target): the response carries a NON-BLOCKING `validation` block { skill_id, valid, ready_to_export, error_count, incomplete_sections[], unresolved_refs } — the patch always saves (and redeploys) even if the def is now invalid, and build_and_run does not run this check (its gate is the solution validator, POST /validate/solution), so nothing refuses a skill for it: CHECK valid: false yourself and fix incomplete_sections before relying on the skill. error_count can include auto-import connector-tool artifacts, so act on incomplete_sections first.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
        target: {
          type: "string",
          enum: ["solution", "skill"],
          description: "What to update: 'solution' for solution definition, 'skill' for skill definition fields (problem, role, intents, tools, policy, engine, scenarios, etc.)",
        },
        skill_id: {
          type: "string",
          description: "Required when target is 'skill'. The skill ID to patch.",
        },
        updates: {
          type: "object",
          description:
            "The update payload. Use dot notation for nested scalars (e.g. 'problem.statement': 'new value'). " +
            "For arrays, use _push/_delete/_update suffixes (e.g. 'tools_push', 'tools_delete'). " +
            "You can update ANY field in the skill definition: problem, role, intents, tools, policy, engine, scenarios, glossary, etc.",
        },
        test_message: {
          type: "string",
          description: "Optional: re-test the skill after patching. Requires skill_id.",
        },
        dry_run: {
          type: "boolean",
          description: "If true, apply the patch in memory and return the diff (arrays_merged, arrays_replaced, dropped_ids, added_ids, would_write_bytes) WITHOUT writing to GitHub or redeploying. Preview a change before committing to it.",
        },
        source: {
          type: "string",
          enum: ["github", "local"],
          description:
            "Where the solution/skill definition lives. Omit (DEFAULT) — prefer the tenant's GitHub repo (GitHub is master), but AUTO-DEGRADE to the Builder FS store if the tenant hasn't connected a repo, so a simple def patch always succeeds (it's pushed to GitHub once connected). 'github' — force GitHub; fails loud if not connected (use when you specifically require the repo write). 'local' — force the Builder FS store, no GitHub (repo-less bootstrap tenant). Redeploy is local in all modes.",
        },
        include_definition: {
          type: "boolean",
          description: "If true, return the FULL patched definition. Default false — the result returns a compact patched_summary instead, because the full definition can exceed the ~50KB output limit and truncate the rest of the result (redeploy status, widget_health).",
        },
      },
      required: ["solution_id", "target", "updates"],
    },
  },
  {
    name: "ateam_get_solution",
    core: true,
    description:
      "Read solution state — definition, skills, health, status, or export. Use this to inspect deployed solutions.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
        view: {
          type: "string",
          enum: ["definition", "skills", "health", "status", "export", "validate", "connectors_health", "triggers"],
          description:
            "What to read: 'definition' = full solution def, 'skills' = list skills, 'health' = live health check, 'status' = deploy status, 'export' = exportable bundle, 'validate' = re-validate from stored state, 'connectors_health' = connector status, 'triggers' = every trigger each skill defines and every trigger Core has registered, each marked registered:true/false (null for an event trigger, with registered_source), with Core's state (pause, last run, next run) plus system_halted, the platform-wide trigger switch — a schedule is done only when it shows registered:true with a next run and system_halted:false. Anything less is not done: report what the result's done_rule says — system_halted_source and next_run_at_source name what Core did not report — never that the schedule will run (with skill_id: that skill only)",
        },
        skill_id: {
          type: "string",
          description: "Optional: read a specific skill by ID (original or internal)",
        },
        section: {
          type: "string",
          description: "Optional (with skill_id): return ONLY this section of the skill instead of the whole definition — avoids the ~50KB output truncation on big skills. Dotted paths work (e.g. 'role', 'tools', 'intents.supported', 'policy', 'engine'). 'tools' answers every tool the skill's deploy sends — the ones written in skill.json (authored_tools) and the ones imported from its connectors — not only the file's list. Omit for the full skill; use ateam_show_skill_minimal for the slim authoring view.",
        },
        offset: {
          type: "number",
          description: "Optional byte-paging: start returning the serialized result from this byte offset. Use with 'limit' to page a result larger than the ~50KB output cap; the response's _paging.next_offset gives the next page (null when done). Concatenate the `content` slices across pages, then JSON.parse.",
        },
        limit: {
          type: "number",
          description: "Optional byte-paging: max bytes of the serialized result to return in this page (pair with 'offset'). Omit both for the whole result (may truncate at the output cap).",
        },
      },
      required: ["solution_id", "view"],
    },
  },
  {
    name: "ateam_list_solutions",
    core: true,
    description: "List all solutions deployed in the Skill Builder.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "ateam_delete_solution",
    core: true,
    description:
      "⚠️ IRREVERSIBLE — THIS CLEARS THE WHOLE TENANT, not just the named solution. TENANT === SOLUTION. " +
      DELETE_SOLUTION_EFFECT + " " +
      "The name says 'solution'; the blast radius is the tenant. Read the tenant's skill list first " +
      "(ateam_get_solution view:'skills' or Core's registry) and know what you are destroying — an orphan from an " +
      "earlier solution is still in there and still goes. " +
      "REQUIRES `confirm:true` AND `confirm_solution_id` echoing the solution id you're destroying (defeats typos and hallucinated ids). " +
      "A forced delete is sent ONCE and never re-sent: if it answers NO_ANSWER, check with the preview before issuing it again. " +
      "RECOVERY: " + DELETE_SOLUTION_RECOVERY + " " +
      "A skill authored FS-only, or orphaned before its solution was pushed, has no copy anywhere.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID to delete. Letters, digits, '-' and '_' only: anything else is refused before any request is sent.",
        },
        confirm: {
          type: "boolean",
          description: "REQUIRED. Must be exactly true. A missing/false value refuses the call with a recovery hint.",
        },
        confirm_solution_id: {
          type: "string",
          description: "Required with force:true. Must exactly equal `solution_id`. This defeats typos and hallucinated ids — you can't wipe a solution you couldn't spell.",
        },
        force: {
          type: "boolean",
          description:
            "Omit (DEFAULT) to PREVIEW: returns will_clear — every skill and connector that would be destroyed, with " +
            "orphan_skills called out separately — and clears NOTHING. The conversations, memory and stored data a " +
            "forced delete wipes are not in that list. Pass true only after reading it. The " +
            "preview exists because a description cannot name the orphan you did not know was in the registry.",
        },
      },
      required: ["solution_id"],
    },
  },
  {
    name: "ateam_delete_skill",
    core: true,
    description:
      "⚠️ IRREVERSIBLE — kills the running MCP process, unregisters from skill registry, deletes the Mongo record, drops from solution.skills[] and solution.linked_skills, and removes the skill's files from Builder FS. " +
      "ALSO REMOVES THE SOURCE: `skills/<id>/` is deleted from the repo on BOTH dev and main in the same call. If that removal fails, the response says so under `github`. " +
      "REQUIRES `confirm:true`. RECOVERY: " + GIT_RECOVERY + " There is no per-skill restore path.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID (e.g. 'personal-adas')",
        },
        skill_id: {
          type: "string",
          description: "The skill ID to remove (e.g. 'linkedin-agent')",
        },
        confirm: {
          type: "boolean",
          description: "REQUIRED. Must be exactly true. A missing/false value refuses the call with a recovery hint.",
        },
      },
      required: ["solution_id", "skill_id", "confirm"],
    },
  },
  {
    name: "ateam_delete_connector",
    core: true,
    description:
      "⚠️ CASCADING — any skill whose engine.bootstrap_tools or tools[] name a tool from this connector will FAIL its next execution. " +
      "Stops and deletes the connector from A-Team Core; drops references from the solution definition (grants, platform_connectors, ui_plugins ids starting `mcp:<connector-id>:*`) and skill definitions (connectors array); cleans up mcp-store files. " +
      "ALSO REMOVES THE SOURCE: `connectors/<id>/` is deleted from the repo (main AND dev) in the same call, so the delete is DURABLE. " +
      "This CHANGED on 2026-08-23 — it used to preserve the source and name `ateam_build_and_run(github:true)` as a way to resurrect. That made a delete undo itself on a later publish, and only in some states, since connectors[] is synthesized from mcp_store keys ONLY when it is empty. If you want the code kept, copy it out (ateam_get_connector_source) BEFORE deleting. If the repo removal fails the response says so under `github` — Core is clean but the source is still there. " +
      "REQUIRES `confirm:true`.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID (e.g. 'smart-home-assistant')",
        },
        connector_id: {
          type: "string",
          description: "The connector ID to remove (e.g. 'device-mock-mcp')",
        },
        confirm: {
          type: "boolean",
          description: "REQUIRED. Must be exactly true. A missing/false value refuses the call with a recovery hint.",
        },
      },
      required: ["solution_id", "connector_id", "confirm"],
    },
  },

  {
    name: "ateam_show_skill_minimal",
    core: true,
    description:
      "Show the minimal authoring view of a skill — persona + connectors + " +
      "handoff_when + style + policy guardrails only. ~10× smaller than " +
      "ateam_get_solution(view:'skills') for the same skill. Use this when " +
      "you only need the irreducible author content (Phase 9 of the strip).",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: { type: "string", description: "The solution ID" },
        skill_id: { type: "string", description: "The skill ID" },
      },
      required: ["solution_id", "skill_id"],
    },
  },

  {
    name: "ateam_show_solution_minimal",
    core: true,
    description:
      "Show the minimal authoring view of a solution — name + description + " +
      "style + routing_mode + identity_mode + skill ids + connector ids only. " +
      "Skips deployed metadata, handoffs (auto-generated), grants, ui_plugins, " +
      "validation results. Use this for fast inspection without the verbose " +
      "fields (Phase 9 of the strip).",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: { type: "string", description: "The solution ID" },
      },
      required: ["solution_id"],
    },
  },

  {
    name: "ateam_log_progress",
    core: true,
    description:
      "Record that a build STEP is done, so a later run does not redo it. Write it AS IT HAPPENS, never at the end — the runs that most need a journal are the ones the clock kills.\n\n" +
      "WHY: a continuation cannot otherwise tell what the previous run achieved, so it re-runs the whole orientation (bootstrap, get_workflows, list_solutions, get_solution, get_spec, get_examples, github_read) to re-derive from documents what was already established — and re-inflates its prompt into the region where provider latency collapses. Measured across 13 runs: stalls track PROMPT SIZE (~60k), not turn count. ateam_get_progress is ONE call instead of nine.\n\n" +
      "status — three values, and the third is the point:\n" +
      "  built     — the artefact exists (files written, committed)\n" +
      "  deployed  — the platform accepted it\n" +
      "  verified  — YOU CALLED IT AND GOT REAL DATA BACK\n\n" +
      "`verified` REQUIRES verified_by, and a deploy response is not verification. `connected` and `tools > 0` are tools/list facts: a clinic connector showed 9 tools while every storage call returned 401. A journal that stops at `deployed` records that build as finished.\n\n" +
      "Re-log the same step as it advances (built → deployed → verified) — latest wins, no update path. If a step REGRESSES, re-log it at the lower status: silence must not read as \"still fine\".",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: { type: "string", description: "The solution ID" },
        step: {
          type: "string",
          description: "STABLE slug a later run can MATCH rather than enumerate: 'connector:<id>', 'skill:<id>', 'widget:<name>', 'seed:<what>'. Keep it identical across runs — a renamed step reads as a new one.",
        },
        status: {
          type: "string",
          enum: ["built", "deployed", "verified"],
          description: "built = artefact exists · deployed = platform accepted it · verified = you called it and got real data back",
        },
        detail: { type: "string", description: "One line of what exists — e.g. '10 tools, 8 seeded appointments'." },
        verified_by: {
          type: "string",
          description: "REQUIRED when status is 'verified': the literal call that proved it and what came back, e.g. 'ateam_test_connector(clinic-data-mcp, appointments.list_all) → 23 rows'. Storing the evidence beside the claim is what makes the journal auditable instead of self-reported.",
        },
      },
      required: ["solution_id", "step", "status"],
    },
  },
  {
    name: "ateam_get_progress",
    core: true,
    description:
      "What this build has already ACHIEVED — read it FIRST when continuing a run, before any orientation call. Returns the CURRENT status per step (latest entry wins) plus recent history.\n\n" +
      "Then build only the steps that are ABSENT or not yet `verified`.\n\n" +
      "ABSENT IS NOT \"NOTHING WAS DONE\" — the journal may predate a step, or a run may have died before writing. It is a fast path, not a new source of truth: check before rebuilding something expensive.\n\n" +
      "Complements ateam_get_lessons, which records what BROKE. This records what WORKS.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: { type: "string", description: "The solution ID" },
        limit: { type: "number", description: "History entries to return (default 60). `steps` is always complete." },
      },
      required: ["solution_id"],
    },
  },
  {
    name: "ateam_log_lesson",
    core: true,
    // HOW A WRONG LESSON IS CORRECTED is stated in ONE place: the Builder's
    // lessons GET returns it in every answer as `correction_rule`. This text
    // declares the argument and points there; it keeps no copy that could
    // drift (CORE on #54). Core cuts every description at 1200 characters for
    // an agent run (test/core-description-cut.test.mjs).
    description:
      "Record ONE lesson this run learned, so the NEXT run — which starts empty " +
      "— does not relearn it. Log it the moment a tool misleads you AND you find " +
      "a way through.\n\n" +
      "You cannot edit or delete earlier lessons; supersede them: `supersedes` " +
      "takes the `id` of the lesson to replace, from ateam_get_lessons, whose " +
      "`correction_rule` says when and how. An unknown id is refused (404); a " +
      "lesson already superseded is refused (409) naming the current one. The " +
      "server stamps the id and the time.\n\n" +
      "PROVENANCE: `job_id` and `actor` are usually null (an agent calling this " +
      "tool sends no x-adas-job-id / x-adas-actor-id): a lesson cannot be traced " +
      "to its run, nor 'three runs hit this' told from 'one run, three times'. " +
      "Do not put a job id in `error`; keep it verbatim.\n\n" +
      "LOG ONLY WHAT YOU OBSERVED, a correction too. Quote the error VERBATIM; " +
      "never a paraphrase, never a theory about platform internals. A wrong " +
      "lesson is worse than no lesson: the next run will act on it.\n\n" +
      "kind='misleading_success': a call REPORTED success while the effect you " +
      "wanted did not happen — the class a failures-only log cannot hold.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: { type: "string", description: "The solution this lesson belongs to" },
        tool: { type: "string", description: "The tool that misled you, e.g. \"ateam_build_and_run\"" },
        error: { type: "string", description: "The VERBATIM error or failed_steps fragment. Not a paraphrase." },
        workaround: { type: "string", description: "What you did instead (optional)" },
        worked: { type: "boolean", description: "Did the workaround work? Omit if you never found out — 'unknown' is a real answer" },
        kind: {
          type: "string",
          enum: ["failure", "surprise", "misleading_success"],
          description: "failure = it errored; surprise = it worked but not as documented; misleading_success = it REPORTED success while the intended effect did not happen",
        },
        supersedes: {
          type: "string",
          description: "The `id` of the lesson this one supersedes, from ateam_get_lessons — see `correction_rule` in its answer",
        },
      },
      required: ["solution_id", "tool", "error"],
    },
  },

  {
    name: "ateam_get_lessons",
    core: true,
    description:
      "Read what EARLIER runs on this solution learned — the CURRENT lessons, " +
      "newest first, bounded, each with its `id`. Call this during orientation, " +
      "BEFORE planning: it is the only thing that carries context across runs, " +
      "and it is cheap. Each entry says which tool misled a previous run, the " +
      "verbatim error, what was tried instead, and whether that worked. An empty " +
      "list is a real answer (nothing learned yet).\n\n" +
      "Every answer carries `correction_rule`: how a lesson that proved wrong " +
      "is corrected. A superseded lesson is counted in `superseded_count`, " +
      "never listed in `lessons`; include_superseded:true returns it in a " +
      "separate `superseded` list, each with `superseded_by`. A correction " +
      "carries `corrects`: the tool and error the lesson it replaced quoted.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: { type: "string", description: "The solution ID" },
        limit: { type: "number", description: "Max current lessons, newest first (default 20)" },
        include_superseded: { type: "boolean", description: "Also return the superseded lessons, in their own `superseded` list (default false)" },
      },
      required: ["solution_id"],
    },
  },

  {
    name: "ateam_create_connector",
    core: true,
    monitoring: { safe: false, cost: "heavy", latency_ms_p95: CONNECTOR_UPLOAD_P95_MS, output: "bounded" },
    description:
      "Scaffold a NEW MCP connector with server.js + package.json + README: a defineConnector skeleton " +
      "(@ateam-ai/sdk/serve): you write handlers; caller identity arrives as ctx. " +
      "Where its data goes: " + STORAGE_DECISION_AT + ". " +
      "You then fill in the tool implementations. " +
      "Set ui_capable=true to include ui.listPlugins / ui.getPlugin stubs " +
      "(plugin source files added separately via ateam_create_plugin). " +
      "After scaffolding, the files are uploaded to Core via the same path " +
      "as ateam_upload_connector. " +
      "Create never replaces: the Builder writes the scaffold only if the connector exists nowhere (its source, the repo's working branch, Core), " +
      "in the same request that checks. Otherwise CONNECTOR_EXISTS names where, with the way on, or, when a read failed, a retryable CONNECTOR_UNREADABLE. " +
      "Nothing is uploaded either way.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: { type: "string", description: "The solution ID" },
        connector_id: {
          type: "string",
          description: "Connector ID (lowercase-with-dashes, no spaces). Becomes the directory name.",
        },
        name: {
          type: "string",
          description: "Human-readable name for the connector (e.g. 'Hue Lights'). Defaults to connector_id.",
        },
        ui_capable: {
          type: "boolean",
          description: "If true, include ui.listPlugins/ui.getPlugin handler stubs. Default: false.",
        },
      },
      required: ["solution_id", "connector_id"],
    },
  },

  {
    name: "ateam_create_plugin",
    core: true,
    monitoring: { safe: false, cost: "heavy", latency_ms_p95: CONNECTOR_UPLOAD_P95_MS, output: "bounded" },
    description:
      "Scaffold a UI plugin (iframe HTML, RN TSX, or both) inside an existing connector. " +
      "Writes the boilerplate (imports, theme/bridge hooks, " +
      "postMessage protocol, default export shape); you fill in the component body. " +
      "'iframe' = HTML (web + phone WebView), 'rn' = native (phone only), 'adaptive' = both. " +
      "Also writes ui-dist/<plugin>/manifest.json with the required render block.\n\n" +
      "⚠️ RENDERING IS NOT AUTOMATIC. A plugin renders only if its connector ADVERTISES it " +
      "(ui.listPlugins + ui.getPlugin) with a render.{mode, iframeUrl?, reactNative?} block. The scaffold files alone register nothing. " +
      `${PLUGIN_LISTED_LIVE} ` +
      "If the connector generates its plugin list from ui-dist/<plugin>/manifest.json, the emitted manifest is picked up automatically; " +
      "if the connector has a HARDCODED list (e.g. personal-assistant-ui-mcp: UI_PLUGINS[] + PLUGIN_MANIFESTS{} in server.js), you MUST add this plugin there (copy the manifest.json render block). " +
      `${DISCOVERED_PLUGIN_IS_MERGED}\n\n` +
      "The scaffold MERGES into the existing connector (server.js + other files preserved), GitHub-backed or repo-less. Create never replaces: a plugin file that exists anywhere (source, repo branch, Core) is refused (PLUGIN_EXISTS); no connector to add to is CONNECTOR_BASE_MISSING (create it first).",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: { type: "string", description: "The solution ID" },
        connector_id: {
          type: "string",
          description: "Existing connector to add the plugin into (e.g. 'personal-assistant-ui-mcp')",
        },
        plugin_name: {
          type: "string",
          description: "Plugin name (lowercase-with-dashes). E.g. 'memories-panel'. Becomes the dir name.",
        },
        kind: {
          type: "string",
          enum: ["iframe", "rn", "adaptive"],
          description: "Render mode. 'adaptive' (default) produces both iframe + RN scaffolds.",
        },
      },
      required: ["solution_id", "connector_id", "plugin_name"],
    },
  },

  {
    name: "ateam_upload_connector",
    core: true,
    monitoring: { safe: false, cost: "heavy", latency_ms_p95: CONNECTOR_UPLOAD_P95_MS, output: "bounded" },
    description:
      "Upload connector code to Core and restart it. Then the skills that import this connector's tools are redeployed when they need it — a redeploy of the WHOLE skill as the Builder holds it, so its other connectors' tools and any saved edit not yet deployed go live too. The reply's skill_tools says, per skill and per connector, what changed in what Core runs; stages.skills is its verdict. A tools[] you wrote yourself is never changed. The rule: ateam_get_spec('skill') → agent_guide.key_concepts.how_a_skill_gets_its_tools.when_the_connector_changes.\n\n" +
      "Modes:\n" +
      "  • github:true — deploy connectors/<id>/ from the repo at `ref` (default 'dev'); files:[] overlays yours on it.\n" +
      "  • files:[] — MERGE (default): your files over the repo at `ref`, over the files Core ALREADY runs. A file you leave out is kept, " + UPLOAD_DROPS_UNREADABLE.mergeMode + ".\n" +
      "  • files:[] + replace:true — the connector becomes EXACTLY these files. Every other file is DELETED from Core, from the Builder's source and, when GitHub is connected, from the repo's working branch (dev), deployed or not — files written with ateam_github_patch included. Some files are kept — repo.kept names each with its reason.\n\n" +
      "Nothing is written with no base (409 CONNECTOR_BASE_MISSING: a new connector is ateam_create_connector's) or a failed read (retryable 502 CONNECTOR_UNREADABLE).\n\n" +
      "Multi-file connectors: pass each file as content_base64 (single-line, escape-safe) instead of content — the canonical path for a full connector; do not curl the raw endpoint (it skips connector registration and PAT provisioning).",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
        connector_id: {
          type: "string",
          description: "The connector ID to upload (e.g. 'personal-assistant-ui-mcp')",
        },
        github: {
          type: "boolean",
          description: "If true, pull connector files from GitHub repo at `ref`. Default: false. Combine with files:[] to use GitHub as the base and overlay your files.",
        },
        ref: {
          type: "string",
          description: "GitHub branch to read from for the BASE state. Default: 'dev' (matches ateam_github_patch). Pass 'main' to read from production. Pre-2026-06-05 callers that relied on the silent-main default must pass ref:'main' explicitly.",
        },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Relative file path (e.g. 'server.js', 'ui-dist/panel/index.html')" },
              content: { type: "string", description: "File content as an inline string. Prefer content_base64 when the content has complex escaping (HTML/JS/JSON)." },
              content_base64: { type: "string", description: "File content as a single-line base64 string — escape-safe. PREFERRED for a multi-file connector so large HTML/JS/bundles don't need hand-escaping in the tool call. Provide exactly ONE of content / content_base64 per file." },
            },
            required: ["path"],
          },
          description: "Files to upload — each needs 'path' plus ONE of content (inline string) or content_base64 (escape-safe base64; preferred for multi-file connectors). By default merges with the GitHub state at `ref`. With replace:true the connector becomes exactly these files (see replace).",
        },
        replace: {
          type: "boolean",
          description: "FULL REPLACE: the connector becomes exactly `files`. Every other file is deleted from Core, from the Builder's source and, when GitHub is connected, from the repo's working branch (dev) — every file under connectors/<connector-id>/ you leave out, deployed or not, files written with ateam_github_patch included (some files are kept — repo.kept names each with its reason). The reply names each: dropped (Core), authored.removed (the Builder's source), repo.deleted (the branch), repo.branch_only (the branch files that were never deployed), repo.kept (kept, with the reason). Main is never touched (a promote carries it). With github:true the repo is left as it is. Default: false (= merge). An incomplete file set with replace:true deletes the rest of the connector. " + UPLOAD_DROPS_UNREADABLE.replaceParam,
        },
        force: {
          type: "boolean",
          description: "RECOVERY: respawn the connector + re-inject its CURRENT env even when the source is UNCHANGED. Normally an unchanged-source upload no-ops (unchanged:true) and leaves the process running. But a connector spawned before a shared-secret rotation keeps the STALE secret — it still lists tools (looks healthy) yet 401s on every per-actor call, with no recovery short of a fake source edit. Use `ateam_upload_connector(solution_id, connector_id, github:true, force:true)` to pull the current source and force a fresh respawn (which picks up the current secret). Default: false.",
        },
      },
      required: ["solution_id", "connector_id"],
    },
  },

  // ═══════════════════════════════════════════════════════════════════
  // ADVANCED TOOLS — hidden from tools/list, still callable by name
  // Use these for manual lifecycle control, debugging, and diagnostics
  // ═══════════════════════════════════════════════════════════════════

  {
    name: "ateam_validate_skill",
    core: false,
    description:
      "Validate a skill definition through the 5-stage A-Team validation pipeline. Returns errors and suggestions to fix. (Advanced — ateam_build_and_run validates automatically.)",
    inputSchema: {
      type: "object",
      properties: {
        skill: {
          type: "object",
          description: "The full skill definition object to validate",
        },
      },
      required: ["skill"],
    },
  },
  {
    name: "ateam_validate_solution",
    core: false,
    description:
      "Validate a governed AI Team solution — cross-skill contracts, grant economy, handoffs, and LLM quality scoring. (Advanced — ateam_build_and_run validates automatically.)",
    inputSchema: {
      type: "object",
      properties: {
        solution: {
          type: "object",
          description: "The full solution definition object to validate",
        },
        skills: {
          type: "array",
          items: { type: "object" },
          description: "Array of skill definitions included in the solution",
        },
      },
      required: ["solution"],
    },
  },
  {
    name: "ateam_deploy_solution",
    core: false,
    description:
      "Deploy a governed AI Team solution to A-Team Core. (Advanced — prefer ateam_build_and_run which validates + deploys + health-checks in one step.)",
    inputSchema: {
      type: "object",
      properties: {
        solution: {
          type: "object",
          description: "Solution architecture — identity, grants, handoffs, routing",
        },
        skills: {
          type: "array",
          items: { type: "object" },
          description: "Array of full skill definitions",
        },
        connectors: {
          type: "array",
          items: { type: "object" },
          description: "Array of connector metadata (id, name, transport). command and args are OPTIONAL when mcp_store provides the code — the system auto-detects the entry point.",
        },
        mcp_store: {
          type: "object",
          description:
            "Optional: connector source code files. Key = connector id, value = array of {path, content}.",
        },
      },
      required: ["solution", "skills"],
    },
  },
  {
    name: "ateam_deploy_skill",
    core: false,
    description: "Deploy a single skill into an existing solution. (Advanced — use ateam_build_and_run for new solutions.)",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The existing solution ID to add the skill to",
        },
        skill: {
          type: "object",
          description: "Full skill definition",
        },
      },
      required: ["solution_id", "skill"],
    },
  },
  {
    name: "ateam_deploy_connector",
    core: false,
    description: "Deploy a connector — registers in the Skill Builder catalog and connects in A-Team Core. (Advanced.)",
    inputSchema: {
      type: "object",
      properties: {
        connector: {
          type: "object",
          description: "Connector metadata (id, name, transport, command, args)",
        },
      },
      required: ["connector"],
    },
  },
  {
    name: "ateam_upload_connector_files",
    core: false,
    description:
      "Upload source files for a connector's MCP server. Use this INSTEAD of mcp_store in ateam_build_and_run when the source code is too large to inline. Upload files first, then build_and_run without mcp_store. (Advanced.)",
    inputSchema: {
      type: "object",
      properties: {
        connector_id: {
          type: "string",
          description: "The connector ID (must match the connector's id in the solution)",
        },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: 'Relative file path (e.g. "server.js", "package.json", "src/utils.js")' },
              content: { type: "string", description: "File content as a string. Use for small files." },
              content_base64: { type: "string", description: "File content as base64-encoded string. Use when content has complex escaping." },
              url: { type: "string", description: "URL to fetch file content from (e.g. raw GitHub URL). Server fetches it — no large payload needed." },
            },
            required: ["path"],
          },
          description: "Array of files to upload. Each file needs 'path' plus ONE of: 'content' (inline string), 'content_base64' (base64), or 'url' (server fetches it).",
        },
      },
      required: ["connector_id", "files"],
    },
  },
  {
    name: "ateam_update",
    core: false,
    description:
      "Update a deployed solution or skill incrementally using PATCH. (Advanced — prefer ateam_patch which updates + redeploys + tests in one step.)",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
        target: {
          type: "string",
          enum: ["solution", "skill"],
          description: "What to update: 'solution' or 'skill'",
        },
        skill_id: {
          type: "string",
          description: "Required when target is 'skill'",
        },
        updates: {
          type: "object",
          description:
            "The update payload — use dot notation for scalars (e.g. 'problem.statement'), and tools_push/tools_delete/tools_update for array operations",
        },
      },
      required: ["solution_id", "target", "updates"],
    },
  },
  {
    name: "ateam_solution_chat",
    core: false,
    description:
      "Send a message to the Solution Bot — an AI assistant that understands your deployed solution and can help with modifications. (Advanced.)",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
        message: {
          type: "string",
          description: "Your message to the Solution Bot",
        },
      },
      required: ["solution_id", "message"],
    },
  },
  {
    name: "ateam_get_execution_logs",
    // Advertised (was core:false): these are the RUNTIME DIAGNOSTICS a caller needs
    // mid-run, but a connector-wildcard grant expands over ADVERTISED tools only, so
    // hiding them made them ungrantable — invisible to every agent that needed them.
    core: true,
    description:
      "Get execution logs for a solution — recent jobs with step traces, tool calls, errors, and timing. Essential for debugging what actually happened during skill execution. (Advanced.)",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
        skill_id: {
          type: "string",
          description: "Optional: filter logs to a specific skill",
        },
        job_id: {
          type: "string",
          description: "Optional: get detailed trace for a specific job ID",
        },
        chain_id: {
          type: "string",
          description: "The CHAIN id — what ateam_conversation returns and ateam_chain_status takes. Prefer this: it is the id you actually hold. Resolved to the underlying job for you.",
        },
        actor_id: {
          type: "string",
          description: "The actor whose job this is. REQUIRED for per-job detail: a job belongs to an actor and Core refuses the detail endpoint without one (the list form does not check). Usually the session already holds it. Otherwise pass the ran_as of the ateam_conversation / ateam_test_skill reply that started the job, not the actor_id you passed. " + TEST_RUNS_AS_AT,
        },
        limit: {
          type: "number",
          description: "Max jobs to return (default: 10, max: 50)",
        },
      },
      required: ["solution_id"],
    },
  },
  {
    name: "ateam_test_status",
    core: true,
    // Monitoring-safe for ONE test job (bounded), but include_chain:true pulls the
    // full tree — that call is NOT safe to loop.
    monitoring: { safe: true, cost: "cheap", latency_ms_p95: 500, output: "bounded", poll_interval_s: 2,
      note: "safe:false when include_chain:true (that fetches the full tree)." },
    description:
      "Poll the progress of an async test. Pass chain_id for the WHOLE run (recommended — the root job finishing does NOT mean the run finished; a handoff may still be going). Pass job_id to poll one job alone: iteration count, tool call steps, status, and result when done.\n\n" +
      "Set include_chain:true to ALSO include the full chain tree (every job in the chain, rooted at this job_id, with parent/child linkage). Use when this job dispatched askAnySkill subcalls and you want a single snapshot of the whole multi-skill state instead of polling each child job_id separately.",
    inputSchema: {
      type: "object",
      properties: {
        chain_id: {
          type: "string",
          description:
            "THE EXECUTION'S IDENTITY — what ateam_conversation returns and what you actually hold. A chain is the whole run: root job + every handoff + every askAnySkill subcall. Prefer this.",
        },
        actor_id: {
          type: "string",
          description:
            "Optional. WHO is asking. A job belongs to an actor and Core enforces that on per-job reads, so a tenant key alone is refused. Usually unnecessary — the session remembers the actor from ateam_conversation/ateam_test_skill. Pass it to inspect a job run by a DIFFERENT actor (e.g. a real user's).",
        },
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
        skill_id: {
          type: "string",
          description: "The skill ID",
        },
        job_id: {
          type: "string",
          description: "ONE job inside the chain, when you want that job alone. Omit and pass chain_id for the whole run — a root job can be 'completed' while a handoff is still running.",
        },
        include_chain: {
          type: "boolean",
          description:
            "If true, includes response.chain — the full chain tree rooted at this job_id (chainJobs[] with parentJobId/relation/depth, executionSteps[] with tool-nesting). Costs one extra Core call. Default false (back-compat).",
        },
      },
      required: ["solution_id"],
    },
  },
  {
    name: "ateam_get_chain",
    core: true,
    // NOT monitoring-safe: returns the FULL job tree — output grows with the run
    // (a 200-step job returns 200 steps), which is the property that silently
    // degrades. Use once at the end; poll ateam_chain_status instead.
    monitoring: { safe: false, cost: "heavy", output: "grows_with_run", use_instead: "ateam_chain_status" },
    description:
      "Inspect the full chain tree — the whole run rooted at chain_id, walking down through every handoff and askAnySkill subcall.\n\n" +
      "Use when a chain has already run and you want to analyze the structure: which skill called which, how deep the call tree went, which tool inside which job invoked which sub-tool. The two main shapes:\n" +
      "  • response.data.chainJobs[] — one entry per job in the chain. Fields: jobId, skill, status, iteration, depth (0 = root, +1 per askAnySkill subcall hop), relation ('root' | 'subcall' | 'handoff'), parentJobId, parentSkill, goal.\n" +
      "  • response.data.executionSteps[] — every tool call across all chain jobs, tagged with _skill, _jobId, _depth (= job depth), _relation, _parentSkill, _parentJobId, _toolDepth (tool-in-tool nesting via opId/parentOpId).\n\n" +
      "Differs from ateam_test_status by purpose: status is for live polling of a job you just kicked off; get_chain is for post-hoc tree analysis (debugging multi-skill flows, regression testing, comparing two runs).\n\n" +
      "Auth: forwards your authed api_key. Tenant scoped by the key itself. Actor scoping: you can only inspect chains rooted at jobs your actor has access to.",
    inputSchema: {
      type: "object",
      properties: {
        chain_id: {
          type: "string",
          description:
            "THE EXECUTION'S IDENTITY — what ateam_conversation returns and what you actually hold. A chain is the whole run: root job + every handoff + every askAnySkill subcall. Prefer this.",
        },
        actor_id: {
          type: "string",
          description:
            "Optional. WHO is asking. A job belongs to an actor and Core enforces that on per-job reads, so a tenant key alone is refused. Usually unnecessary — the session remembers the actor from ateam_conversation/ateam_test_skill. Pass it to inspect a job run by a DIFFERENT actor (e.g. a real user's).",
        },
        job_id: {
          type: "string",
          description: "Alias for chain_id. Any job inside the chain works — Core walks up to the root — but you rarely hold one; prefer chain_id.",
        },
        skill_slug: {
          type: "string",
          description: "Optional. The skill slug for the job — speeds up the lookup when the job isn't in memory and must be loaded from storage. Omit if you don't have it; lookup still works but does an extra round-trip.",
        },
      },
      required: [],
    },
  },
  {
    name: "ateam_chain_status",
    core: true,
    // MONITORING-SAFE — the one tool built for a poll loop. See MONITORING_CONTRACT.
    // cheap: one status read, no tree walk, no LLM. bounded: the response does NOT
    // grow with the run (a 200-step job returns the same shape as a 2-step one).
    monitoring: {
      safe: true,
      cost: "cheap",
      latency_ms_p95: 500,
      output: "bounded",
      poll_interval_s: 2,
      note: "Returns last_activity_at / idle_seconds / activity_source. A LARGE idle_seconds does NOT mean dead — on this platform a healthy build sits minutes inside a single provider call. Read activity_source (what it was doing) with it; never apply an 'idle > N ⇒ dead' rule.",
    },
    description:
      "SLIM chain status — the chip-quick poll. Given a chain_id (from ateam_conversation), returns the WHOLE-CHAIN aggregate status cheaply: chain_status + chain_done (true only when the ENTIRE chain — root job + every handoff + askAnySkill subcall — is terminal), plus pending_question, result, and a short progress line.\n\n" +
      "This is what you poll on a loop after ateam_conversation — NOT ateam_get_chain (that returns the full tree; too heavy for periodic polling). A single job can finish while the chain is still running, so poll chain_done, not a job's status.\n\n" +
      "Loop: call every ~2s until chain_done === true. " + WAITING_ON_THE_USER + " Otherwise read `result` / fetch the full tree once via ateam_get_chain if you need per-job detail.",
    inputSchema: {
      type: "object",
      properties: {
        actor_id: {
          type: "string",
          description:
            "Optional. WHO is asking. A job belongs to an actor and Core enforces that on per-job reads, so a tenant key alone is refused. Usually unnecessary — the session remembers the actor from ateam_conversation/ateam_test_skill. Pass it to inspect a job run by a DIFFERENT actor (e.g. a real user's).",
        },
        chain_id: {
          type: "string",
          description: "The chain id returned by ateam_conversation (the conversation's identity). Any job id in the chain also works — Core resolves the chain aggregate.",
        },
        job_id: {
          type: "string",
          description: "Alias for chain_id — any job in the chain resolves to the chain aggregate. The handler has always accepted it; without this declaration MCP stripped it before the handler could see it.",
        },
      },
      // Neither is required ON ITS OWN: pass chain_id OR job_id. `required:
      // ["chain_id"]` outlived the alias (852b373 declared job_id and left it),
      // so a schema-following caller could never send the one shape the alias
      // exists for. Same contract as ateam_get_chain. The handler refuses when
      // both are missing.
      required: [],
    },
  },
  {
    name: "ateam_get_widget_catalog",
    core: true,
    description:
      "Get the live catalog of widgets (UI plugins) available in this tenant's solution. Returns platform-bundled + solution-bundled + skill-declared widgets, each with a paste-ready how_to_use block (solution.json snippet + opener_call + persona_phrasing + binding_notes).\n\n" +
      "Use this when wiring widgets into a skill or solution — the how_to_use block is designed to be copied verbatim into the solution.json ui_plugins[] entry and into the persona's opener phrasing, so you don't have to hand-roll either. The catalog reflects what is actually deployed in the tenant right now, not the abstract spec (for the spec itself, use ateam_get_spec topic='widgets').\n\n" +
      "Origins:\n" +
      "  • 'platform' = widgets bundled with the platform (always available).\n" +
      "  • 'solution' = widgets bundled with this tenant's solution.\n" +
      "  • 'skill' = widgets declared by a specific skill in the solution.\n\n" +
      "Auth: forwards your authed api_key to Core (no master-secret involvement). Tenant scope is pinned by the key itself.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "Optional. The solution to query. Defaults to the tenant's current solution.",
        },
        origin: {
          type: "string",
          enum: ["all", "platform", "solution", "skill"],
          description:
            "Optional. Filter by widget origin. 'all' (default) returns everything. 'platform' = platform-bundled only. 'solution' = solution-bundled only. 'skill' = skill-declared only.",
        },
        include_unused: {
          type: "boolean",
          description:
            "Optional. If true, includes widgets that are available but not currently referenced by any skill or ui_plugins entry. Default false (only widgets actually wired into the solution).",
        },
        format: {
          type: "string",
          enum: ["summary", "full"],
          description:
            "Optional. 'full' (default) returns each widget with its paste-ready how_to_use block (solution.json snippet, opener_call, persona_phrasing, binding_notes). 'summary' returns just id/name/origin/description for a quick overview.",
        },
      },
      required: [],
    },
  },
  {
    name: "ateam_test_abort",
    core: true,
    // WHO THE ABORT ACTS AS. actor_id came in with 852b373 as a copy of the
    // read tools' "WHO is asking … Pass it to inspect a job run by a DIFFERENT
    // actor", and the handler below never read it. The abort is no read: the
    // Builder's DELETE …/test/:jobId (routes/solutions.js:3056-3059, 986b2b8d)
    // sends Core testIdentity(req).ranAs — the API key's person, null for a key
    // with no person — and nothing the caller names. Core's
    // POST /api/job/:id/abort (server.js:3006) refuses an actor that may not
    // access the job (utils/actors.js canAccessActor: itself, a platform admin,
    // or a _system_service job), answered as 403 JOB_ACCESS_DENIED. A key with
    // no person reaches Core with no actor, read as _system_service
    // (middleware/attachActor.js). What actor_id still does is the dispatcher's
    // (handleToolCall → api.js touchSession): it becomes the session's actor,
    // which the chain_id form's chain read (GET /deploy/jobs/:id/chain → Core
    // /api/job/:id/chain, a per-actor read) carries. Kept and described for that,
    // since an undeclared actor_id would be latched all the same.
    description:
      "Abort a running test. Pass chain_id to abort the WHOLE run — every job in the chain — and get back which ones stopped. Aborting by job_id stops that job only, leaving handoffs running. Stops at the next iteration boundary. " +
      "The abort uses the actor the test's start ran as, whatever actor_id says: Core stops a job that actor may access and refuses any other with 403 JOB_ACCESS_DENIED, so an anonymous abort stops only anonymous runs. " + TEST_RUNS_AS_AT + " (Advanced.)",
    inputSchema: {
      type: "object",
      properties: {
        chain_id: {
          type: "string",
          description:
            "THE EXECUTION'S IDENTITY — what ateam_conversation returns and what you actually hold. A chain is the whole run: root job + every handoff + every askAnySkill subcall. Prefer this.",
        },
        actor_id: {
          type: "string",
          description:
            "Optional, and NOT who aborts (see the description). What it does is what actor_id does on any call: ateam-mcp keeps it (a test_ thread id excepted) as this session's actor and sends it on later calls, and the chain_id form reads the chain's jobs as that actor before aborting them. The session already holds it after ateam_conversation / ateam_test_skill; in a new session, pass the ran_as of the reply that started the run.",
        },
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
        skill_id: {
          type: "string",
          description: "The skill ID",
        },
        job_id: {
          type: "string",
          description: "Abort ONE job only. Prefer chain_id: aborting the root leaves handoffs running while reporting the test aborted.",
        },
      },
      required: ["solution_id"],
    },
  },
  {
    name: "ateam_test_connector",
    core: true,
    // It said only "Call a tool on a running connector and get the result"
    // (179ecf1, 2026-03-22) — no word that the call skips the skill. On
    // 2026-09-28 a build (job_zare1ton, call #23) "tested" a person's
    // confirmation by calling invoice.confirm_held here with an amount nobody
    // supplied. Who it runs as: the key's person — PRE-1 (2026-10-01) saw it
    // only after a conversation had latched the session's actor; on a fresh
    // session the Builder sent Core no actor and it ran as _system_service
    // until Builder #115 (CORE review M41-1).
    description:
      "Call ONE tool on a running connector DIRECTLY and get its raw result — no skill, no guardrails, no user turn. It proves a tool's plumbing (arguments in, result out). " +
      "It can NOT prove a step that waits for a person — a confirmation, an approval, a value only the user knows: test those with ateam_conversation (ateam_get_spec('skill') → agent_guide.key_concepts.testing_and_runtime.human_step_testing). " +
      TEST_CONNECTOR_NEVER + " " +
      // Who a call runs as is the Builder's to say: the pointer. A master_key
      // session has no key person, which the Builder's page does not say yet
      // (CORE review M41x-L3), so this tool says it.
      TEST_RUNS_AS_AT + " " +
      // DEAD — remove after Builder #158 is on prod (its key_concepts.actor_id
      // carries the master_key case; CORE: one home). Delete this sentence
      // together with its ALLOWED entry in test/tests-run-as-key-person.test.mjs.
      "A master_key session has no key person: this tool runs as the actor_id the session last passed to another tool, or as the platform's service identity when it passed none (a master session's other tests run anonymously). " +
      "If a per-user tool answers NO_INDIVIDUAL_USER here, the call had no person behind it: that is about this test, not a connector bug, and never a reason to change where the connector stores data (ateam_get_spec('connector-multi-user') → storage_decision).",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
        connector_id: {
          type: "string",
          description: "The connector ID (e.g., 'home-assistant-mcp', 'google-home-mcp')",
        },
        tool: {
          type: "string",
          description: "The tool name to call (e.g., 'triggers.list', 'entities.list', 'google.devices')",
        },
        args: {
          type: "object",
          description: "Optional: arguments to pass to the tool",
        },
      },
      required: ["solution_id", "connector_id", "tool"],
    },
  },
  {
    name: "ateam_get_connector_source",
    core: true,
    description:
      `Read a connector's AUTHORED source — the code the Builder holds as the source of record (its authored store, or GitHub). Returns a file manifest, or one file's content with path:'<file>'. Use this BEFORE patching or rewriting a connector, so you make surgical fixes instead of blind full rewrites. Every answer carries `+
      `\`provenance\` (authored_fs | github) so you know which store you are reading.\n\n` +
      `This does NOT return what Core is currently RUNNING. Those are different questions and used to share one answer: a connector could be deployed and healthy while no authored copy of it existed anywhere, and this tool would hand back the runtime bytes as though they were the source. If there is no authored source you get AUTHORED_SOURCE_MISSING, not a silent substitute. To see the deployed copy use ateam_get_deployed_connector_source; to adopt it as authored source use ateam_recover_connector_source.`,
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID (e.g. 'smart-home-assistant')",
        },
        connector_id: {
          type: "string",
          description: "The connector ID to read (e.g. 'home-assistant-mcp')",
        },
        path: {
          type: "string",
          description: "Optional. Read ONE file (e.g. 'server.js', 'ui-dist/panel/index.html'). Omit to get a file manifest (paths + sizes, no content) — a whole connector's source exceeds the ~50KB output limit and truncates, so read files one at a time.",
        },
      },
      required: ["solution_id", "connector_id"],
    },
  },
  {
    name: "ateam_get_deployed_connector_source",
    core: true,
    description:
      `Read the DEPLOYED copy of a connector — the files ADAS Core is actually running. This is a runtime projection of the last successful deploy, NOT the source of record: it can differ from the authored source, and it may exist for a connector the Builder cannot reproduce at all. Answers carry authored_source_of_record:false so that is never in doubt.\n\n` +
      `Use it to diagnose ("what is actually running?"), to compare against ateam_get_connector_source, or to inspect a connector whose authored source is missing before deciding whether to adopt it with ateam_recover_connector_source. Do NOT copy bytes out of here and re-upload them as if you had authored them — that launders a runtime copy into the source of record and hides the fact that the real source was lost.`,
    inputSchema: {
      type: "object",
      properties: {
        solution_id: { type: "string", description: "The solution ID" },
        connector_id: { type: "string", description: "The connector ID to inspect" },
        path: {
          type: "string",
          description: "Optional. Read ONE file. Omit for a manifest (paths + sizes) — a whole connector exceeds the output limit and truncates.",
        },
      },
      required: ["solution_id", "connector_id"],
    },
  },
  {
    name: "ateam_recover_connector_source",
    core: true,
    description:
      `ADOPT the deployed copy of a connector as its AUTHORED source. The only sanctioned Core→Builder direction, and deliberately explicit: it is never part of a deploy.\n\n` +
      `Use it when a connector is running in Core but has no authored source (ateam_get_connector_source returns AUTHORED_SOURCE_MISSING) — the running bytes may be the only surviving copy of real work. The recovered files are STAMPED as recovered_from_core with a timestamp, so a reconstruction is never later mistaken for code someone wrote. Refuses with AUTHORED_SOURCE_EXISTS if authored source is already present; pass force:true only after comparing both copies and deciding the deployed one is the keeper.\n\n` +
      `Binaries and files over 512KB cannot round-trip and are reported under not_recovered — they stay missing. Push the result to GitHub afterwards so the recovered source is not held in one place only.`,
    inputSchema: {
      type: "object",
      properties: {
        solution_id: { type: "string", description: "The solution ID" },
        connector_id: { type: "string", description: "The connector ID to recover" },
        force: {
          type: "boolean",
          description: "Overwrite EXISTING authored source with Core's deployed copy. Default false. Only after comparing the two — the deployed copy may be older than what was authored.",
        },
      },
      required: ["solution_id", "connector_id"],
    },
  },
  {
    name: "ateam_get_metrics",
    monitoring: { safe: true, cost: "cheap", latency_ms_p95: 1000, output: "bounded", poll_interval_s: 30 },
    // Advertised (was core:false): these are the RUNTIME DIAGNOSTICS a caller needs
    // mid-run, but a connector-wildcard grant expands over ADVERTISED tools only, so
    // hiding them made them ungrantable — invisible to every agent that needed them.
    core: true,
    description:
      "Get execution metrics — timing, tool stats, bottlenecks, signals, and recommendations. (Advanced.)",
    inputSchema: {
      type: "object",
      properties: {
        actor_id: {
          type: "string",
          description:
            "Optional. WHO is asking. A job belongs to an actor and Core enforces that on per-job reads, so a tenant key alone is refused. Usually unnecessary — the session remembers the actor from ateam_conversation/ateam_test_skill. Pass it to inspect a job run by a DIFFERENT actor (e.g. a real user's).",
        },
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
        job_id: {
          type: "string",
          description: "Optional: deep analysis for a specific job",
        },
        chain_id: {
          type: "string",
          description:
            "Optional: deep analysis for the job behind a CHAIN id — what ateam_conversation returns and what you actually hold. Resolved to the job for you.",
        },
        skill_id: {
          type: "string",
          description: "Optional: recent metrics for a specific skill",
        },
      },
      required: ["solution_id"],
    },
  },
  {
    name: "ateam_verify",
    core: true,
    // Real end-state check — probes connectors/widgets/skills. Correct but SLOW;
    // for a run in flight poll ateam_chain_status and call this once at the end.
    monitoring: { safe: false, cost: "heavy", output: "bounded", use_instead: "ateam_chain_status" },
    description:
      "ONE call that returns the REAL runtime end-state of a solution — connectors connected + tools discovered, every declared widget actually rendering, skills deployed — with the EXACT failing gaps. Use this instead of guess-and-check after a deploy/patch: it tells you the truth (what's actually live) and names precisely what's broken, not a generic warning. ok:false with gaps is the answer; a result that also carries `error` means a check could not run (key refused, Builder down) — that is a failed call, not a verdict. Reliable from any connection (routes through the Builder, not a direct Core call).",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: { type: "string", description: "The solution ID to verify." },
      },
      required: ["solution_id"],
    },
  },
  {
    name: "ateam_diff",
    core: false,
    description:
      "Compare the current Builder definition against what's deployed in ADAS Core. Shows which skills are undeployed, orphaned, or have changed fields. (Advanced.)",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
        skill_id: {
          type: "string",
          description: "Optional: diff a single skill instead of the whole solution",
        },
      },
      required: ["solution_id"],
    },
  },

  // ═══════════════════════════════════════════════════════════════════
  // GITHUB TOOLS — version control for solutions
  // ═══════════════════════════════════════════════════════════════════

  {
    name: "ateam_github_push",
    core: true,
    // A POINTER, NOT A COPY. What the push writes, and what it keeps as the
    // branch holds it, is stated once by the Builder: /spec also_available
    // "POST /deploy/solutions/:solutionId/github/push" (Builder #144, BL-21).
    // This said "Commits the full bundle (solution + skills + connector
    // source)" (c98addc), which stopped being true when the push began writing
    // only what it changes.
    description:
      "Push the solution to its GitHub repo. When it runs, what it writes, and what it keeps as the branch holds it: " +
      PUSH_WRITES_AT + ".",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID (e.g. 'smart-home-assistant')",
        },
        message: {
          type: "string",
          description: "Optional commit message (default: 'Deploy <solution_id>')",
        },
      },
      required: ["solution_id"],
    },
  },
  {
    name: "ateam_github_pull",
    core: true,
    description:
      "Deploy a solution FROM its GitHub repo. Reads .ateam/export.json + connector source from the repo and feeds it into the deploy pipeline. Use this to restore a previous version or deploy from GitHub as the source of truth. " +
      "It REPLACES the Builder's copy of each file with the repo's (`dev`). Where the Builder holds a change that never reached GitHub (a save held off `dev`, one whose push failed, a file changed on both sides), that change would exist nowhere afterwards, so the pull is REFUSED (409 UNPUSHED_BUILDER_CHANGE, naming the files) before anything is uploaded or deployed — " +
      "unless you pass discard_builder_changes:true, the explicit way to take `dev`'s copy of a file changed on both sides, or to drop such a change. To keep the change instead, ateam_redeploy(solution_id) writes it to `dev` first.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID to pull and deploy from GitHub",
        },
        discard_builder_changes: {
          type: "boolean",
          description: "true = drop any Builder change that never reached GitHub, replacing it with the repo's copy. Only when you mean to lose it: without it, a pull that would drop one is refused and names the files.",
        },
      },
      required: ["solution_id"],
    },
  },
  {
    name: "ateam_github_status",
    core: true,
    description:
      "Check if a solution has a GitHub repo, its URL, and the latest commit. Use this to verify GitHub integration is working for a solution.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
      },
      required: ["solution_id"],
    },
  },
  {
    name: "ateam_github_read",
    core: true,
    description:
      "Read any file from a solution's GitHub repo. Returns the file content. Use this to read connector source code, skill definitions, or any versioned file. " +
      "Default reads `dev`, the working branch your writes land on (the Builder picks it when no ref is passed, and creates it if the repo has none yet). Pass `ref: 'main'` to read the promoted/production state. The response's `branch` says which one you got.\n\n" +
      "⚠️ NOT RUNTIME STATE. For `solution.json` and `skills/<id>/skill.json` this returns a git MIRROR, not what is deployed. " +
      "Connector-imported tools are regenerated at deploy time, so a repo copy's `tools[]` can differ from production (on one solution `dev` showed 29 tools while production ran 66). " +
      "Reads of those paths carry an `_ateam_representation` field saying what you are holding. " +
      "To answer \"what can this skill actually do?\", call ateam_get_solution(solution_id, skill_id, section:'tools') — never this tool.",
    inputSchema: {
      type: "object",
      properties: {
        branch: { type: "string", description: "Branch to read/write (alias for `ref`). Declared so MCP does not strip it — an undeclared argument is dropped silently, which made a branch:\"dev\" read return `main` with no error." },
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
        path: {
          type: "string",
          description: "File path in the repo (e.g. 'connectors/home-assistant-mcp/server.js', 'solution.json', 'skills/order-support/skill.json')",
        },
        ref: {
          type: "string",
          // No `default` here, deliberately. The Builder owns the branch rule
          // (resolveBranch, kind 'iterative' → dev) and this handler sends no
          // branch when none is given. A schema default is something an MCP
          // client may fill in on its own, and "main" here would have made such a
          // client read production while the text told it otherwise.
          description: "Branch, tag, or commit SHA to read from. Omit it to read `dev` (the working branch — the Builder resolves it). Use 'main' for the promoted/production state.",
        },
      },
      required: ["solution_id", "path"],
    },
  },
  {
    name: "ateam_github_patch",
    core: true,
    description:
      "Edit a file in the solution's GitHub repo and commit — ONE file per call. Modes:\n" +
      "1. FULL FILE: provide `content` — replaces entire file (good for new files or small files)\n" +
      "2. SEARCH/REPLACE: provide `search` + `replace` — surgical edit without sending full file (preferred for large files like server.js)\n" +
      "3. DELETE A STRAY: `delete: true` — removes a stray connector file, of either kind: one at the repo root, OUTSIDE connectors/<connector-id>/ (a root server.js, package.json or ui-dist/…), or a copy NESTED under a connector's own prefix (connectors/<connector-id>/connectors/<connector-id>/…). Core runs neither. Only such a file: anything else is refused (DELETE_ONLY_STRAY_CONNECTOR_FILES). It is removed from the working branch (`dev`) only, in one commit — production changes only through ateam_github_promote, like every other edit; git history keeps it. Move what it holds into connectors/<connector-id>/ first if it is still needed — the CONNECTOR_FILE_OUTSIDE_CONNECTOR or CONNECTOR_PATH_NESTED refusal says how the two copies differ and, when the stray is on the branch, names the delete call.\n" +
      "Connector files belong under connectors/<connector-id>/; a write anywhere else is refused (CONNECTOR_FILE_OUTSIDE_CONNECTOR), and so is one to a nested copy, connectors/<connector-id>/connectors/<connector-id>/… (CONNECTOR_PATH_NESTED).\n" +
      "Always use search/replace for large files (>5KB). Always read the file first with ateam_github_read to get the exact text to search for.\n\n" +
      "DEFAULTS TO `dev` BRANCH — writes don't touch prod. Use ateam_github_promote to ship dev→main when ready. Pass ref:'main' only for emergency hotfixes. " +
      "After one, run ateam_github_sync_from_main so `dev` has it too. Until `dev` holds the same content, the Builder's copy of that file is `main` content `dev` does not have: " +
      "ateam_redeploy and ateam_patch refuse to deploy the solution — any skill of it, not only that file's — and name the file (they never ship `dev`'s older copy over the hotfix, nor write the hotfix over `dev`), and ateam_build_and_run deploys it from `main`. " +
      "A Builder save of that file meanwhile stays in the Builder (its reply says NOT_WRITTEN_TO_GITHUB), and ateam_build_and_run is refused (UNPUSHED_BUILDER_CHANGE) until it is placed — ateam_github_pull too, unless told discard_builder_changes:true. " +
      "Connector code has no such check: ateam_upload_connector deploys `dev`'s code, so sync before the next upload of that connector. " +
      "The reply's fs_mirror says what the Builder did with the file (a note when it did NOT copy it: its own copy had a change of its own).",
    inputSchema: {
      type: "object",
      properties: {
        branch: { type: "string", description: "Branch to read/write (alias for `ref`). Declared so MCP does not strip it — an undeclared argument is dropped silently, which made a branch:\"dev\" read return `main` with no error." },
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
        path: {
          type: "string",
          description: "File path to create/update (e.g. 'connectors/home-assistant-mcp/server.js')",
        },
        content: {
          type: "string",
          description: "The full file content to write (mode 1 — full file replacement)",
        },
        search: {
          type: "string",
          description: "Exact text to find in the file (mode 2 — search/replace). Must match exactly including whitespace.",
        },
        replace: {
          type: "string",
          description: "Text to replace the search string with (mode 2 — required with search)",
        },
        message: {
          type: "string",
          description: "Optional commit message (default: 'Update <path>'; search/replace mode: 'Edit <path> (N replacements)'; delete: 'Delete <path>')",
        },
        delete: {
          type: "boolean",
          description: "Mode 3: true removes `path` — ONLY a stray connector file: one at the repo root, outside connectors/<connector-id>/ (root server.js, package.json, package-lock.json, ui-dist/…, plugins/…, rn-bundle/…), or a copy nested under a connector's own prefix (connectors/<connector-id>/connectors/<connector-id>/…). Takes no content or search. Deletes on the working branch (`dev`) only; a ref naming another branch is refused (DELETE_WORKING_BRANCH_ONLY) — promote carries the removal to main.",
        },
        ref: {
          type: "string",
          description: "Target branch. Default: 'dev' (safe — won't touch prod). Use 'main' only for emergency hotfixes.",
          default: "dev",
        },
      },
      required: ["solution_id", "path"],
    },
  },
  {
    name: "ateam_write_agent_doc",
    core: false,
    description:
      "Render + write (or refresh) CLAUDE.md in the solution's GitHub repo. Auto-generates the onboarding header from the deployed solution/skill/connector definitions and preserves any solution-specific notes below the sentinel line. " +
      "Normally called automatically on every ateam_build_and_run so CLAUDE.md stays in sync — use this tool directly to backfill existing solutions or to force a refresh.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: { type: "string", description: "The solution ID" },
        overwrite: {
          type: "boolean",
          description: "If true, rewrite the whole file (discards any solution-specific notes below the sentinel). Default false — preserves notes.",
        },
      },
      required: ["solution_id"],
    },
  },
  {
    name: "ateam_github_write",
    core: true,
    description:
      "Write a file to the solution's GitHub repo. Use this to create new connector files or replace existing ones — one file per call. " +
      "This is the PRIMARY way to write connector code after first deploy. " +
      "Write each file individually under connectors/<connector-id>/ (server.js, package.json, ui-dist/… assets), then call ateam_github_promote() to ship to prod (dev→main), then ateam_build_and_run() to deploy. " +
      "Core deploys connectors/<connector-id>/ only, so a connector file written anywhere else (a root server.js, package.json or ui-dist/) is refused with CONNECTOR_FILE_OUTSIDE_CONNECTOR.\n\n" +
      "DEFAULTS TO `dev` BRANCH.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
        path: {
          type: "string",
          description: "File path to write (e.g. 'connectors/my-mcp/server.js', 'connectors/my-mcp/package.json')",
        },
        content: {
          type: "string",
          description: "The full file content",
        },
        message: {
          type: "string",
          description: "Optional commit message (default: 'Update <path>')",
        },
        ref: {
          type: "string",
          description: "Target branch. Default: 'dev'.",
          default: "dev",
        },
      },
      required: ["solution_id", "path", "content"],
    },
  },
  {
    name: "ateam_github_log",
    core: true,
    description:
      "View commit history for a solution's GitHub repo. Shows recent commits with messages, SHAs, timestamps, and links. " +
      "Default reads `dev`, the working branch your writes land on (the Builder picks it when no ref is passed). Pass `ref: 'main'` to see what has been promoted to production. The response's `branch` says which one you got.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
        limit: {
          type: "number",
          description: "Max commits to return (default: 10)",
        },
        ref: {
          type: "string",
          // No `default` — see ateam_github_read's ref: the Builder resolves it.
          description: "Branch to read commits from. Omit it for `dev` (the working branch — the Builder resolves it). Use 'main' for production.",
        },
      },
      required: ["solution_id"],
    },
  },
  {
    name: "ateam_github_diff",
    core: true,
    description:
      "PRE-FLIGHT BEFORE PROMOTE. Compares `dev` (head) vs `main` (base) by default — shows exactly which commits and files are about to ship if you call ateam_github_promote() next.\n\n" +
      "Use this when you want to:\n" +
      "  • Review changes before promoting to prod\n" +
      "  • See if dev is ahead of main at all (returns ahead_by: 0 if nothing to promote)\n" +
      "  • **Diagnose a failed promote** — check `behind_by` and `status`. `status: 'diverged'` (behind_by > 0) means main holds commits dev never received, which is what makes ateam_github_promote return 409 Merge conflict. ALWAYS call this after a promote failure, before reporting anything to the user.\n" +
      "  • Inspect arbitrary branch/tag/commit comparisons (override base/head)\n\n" +
      "Note: `files[]` lists what DIFFERS, not what conflicts. For solution.json and skills/*/skill.json the difference is often deploy-generated data (regenerated connector tools, timestamps) rather than authored change — see ateam_github_read's `_ateam_representation`.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: { type: "string", description: "The solution ID" },
        base: { type: "string", description: "Base branch/tag/sha (the target — what you're comparing TO). Default: 'main'.", default: "main" },
        head: { type: "string", description: "Head branch/tag/sha (the source — what you're comparing FROM). Default: 'dev'.", default: "dev" },
      },
      required: ["solution_id"],
    },
  },
  {
    name: "ateam_verify_consistency",
    core: true,
    // ONE definition. It was declared twice (32d2f24, then again as "NEW" in
    // 7a75479, with a second handler key), and the copy tools/list shows stated
    // a contract the route has never returned: drift as ok:false. The route
    // (Builder routes/deploy.js /verify, since 9e51bef) answers ok:true on every
    // probe that ran and puts the verdict in `consistent`.
    description:
      "Check that the Builder filesystem state and GitHub state are in sync for a solution. Read-only probe — does NOT trigger a deploy.\n\n" +
      "Returns { ok: true, consistent, drifts: [{path, kind}] }:\n" +
      "  • consistent: true + drifts: [] if everything matches\n" +
      "  • consistent: false + drifts listing files that differ — kind ∈ fs_missing | content_differs | gh_missing | gh_read_error | repo_unreachable\n" +
      "`ok` says the probe RAN; `consistent` is the answer. Drift is consistent:false, not a failed call. The comparison strips ephemeral fields (timestamps, runtime/deploy-state, resolved-on-load flags), so only REAL content drift surfaces.\n\n" +
      "Drift can creep in when GitHub writes happen but Builder FS doesn't get the mirror update (network blip, container restart mid-write). Boot sync heals most of it on next backend restart; this tool surfaces drift earlier.\n\n" +
      "Run after a series of ateam_github_patch calls to confirm the Builder backend is consistent with GitHub before you ateam_build_and_run.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: { type: "string", description: "The solution ID to verify" },
      },
      required: ["solution_id"],
    },
  },

  // ═══════════════════════════════════════════════════════════════════
  // RELEASE MANAGEMENT — ship (promote), rollback, version listing
  // ═══════════════════════════════════════════════════════════════════

  {
    name: "ateam_github_promote",
    core: true,
    description:
      "SHIP DEV TO PROD. Merges the `dev` branch into `main` and auto-tags the new main HEAD as prod-YYYY-MM-DD-NNN. " +
      "Use after testing your dev work, when you're ready to deploy changes to production.\n\n" +
      "Workflow: 1) ateam_github_patch (writes to dev) → 2) ateam_github_promote (merges dev→main) → 3) ateam_build_and_run (deploys main).\n\n" +
      "Pass dry_run:true to see what's about to ship without merging.\n\nON 409 MERGE CONFLICT: main holds commits dev never received. Call ateam_github_sync_from_main(solution_id) to merge main into dev, then promote again. Only if THAT also returns 409 did both sides edit the same lines — that one needs a human (open a PR on GitHub).",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
        label: {
          type: "string",
          description: "Optional: human-readable label for the auto-tag (e.g., 'v2 stable', 'before refactor')",
        },
        dry_run: {
          type: "boolean",
          description: "If true: show the diff (commits + files about to ship) without merging. Default: false.",
        },
        skip_tag: {
          type: "boolean",
          description: "If true: merge without creating an auto-tag. Default: false (auto-tag enabled).",
        },
      },
      required: ["solution_id"],
    },
  },
  {
    name: "ateam_github_reconcile",
    core: true,
    description:
      "JOIN a diverged dev and main. Use when ateam_github_promote returns PROMOTE_NEEDS_HUMAN or PROMOTE_PRECONDITION_FAILED — i.e. the automatic main→dev back-merge could not resolve itself.\n\n" +
      "TRY sync_from_main FIRST; this tool calls it internally (a plain merge keeps both sides with no judgement call) and only escalates when git genuinely conflicts.\n\n" +
      "On conflict it writes a TWO-PARENT merge commit so the histories actually join. That matters: copying one branch's tree onto the other makes the contents match while leaving NO merge base, so the very next promote conflicts again — equal content is not a reconciled history.\n\n" +
      "Conflicting files are resolved per file, NEWEST WINS, and every decision is reported. Recency is a heuristic, not intent: read the decisions. On a real tenant main held the newer solution.json while dev held the newer widget, so a blanket choice would have reverted one of them.\n\n" +
      "WHO NEEDS THIS: any tenant whose deploys predate the dev-routing fix carries main-only commits the platform itself wrote, and hits this on its first promote afterwards. Pass dry_run:true to see the decisions before writing anything.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: { type: "string", description: "The solution ID" },
        dry_run: { type: "boolean", description: "Report the per-file decisions without writing the merge commit." },
      },
      required: ["solution_id"],
    },
  },
  {
    name: "ateam_github_sync_from_main",
    core: true,
    description:
      "BRING `dev` UP TO DATE WITH `main` — merges main into dev. The mirror of ateam_github_promote.\n\n" +
      "USE THIS WHEN PROMOTE RETURNS 409. promote only ships dev→main, so the moment anything lands on main directly — a hotfix, a manual edit, an ateam_github_rollback, or a write that mis-targeted the branch — dev falls behind and can never be promoted again. Without this tool that divergence is unfixable from A-Team: the only exits are the GitHub web UI or a raw API call.\n\n" +
      "Workflow on a 409: 1) ateam_github_diff (confirm status:'diverged') → 2) ateam_github_sync_from_main → 3) ateam_github_promote.\n\n" +
      "Pass dry_run:true FIRST to see exactly which commits and files would come into dev without changing anything.\n\n" +
      "This is a real merge, not a force: if main and dev edited the SAME lines it returns 409 too, and that one genuinely needs a human (open a PR).",
    monitoring: { safe: true, cost: "low", latency_ms_p95: 2500, output: "bounded" },
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
        dry_run: {
          type: "boolean",
          description: "If true: show the commits + files that would merge into dev, change nothing. Default: false. Call this first.",
        },
      },
      required: ["solution_id"],
    },
  },
  {
    name: "ateam_github_rollback",
    core: true,
    description:
      "Roll prod (`main` branch) back to a previous state.\n\n" +
      "ADDITIVE — does NOT destroy history. Creates a new commit on top of main whose tree matches the target's tree. The history of everything between target and current main is preserved (you can roll back the rollback).\n\n" +
      `Workflow: 1) ateam_github_list_versions (find a ${BRANCH_WORKFLOW.tag_format} tag) → 2) ateam_github_rollback(target: '<that tag>') → 3) ateam_build_and_run(solution_id) (deploys the reverted state) → 4) ateam_github_sync_from_main(solution_id), so \`dev\` carries it too: the iterate tools deploy from \`dev\`. ${BRANCH_WORKFLOW.legacy_tag_note}`,
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
        target: {
          type: "string",
          description: `A ${BRANCH_WORKFLOW.tag_format} tag or a commit SHA to revert main to. Use ateam_github_list_versions to find the tags. ${BRANCH_WORKFLOW.legacy_tag_note}`,
        },
      },
      required: ["solution_id", "target"],
    },
  },
  {
    name: "ateam_github_list_versions",
    core: true,
    description:
      `List the ${BRANCH_WORKFLOW.tag_format} tags each ${BRANCH_WORKFLOW.promote_tool} wrote for a solution — the points ateam_github_rollback can return main to. Shows tag name, date, counter, and commit SHA. ${BRANCH_WORKFLOW.legacy_tag_note}`,
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
      },
      required: ["solution_id"],
    },
  },

  // ═══════════════════════════════════════════════════════════════════
  // INFRASTRUCTURE — redeploy, master key bulk operations
  // ═══════════════════════════════════════════════════════════════════

  {
    name: "ateam_verify_surface",
    core: true,
    description:
      "PROVE a connector ui_plugin actually renders WITH DATA — the required evidence that a user-visible " +
      "UI fix is done. A plugin fetches its data over postMessage from its parent window, so opening its " +
      "iframe alone shows the empty state and 'confirms' the very bug you're checking. This opens the plugin " +
      "in the REAL host surface in headless Chromium, records every MCP tool call it makes, and returns " +
      "{ ok, verdict, visible_text, calls, failures }. It distinguishes 'invented tool name' / 'right tool, " +
      "no data' / 'plugin never asked'. FAIL-CLOSED: a browser-mcp outage returns ok:false verdict:'inconclusive' " +
      "(never a soft pass). Run AFTER a UI/data fix; quote visible_text in your report. Requires authentication.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: { type: "string", description: "The solution id." },
        // CORE bias audit M7 (2026-10-02): this id example was
        // 'mcp:accounting-mcp:spending-dashboard' (242048d) and expect's values
        // were '37.50', 'Groceries' (a1fd01f), one money domain each. Both now
        // pass the swap test: right as written for a fitness log, a CRM, a
        // smart-home panel or a voice guide.
        plugin_id: {
          type: "string",
          description: "The ui_plugin id to probe, in the form 'mcp:<connector-id>:<plugin-name>', e.g. 'mcp:home-mcp:room-panel'.",
        },
        // values: Core's ui.surfaceProbe has taken expect.values since 2984d2a60
        // (2026-08-13; the on-screen half since 77a44bbbb) — its own schema and
        // this description are read from apps/backend/tools/impl/system/
        // ui.surfaceProbe.js. 242048d defined this schema with tools only, so no
        // agent was told it could prove a number came from the data. The
        // handler forwards `expect` whole, so only the schema was missing.
        //
        // WHEN SUCH A TEST IS DONE. a1fd01f said "Use a value from a record you
        // created" and stopped there, so the record stayed in the person's data:
        // the 2026-10-02 release gate's in-app build reported done with its test
        // row still live. The rule is the Builder's TEST_ROW_DONE_RULE
        // (uiPluginRules.js; served in /spec/widgets sections.data_fidelity and
        // /spec/skill human_step_testing.test_data). This names its two demands
        // and POINTS at it, never a copy. The example values and plugin_id's
        // example are the bias audit's (M7), in their own PR.
        expect: {
          type: "object",
          description:
            "Optional assertion. { tools: ['memory.get', ...] } — each listed tool MUST be called by the plugin, else ok:false. " +
            "{ values: ['<a value from a row you created, exactly as the widget shows it, e.g. 7.2 km, Living room, Pasta carbonara>'] } — each string must appear in visible_text AND must DISAPPEAR when the data " +
            "path is disabled: the probe renders the plugin a second time with every data call answered by an error, and a " +
            "value still rendered then is hardcoded in the plugin, so the probe fails it. Use a value from a record you " +
            "created, formatted as the widget shows it. Then finish: delete that record through the solution's own delete, " +
            "and show it gone with the SAME read that showed it after you created it. The whole rule, TEST_ROW_DONE_RULE: " +
            DATA_FIDELITY_AT + ".",
          properties: {
            tools: { type: "array", items: { type: "string" } },
            values: { type: "array", items: { type: "string" } },
          },
        },
        actor_id: { type: "string", description: "Optional actor to render as; defaults to the solution's context actor." },
      },
      required: ["solution_id", "plugin_id"],
    },
  },
  {
    name: "ateam_connector_logs",
    core: true,
    // Bounded by the caller's line limit, but it reads container logs — poll slowly.
    monitoring: { safe: true, cost: "moderate", latency_ms_p95: 3000, output: "bounded", poll_interval_s: 30 },
    // The real case was an accounting dashboard (ffb2ff9). The served text says
    // what happened without that domain, and its connector_id example is
    // generic (CORE bias audit L5).
    description:
      "Read what a connector process actually PRINTED to stderr. This is the only place a connector's " +
      "internal failure is visible: a tool that catches its own error still returns ok:true, and the widget " +
      "then renders an empty state that looks like real data.\n\n" +
      "Real case (2026-08-11): a dashboard connector's data tool got 401 Authentication required from " +
      "Core, swallowed it, returned an empty list, and showed zeros everywhere — while the upload said " +
      "ok, the tool said ok:true, and the surface probe said surface_ok. The word 'Authentication' appeared " +
      "ONLY here.\n\n" +
      "USE IT whenever a tool succeeds but the data is empty, wrong, or zero — that combination is the " +
      "signature of a swallowed error, and 'the call returned ok' is not evidence it worked. Pass the " +
      "returned `cursor` back as `since` to read only what is new since your last look, so you can bracket " +
      "an action and see exactly what it printed. Only stdio (solution) connectors stream stderr through " +
      "Core; a platform/HTTP connector answers ok:false with a reason.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: { type: "string", description: "The solution ID" },
        connector_id: { type: "string", description: "The connector ID (e.g. 'my-connector-mcp')" },
        since: {
          type: "number",
          description: "Cursor from a previous call — returns only lines printed after it. Omit for the whole retained tail.",
        },
        limit: { type: "number", description: "Max lines (default 100, max 300)" },
        errors_only: { type: "boolean", description: "Keep only lines that read as errors (401/failed/exception/refused/…)" },
      },
      required: ["solution_id", "connector_id"],
    },
  },
  {
    name: "ateam_redeploy",
    core: true,
    description:
      "Re-deploy skills WITHOUT changing any definitions. ⚠️ HEAVY OPERATION: regenerates MCP servers (Python code) for every skill, pushes each to A-Team Core, restarts connectors, and verifies tool discovery. Takes 30-120s depending on skill count. Use after connector restarts, Core hiccups, or stale state. For incremental changes, prefer ateam_patch (which updates + redeploys in one step).",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID to redeploy",
        },
        skill_id: {
          type: "string",
          description: "Optional: redeploy a single skill only. Omit to redeploy ALL skills in the solution.",
        },
      },
      required: ["solution_id"],
    },
  },
  {
    name: "ateam_status_all",
    core: true,
    // Safe but not cheap-per-second: health across ALL solutions. Poll sparingly.
    monitoring: { safe: true, cost: "moderate", latency_ms_p95: 3000, output: "bounded", poll_interval_s: 30 },
    description:
      "Show GitHub sync status for ALL tenants and solutions in one call. Requires master key authentication. Returns a summary table of every tenant's solutions with their GitHub sync state.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "ateam_sync_all",
    core: true,
    description:
      // A POINTER, NOT A COPY (CORE on #58, B58R-1): the push half is
      // ateam_github_push's call (github/push), which on a branch holding the
      // solution sends nothing from the Builder's disk but what the branch lacks.
      "Sync ALL tenants: ateam_github_push for each solution (what it writes, and what it keeps: " + PUSH_WRITES_AT +
      "), then pull GitHub → Core MongoDB. Requires master key authentication. Returns a summary table with results for each tenant/solution.",
    inputSchema: {
      type: "object",
      properties: {
        push_only: {
          type: "boolean",
          description: "Only push to GitHub (skip pull to Core). Default: false (full sync).",
        },
        pull_only: {
          type: "boolean",
          description: "Only pull from GitHub to Core (skip push). Default: false (full sync).",
        },
      },
    },
  },
];

// ─── MCP SAFETY HINTS — what a call may do to the tenant ────────────
//
// A client decides from `annotations` whether a tool may run without asking
// (MCP 2025-03-26 ToolAnnotations). None of these tools carried any (ateam-mcp
// #4: "0/47 tools annotated"), and a tool with none is, by the spec's defaults,
// one that may destroy data — so every read here was presented as dangerous as
// a delete.
//
// ONE TABLE, read in one screen, rather than a field scattered through 70
// definitions: the question is the same for every tool, and a reviewer should
// be able to see every answer at once. test/tool-annotations.test.mjs fails if
// a tool is missing from it, if it names a tool that does not exist, and — by
// driving every read and additive tool through the dispatcher — if one of them
// issues a request its class does not allow. So a tool cannot leave
// `destructive` without its behaviour being checked against the class it joins.
//
//   read        — changes nothing on the platform or in a repo. It may POST
//                 when the question needs a body (validate, search, advisor).
//   additive    — creates something new (a log entry, a notification, an
//                 intent-and-planning run that executes no tool) or signs this
//                 session in; overwrites and removes nothing that exists.
//   destructive — may overwrite or remove what exists: definitions, deployed
//                 code, repo files and branches, running jobs. AND anything
//                 that runs code this server cannot see, since that code may do
//                 any of those: a connector tool called directly, a deployed
//                 skill whose planner calls connector tools, a plugin whose own
//                 JS calls them while it renders. Which tool that code picks
//                 (a "read-shaped" name, a plugin's mount-time fetch) is not a
//                 proof of what it does.
// When unsure, the more cautious class: a hint that says "safe" wrongly lets a
// client act without asking, and the opposite mistake only costs a prompt.
export const TOOL_SAFETY = Object.freeze({
  read: [
    "ateam_bootstrap", "ateam_get_spec", "ateam_get_workflows", "ateam_get_examples",
    "ateam_design_advisor", "ateam_spec_search",
    "ateam_validate_skill", "ateam_validate_solution",
    "ateam_list_solutions", "ateam_get_solution", "ateam_show_skill_minimal", "ateam_show_solution_minimal",
    "ateam_get_progress", "ateam_get_lessons",
    "ateam_get_execution_logs", "ateam_test_status", "ateam_get_chain", "ateam_chain_status",
    "ateam_get_metrics", "ateam_connector_logs", "ateam_status_all",
    "ateam_get_widget_catalog",
    "ateam_get_connector_source", "ateam_get_deployed_connector_source",
    "ateam_diff", "ateam_verify_consistency",
    "ateam_github_status", "ateam_github_read", "ateam_github_log", "ateam_github_diff", "ateam_github_list_versions",
  ],
  additive: [
    "ateam_auth",
    // Intent detection + planning only: Core plans the first step and executes
    // none of the skill's tools (server.js /api/test-pipeline).
    "ateam_test_pipeline",
    // A new [TEST] notification to an existing actor's channels.
    "ateam_test_notification",
    "ateam_log_progress", "ateam_log_lesson",
  ],
  destructive: [
    "ateam_build_and_run", "ateam_patch", "ateam_update", "ateam_redeploy",
    "ateam_deploy_solution", "ateam_deploy_skill", "ateam_deploy_connector",
    "ateam_upload_connector", "ateam_upload_connector_files",
    // Scaffolds, but onto an id that may exist: the connector upload replaces,
    // the plugin files overwrite their namesakes.
    "ateam_create_connector", "ateam_create_plugin",
    "ateam_delete_solution", "ateam_delete_skill", "ateam_delete_connector",
    "ateam_recover_connector_source", "ateam_write_agent_doc",
    "ateam_github_push", "ateam_github_pull", "ateam_github_patch", "ateam_github_write",
    "ateam_github_promote", "ateam_github_reconcile", "ateam_github_sync_from_main", "ateam_github_rollback",
    "ateam_sync_all", "ateam_test_abort",
    // RUNS CODE THIS SERVER CANNOT SEE.
    //   a connector tool, by name:            ateam_test_connector
    //   one per connector, "read-shaped" name: ateam_verify (its smoke call)
    //   a deployed skill, end to end — its
    //   planner calls whatever tools it has:  ateam_test_skill, ateam_conversation,
    //                                         ateam_test_voice
    //   the Solution Bot, which edits the
    //   solution it is asked about:           ateam_solution_chat
    //   the plugin's own JS, in the real host,
    //   with live tool calls:                 ateam_verify_surface
    "ateam_test_connector", "ateam_verify",
    "ateam_test_skill", "ateam_conversation", "ateam_test_voice",
    "ateam_solution_chat", "ateam_verify_surface",
  ],
});
const SAFETY_HINTS = {
  read: { readOnlyHint: true },
  additive: { readOnlyHint: false, destructiveHint: false },
  destructive: { readOnlyHint: false, destructiveHint: true },
};
/** tool name → "read" | "additive" | "destructive". Exported for tests, which
 *  also check that no name sits in two classes (a Map would keep the last). */
export const toolSafetyClass = new Map(
  Object.entries(TOOL_SAFETY).flatMap(([cls, names]) => names.map((n) => [n, cls])),
);
// Not a throw for an unclassified tool: this module is the public server, and a
// missing hint must not take it down. A tool left out simply carries none —
// the spec's own cautious default — and test/tool-annotations.test.mjs refuses
// to let that ship.
for (const t of tools) {
  const cls = toolSafetyClass.get(t.name);
  if (cls) t.annotations = { ...SAFETY_HINTS[cls] };
}

/**
 * Core tools — shown in MCP tools/list.
 * Advanced tools are still callable but not advertised.
 */
export const coreTools = tools.filter(t => t.core !== false);

// MONITORING CONTRACT — machine-filterable answer to "what may I poll on a loop?"
// The knowledge used to exist only as prose, scattered and contradictory across
// tool descriptions ("too heavy to loop on" in one, "poll every ~2s" in another,
// different words, different tools), so a caller had to read paragraphs carefully
// to learn which call was safe in a loop. Now it is a field.
//   safe            — may be called repeatedly in a poll loop
//   cost            — cheap | moderate | heavy
//   output          — "bounded" means bounded IN THE RUN'S SIZE, not merely small
//                     today. The silent-degradation failure is a tool that is
//                     concise on a 5-step job and returns 200 steps on a 200-step
//                     job; that is output:"grows_with_run", never safe.
//   poll_interval_s — the interval the tool is designed for
// A tool with NO monitoring field is UNCLASSIFIED — treat as unsafe to poll.
export const monitoringTools = tools
  .filter(t => t.monitoring?.safe === true)
  .map(t => ({ name: t.name, ...t.monitoring }));

// ─── Tool handlers ──────────────────────────────────────────────────

/**
 * THE BRANCH WORKFLOW — ONE DEFINITION, RENDERED EVERYWHERE.
 *
 * ateam_bootstrap is the first thing an external agent reads, and it used to
 * carry the branch story in SIX independently-maintained places: `branching`,
 * `github_tools._note`, `github_tools.branch`, `github_tools.checkpoints`,
 * `github_tools.iteration_workflow`, `github_tools.when_to_use_what`,
 * `developer_loop.steps[]` and `assistant_behavior_contract`. Several readers,
 * one question, no owner — the defect class this whole codebase keeps paying
 * for.
 *
 * What it cost: the single-branch model ("ALL changes go directly to main")
 * was live from 4eced4f (2026-03-21) until 2026-09-23 — four months after
 * promote became a real dev→main merge (7a75479) and a month after writes moved
 * to dev (6e4470e). Then I "fixed" it twice by grepping for the strings I
 * happened to think of, and both times an external agent found survivors — the
 * second time INSIDE ONE RESPONSE, where `branching` dated its own former error
 * while `assistant_behavior_contract.always` still asserted it.
 *
 * So the sections below do not describe the workflow. They render it from
 * here. Change it once; every surface moves together, or none does.
 */

const SPEC_PATHS = {
  overview: "/spec",
  skill: "/spec/skill",
  solution: "/spec/solution",
  enums: "/spec/enums",
  "connector-multi-user": "/spec/multi-user-connector",
  python_helpers: "/spec/python_helpers",
  widgets: "/spec/widgets",
  "ui-plugins": "/spec/ui-plugins",
  // Capability topics — MUST stay in sync with the capability catalog's
  // spec_topic values so every ateam_design_advisor `read_spec` pointer
  // resolves (was OPEN-19: advisor pointed at topics get_spec didn't accept).
  "actor-storage": "/spec/actor-storage",
  voice: "/spec/voice",
  "voice-native": "/spec/voice-native",
  triggers: "/spec/triggers",
  "sub-agent": "/spec/sub-agent",
  "consumer-roles": "/spec/consumer-roles",
  "mobile-connector": "/spec/mobile-connector",
  // GENERATED from the mobile SDK's own contract + status doc, not written by
  // hand: the hand-written version drifted in 19 days and a builder designed
  // away from a capability that had shipped.
  "device-capabilities": "/spec/device-capabilities",
  // THE FRONT DOOR. Every other topic is named after one of OUR artifacts;
  // this one is named after what a solution DOES ("can I see? can I talk with
  // them? do I know where they are?"). It holds no capability facts of its own
  // — device answers are computed from the generated matrix — so it points
  // without being able to go stale.
  capabilities: "/spec/capabilities",
  // HOW to build it, once /spec/capabilities has said WHETHER. The routes are
  // easy to confuse and each confusion changes the product: continuous vision
  // vs a photo loop, live GPS vs last-synced, an in-process voice device call
  // vs a server round trip.
  realizations: "/spec/realizations",
  // Served by every deployment and nameable by NOBODY until 2026-09-23: these
  // five were absent from both hand-maintained lists in this file, so no agent
  // could request them however correctly it asked. test/spec-topics.test.mjs
  // proved the enum and the map agreed with EACH OTHER — two copies of our own
  // belief — and could not see that the server served more than both.
  // It now checks against the deployment.
  "host-contract": "/spec/host-contract",
  "platform-connectors": "/spec/platform-connectors",
  "platform-truth": "/spec/platform-truth",
  sdk: "/spec/sdk",
  workflows: "/spec/workflows",
  // A PART of the skill spec, not a page of its own: the Builder serves how a
  // run ends once, at /spec/skill → finalization (FINALIZATION in its
  // capabilitySpecs.js), and ateam_get_spec(topic:"skill", search:
  // "finalization") returns it whole. This topic is that read, so an agent that
  // asks for "finalization" is not left with 190,000 characters of skill spec
  // cut to fit one response. SPEC_TOPIC_PART names the search.
  finalization: "/spec/skill",
};

// Topics that are one part of a bigger page: the search that returns the part
// whole. The caller's own `search` still wins.
const SPEC_TOPIC_PART = {
  finalization: "finalization",
};

/** Small delay helper */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════
// Phase 7 strip: connector + plugin scaffolds
// ───────────────────────────────────────────────────────────────────
// ── The Builder's create-only upload (if_absent, Builder #160) ────────────────
// ateam_create_connector and ateam_create_plugin do not ask first and then
// upload: the check and the write are ONE request the Builder answers under its
// per-connector lock, `{ files, if_absent: true }` for a connector and
// `{ files, if_absent: { plugin } }` for one plugin. It checks the Builder's
// source, the repo's working branch and Core, and writes only when none of them
// holds it. (The client-side check this replaced read GET …/source: a failed
// read looked like "new", and anything landing between the question and the
// upload was replaced — CORE on #50, AM50-R1/R2/R6.) These two functions are the
// ONE reading of that answer, for the sync reply (a thrown HTTP error) and for
// an async job's result ({ ok, http_status, code, … }).

/** "the Builder's source (a, b, +2 more), Core" — where found_in found it. */
function placesFound(found) {
  return (Array.isArray(found) ? found : []).map((f) => {
    const name = f?.where === "github" ? `the repo's ${f.branch || "working"} branch`
      : f?.where === "core" ? "Core" : "the Builder's source";
    const paths = Array.isArray(f?.paths) ? f.paths : [];
    return paths.length > 0 ? `${name} (${paths.slice(0, 3).join(", ")}${paths.length > 3 ? `, +${paths.length - 3} more` : ""})` : name;
  }).join("; ");
}

/** What to do next, per place the files were found. */
function existsNext(found, solutionId, connectorId) {
  const at = (found || []).map((f) => f?.where);
  const args = `solution_id:'${solutionId}', connector_id:'${connectorId}'`;
  const next = [];
  if (at.includes("builder") || at.includes("github")) {
    next.push(`ateam_get_connector_source(${args}) reads it; change it with ateam_github_patch (one file per call), then ateam_upload_connector(${args}, github:true)`);
  }
  if (at.includes("core")) {
    next.push(at.includes("builder") || at.includes("github")
      ? `ateam_get_deployed_connector_source(${args}) shows what Core runs, which may differ`
      : `Core runs it but the Builder holds no source of it: ateam_get_deployed_connector_source(${args}) shows what Core runs, and ateam_recover_connector_source(${args}) adopts it as the Builder's source; change it from there`);
  }
  return next;
}

/**
 * The Builder's answer to a create-only upload, as the refusal a caller is
 * handed, or null when it is not one of the Builder's create-only answers (the
 * caller then rethrows the error, or reports the job's failure).
 * @param {"connector"|"plugin"} scope
 * @param {{ status: number|null|undefined, body: object|null }} answer  an HTTP error's status and JSON body, or an async job's http_status and result
 * @param {{ solutionId: string, connectorId: string, pluginName?: string, afterAsyncKick?: boolean }} ctx
 */
function createOnlyRefusal(scope, { status, body }, ctx) {
  const { solutionId, connectorId, pluginName, afterAsyncKick } = ctx;
  const code = body?.code;
  const args = `solution_id:'${solutionId}', connector_id:'${connectorId}'`;
  const what = scope === "plugin" ? `plugin "${pluginName}" of connector "${connectorId}"` : `connector "${connectorId}"`;
  if (status === 409 && (code === "CONNECTOR_EXISTS" || code === "PLUGIN_EXISTS")) {
    const plugin = code === "PLUGIN_EXISTS";
    return {
      ok: false,
      code,
      connector_id: connectorId,
      ...(plugin && { plugin: body.plugin || pluginName }),
      found_in: body.found_in || [],
      error: `${plugin ? `Plugin "${body.plugin || pluginName}" of connector "${connectorId}" already has files` : `Connector "${connectorId}" already exists`}: ` +
        `${placesFound(body.found_in) || "the Builder found files"}. Create never replaces, so nothing was created or uploaded.` +
        (afterAsyncKick ? " An earlier attempt of this same call was accepted before this one, and may be what created it." : ""),
      next: [
        ...existsNext(body.found_in, solutionId, connectorId),
        plugin ? "or create the plugin under another name" : "or create a new connector under another id",
      ],
    };
  }
  if (status === 409 && code === "CONNECTOR_BASE_MISSING" && scope === "plugin") {
    return {
      ok: false,
      code,
      connector_id: connectorId,
      error: `Connector "${connectorId}" has nothing to add the plugin to: it exists nowhere (not in the Builder's source, on the repo's working branch, or in Core). Nothing was uploaded.`,
      next: [`Create the connector first: ateam_create_connector(${args}, ui_capable:true), then ateam_create_plugin again`],
    };
  }
  if (status === 409 && code === "UPLOAD_WOULD_DELETE") {
    const lost = (Array.isArray(body.would_delete_unreadable) ? body.would_delete_unreadable : []).map((u) => u?.path || u).slice(0, 5);
    return {
      ok: false,
      code,
      connector_id: connectorId,
      ...(body.would_delete_unreadable && { would_delete_unreadable: body.would_delete_unreadable }),
      error: UPLOAD_DROPS_UNREADABLE.refusal(what, lost.length > 0 ? ` (${lost.join(", ")})` : ""),
      next: UPLOAD_DROPS_UNREADABLE.next(args),
    };
  }
  if (status === 502 && code === "CONNECTOR_UNREADABLE") {
    const layers = (Array.isArray(body.unreadable) ? body.unreadable : []).map((u) => `${u?.where || "a layer"} (${u?.error || "no reason given"})`).join("; ");
    return {
      ok: false,
      code,
      connector_id: connectorId,
      retryable: true,
      unreadable: body.unreadable || [],
      error: `Could not tell whether ${what} exists: ${layers || "a layer could not be read"}. Nothing was created or uploaded, and an unreadable answer is not an empty one.`,
      next: [
        "Retry the same call once it answers: nothing was written",
        "If it keeps failing, ateam_get_connector_source and ateam_get_deployed_connector_source show which layer is down. Never create it with replace:true",
      ],
    };
  }
  if (status === 400 && code === "INVALID_IF_ABSENT") {
    return {
      ok: false,
      code,
      connector_id: connectorId,
      error: `The Builder refused the create-only request: ${body.error || "if_absent is invalid"}. Nothing was read or written.`,
      next: ["This is a mismatch between ateam-mcp and the Builder, not something to work around: report it, and do not create with replace:true"],
    };
  }
  return null;
}

/**
 * A 2xx from a create-only upload that does NOT say create_only: an older
 * Builder, which ignored if_absent and ran the upload as a plain merge. It may
 * have written the scaffold over what was there. Never "created"; never a
 * retry with replace.
 */
function createNotSafeYet(scope, upload, ctx) {
  const what = scope === "plugin" ? `plugin "${ctx.pluginName}" of connector "${ctx.connectorId}"` : `connector "${ctx.connectorId}"`;
  return {
    ok: false,
    code: "BUILDER_CANNOT_CREATE_SAFELY",
    connector_id: ctx.connectorId,
    error: `This Builder cannot create safely yet: it answered without create_only, so it ignored if_absent and ran the upload as a merge. ${what[0].toUpperCase()}${what.slice(1)} may have been overwritten. Nothing was reported as created.`,
    next: [
      `ateam_get_connector_source(solution_id:'${ctx.solutionId}', connector_id:'${ctx.connectorId}') shows what it holds now`,
      "Use the Builder's current version before creating again. ateam_create_connector and ateam_create_plugin never fall back to replace:true",
    ],
    upload_result: upload,
  };
}

// ── An earlier create_plugin job of this process (Builder #160, PR160-R5) ──────
// A PLUGIN_EXISTS that follows an async job THIS process accepted for the same
// plugin is not necessarily a stranger's files: the job may be what created
// them — the async kick accepted, its result not read (the poll gave up, the
// call was repeated, or a sync retry waited for the connector's lock behind the
// job and then found the plugin there). So it is not answered as "someone else
// has it": the earlier job is read, and what it did is said, with its id. Only
// jobs this process accepted are known, and for as long as the Builder keeps a
// finished job (30 minutes).
const acceptedPluginJobs = new Map(); // owner + connector + plugin → { job_id, at }
const ACCEPTED_PLUGIN_JOB_KEPT_MS = 30 * 60_000;

function pluginJobKey(sid, solutionId, connectorId, pluginName) {
  return `${buildRunOwner(sid, solutionId)}\n${connectorId}\n${pluginName}`;
}

/** The job id this process accepted earlier for this plugin, if it still counts. */
function earlierPluginJob(key) {
  const rec = acceptedPluginJobs.get(key);
  if (!rec) return null;
  if (Date.now() - rec.at >= ACCEPTED_PLUGIN_JOB_KEPT_MS) { acceptedPluginJobs.delete(key); return null; }
  return rec.job_id;
}

/**
 * A PLUGIN_EXISTS refusal, read against the earlier job that may have created
 * the plugin. Anything else, or no earlier job, comes back unchanged.
 */
async function settleAgainstEarlierJob(refusal, earlierJobId, { sid, connectorId, pluginName }) {
  if (refusal?.code !== "PLUGIN_EXISTS" || !earlierJobId) return refusal;
  let job = null;
  try { job = await get(apiPath`/deploy/jobs/${earlierJobId}`, sid); } catch { /* unknown: the plain refusal stands, naming the job */ }
  const pluginId = `mcp:${connectorId}:${pluginName}`;
  if (job?.status === "done" && job.create_only === "plugin") {
    return {
      ok: true,
      code: "PLUGIN_CREATED_BY_EARLIER_JOB",
      created_now: false,
      plugin_id: pluginId,
      job_id: earlierJobId,
      note: `The plugin was created by the earlier job ${earlierJobId}; nothing new was written by this call. Check that job's result (upload_result).`,
      upload_result: job,
      next_steps: ["ateam_get_widget_catalog shows whether it is listed and renders"],
    };
  }
  if (job && job.status !== "done" && job.status !== "failed") {
    return {
      ok: false,
      code: "PLUGIN_CREATE_IN_PROGRESS",
      plugin_id: pluginId,
      job_id: earlierJobId,
      retryable: true,
      error: `An earlier create of plugin "${pluginName}" (job ${earlierJobId}) is still running: do not repeat it. Nothing new was written by this call.`,
      next: ["Wait for that job, then read the connector (ateam_get_connector_source) to see what it wrote"],
    };
  }
  return { ...refusal, earlier_job_id: earlierJobId, error: `${refusal.error} An earlier create of this plugin (job ${earlierJobId}) was accepted by this session${job?.status === "failed" ? " and failed" : ", its result could not be read"}.` };
}

/** An upload that failed in a way that is none of the create-only answers (an async job's failed result, or its poll that gave up). */
function uploadFailed(result) {
  return {
    ok: false,
    code: result?.code || "UPLOAD_FAILED",
    http_status: result?.http_status ?? null,
    error: result?.error || "The upload did not succeed.",
    ...(result?.hint && { hint: result.hint }),
    upload_result: result,
  };
}

// Pure client-side templates. ateam_create_connector / ateam_create_plugin
// produce file contents + push them via the existing /deploy/.../upload
// endpoint. The author writes only the unique tool implementations and
// component bodies; the ~50% of boilerplate per connector/plugin (MCP
// server setup, theme/bridge hooks, postMessage protocol, package.json)
// is template-generated.
// ═══════════════════════════════════════════════════════════════════

// The SDK pins below are the floor THE template teaches, and what the MCP SDK
// itself accepts for zod. `./serve` (defineConnector) needs @ateam-ai/sdk
// >=1.2.4: earlier versions lose the caller on a tool with no input schema.
const SCAFFOLD_SDK_VERSION = "^1.4.0";
const SCAFFOLD_ZOD_VERSION = "^3.25.0 || ^4.0.0";

function _scaffoldConnectorFiles({ connectorId, displayName, uiCapable }) {
  const safeName = displayName || connectorId;
  const files = [];

  // server.js — a defineConnector skeleton (@ateam-ai/sdk/serve), the runtime
  // the Builder's pages recommend: the author writes handlers, the runtime owns
  // stdio, the error shape and WHO IS CALLING (ctx).
  //
  // History. ae85a46 (2026-05-12) scaffolded on the MCP SDK; 21eb3bb
  // (2026-07-18) rewrote it as raw JSON-RPC because the SDK form registered
  // ui.listPlugins / ui.getPlugin as request METHODS, and Core — which reads
  // tools/list — never saw a UI-capable connector. That reason predates
  // defineConnector (Builder a11f2f67, 2026-08-21), which registers every entry
  // as a TOOL (serve.js buildServer → server.tool), so the UI fix holds here:
  // both are tools, reading ui-dist/<plugin>/manifest.json at call time.
  // The raw form declared _adas_actor in every tool's schema and hand-read it
  // (getActorId) — the identity form the Builder's storage decision forbids,
  // and that defineConnector refuses at definition — and said nothing about
  // where data goes (Builder #107 review, B107-1; BUILDER-7).
  // Its NEVER SWALLOW incident (ff85585) said "an empty ledger … showed 0.00":
  // every generated connector carried that domain. It now says what happened
  // without it (CORE bias audit, 2026-10-02).
  const serverJs = `#!/usr/bin/env node
// ${connectorId} — an A-Team stdio MCP connector on defineConnector
// (@ateam-ai/sdk/serve). Generated by ateam_create_connector. You write the
// tool handlers; the runtime owns the wire: stdio, the error shape, and who is
// calling.
//
// Caller identity: ctx (never an argument). Where data lives:
// ${STORAGE_DECISION_AT}; records go to actorStore through the store() helper
// in complete_example.code. This directory is READ-ONLY at runtime.
//
// ⚠️ NEVER SWALLOW A FAILURE. If something this tool depends on fails — a fetch,
// a platform call, a store read — RETURN THE ERROR. Do not catch it and answer
// with empty data:
//
//   BAD:   try { rows = await load(); } catch { rows = []; }   // renders zeros forever
//   GOOD:  rows = await load();   // let it throw: defineConnector answers { ok: false, error }
//
// A tool that returns ok:true with an empty result when its dependency is broken
// is INDISTINGUISHABLE from one that genuinely has no data — to the widget, to
// the person reading the screen, and to the agent trying to fix it. That exact
// shape cost a full day: a connector caught a 401, returned an empty list, and
// the dashboard showed zeros while every check reported success.

import { defineConnector } from "@ateam-ai/sdk/serve";
import { z } from "zod";${uiCapable ? `
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── UI plugin discovery ── read ui-dist/<plugin>/manifest.json at call time so
// a newly-uploaded plugin appears with no server.js change. The manifest is the
// single source of truth for the render block (ateam_create_plugin writes it).
const __dir = dirname(fileURLToPath(import.meta.url));
const UI_DIST = join(__dir, "ui-dist");

function discoverPlugins() {
  const out = [];
  if (!existsSync(UI_DIST)) return out;
  for (const entry of readdirSync(UI_DIST, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const mp = join(UI_DIST, entry.name, "manifest.json");
    if (!existsSync(mp)) continue;
    try {
      const m = JSON.parse(readFileSync(mp, "utf8"));
      out.push({ ...m, id: m.id || entry.name });
    } catch (e) {
      console.error(\`[${connectorId}] bad manifest for \${entry.name}: \${e.message}\`);
    }
  }
  return out;
}` : ""}

const connector = defineConnector({
  name: "${connectorId}",
  version: "1.0.0",
  tools: {
    // Replace with your real tools. \`input\` is a RAW zod shape of YOUR fields
    // only — never an _adas_* field (refused at definition). The caller is ctx:
    // ctx.actorId (the user), ctx.skill (this connector's id), ctx.tenant.
    "${connectorId}.echo": {
      description: "Echo back the input. Replace with your real tools.",
      input: { message: z.string() },
      async handler({ message }, ctx) {
        return { ok: true, echo: message, actor: ctx.actorId };
      },
    },${uiCapable ? `

    // ── UI registry plumbing ── Core reads tools/list: a TOOL named
    // ui.listPlugins is how it knows this connector is UI-capable. No user is
    // behind Core's discovery call, so these two serve everyone.
    "ui.listPlugins": {
      description: "List available UI plugins.",
      actor: "optional",
      async handler() {
        const plugins = discoverPlugins().map((p) => ({
          id: p.id, name: p.name || p.id, version: p.version || "1.0.0",
          description: p.description || "",
          ...(p.uiActions ? { uiActions: p.uiActions } : {}),
          ...(p.surface ? { surface: p.surface } : {}),
        }));
        return { plugins };
      },
    },
    "ui.getPlugin": {
      description: "Get a UI plugin manifest by id.",
      input: { id: z.string() },
      actor: "optional",
      async handler({ id }) {
        const p = discoverPlugins().find((pl) => pl.id === id);
        if (!p) return { error: \`Plugin \${id} not found\` };
        return p; // the manifest already carries the render block
      },
    },` : ""}
  },
});

await connector.start();   // stdio — the transport Core spawns
`;
  files.push({ path: "server.js", content: serverJs });

  // package.json — the runtime and zod, which the skeleton imports. The MCP SDK
  // is @ateam-ai/sdk's peer; npm installs it with the package.
  const pkg = {
    name: connectorId,
    version: "1.0.0",
    type: "module",
    description: `${safeName} — A-Team MCP connector`,
    main: "server.js",
    dependencies: {
      "@ateam-ai/sdk": SCAFFOLD_SDK_VERSION,
      zod: SCAFFOLD_ZOD_VERSION,
    },
  };
  files.push({ path: "package.json", content: JSON.stringify(pkg, null, 2) + "\n" });

  // README.md
  const readme = `# ${safeName}

Connector ID: \`${connectorId}\`
${uiCapable ? "UI-capable: yes" : ""}

## Adding tools

Edit \`server.js\`: add an entry under \`tools\` in \`defineConnector({...})\` —
a \`description\`, an \`input\` (a raw zod shape of your own fields), and a
\`handler(args, ctx)\`. The caller is \`ctx\` (\`ctx.actorId\`), never an argument:
declaring an \`_adas_*\` field in \`input\` is refused at definition.

## Where data goes

${STORAGE_DECISION_AT} — records (anything the product lists, counts or
totals) go to actorStore through the \`store()\` helper in THE template,
\`complete_example.code\` on that page. This directory is READ-ONLY at runtime:
never write data next to the code.

## Adding UI plugins (ui_capable connectors)

Use \`ateam_create_plugin\` (or drop the files yourself): iframe plugins go under
\`ui-dist/<plugin-name>/index.html\` with a \`ui-dist/<plugin-name>/manifest.json\`.
RN plugins have editable source at \`rn-src/<plugin-name>.tsx\` (imported from
\`@adas/plugin-sdk\`) AND a PRE-BUILT, COMMITTED bundle at
\`rn-bundle/<plugin-name>.bundle.js\` — the mobile
app downloads the bundle, never the .tsx. A deploy builds only what this
package.json declares: it runs every \`build\` / \`build:*\` script it finds, and
this scaffold declares none. So after editing the .tsx, rebuild the bundle with
the esbuild command in its header and commit it, or declare a \`build:rn\`
script with \`esbuild\` in \`devDependencies\` and let the deploy build it (a
package with a build script is installed WITH its devDependencies;
\`ateam_get_spec(topic: "ui-plugins")\`). This
connector's \`ui.listPlugins\` / \`ui.getPlugin\` read the manifests at call time,
so a new plugin renders with NO server.js edit.

## Deploy

Use \`ateam_upload_connector\` to push the latest source to Core without a full
skill redeploy.
`;
  files.push({ path: "README.md", content: readme });

  return files;
}

function _scaffoldPluginFiles({ connectorId, pluginName, kind }) {
  const files = [];

  if (kind === "iframe" || kind === "adaptive") {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${pluginName}</title>
<style>
  body { font-family: system-ui, sans-serif; padding: 16px; margin: 0; }
  .card { background: #f5f5f5; padding: 12px; border-radius: 8px; }
</style>
</head>
<body>
<div class="card">
  <h2>${pluginName}</h2>
  <p>Plugin body — replace with your real UI.</p>
  <button id="callTool">Call sample tool</button>
  <pre id="output"></pre>
</div>
<script type="module">
  // ── Plugin <-> host protocol — what the host reads (ateam_get_spec("ui-plugins"): iframe_plugin_guide.protocol) ──
  // SEND     { source:"adas-plugin", message:{ action:"mcp-call", payload:{ requestId, connectorId, tool, args } } }
  // RECEIVE  { source:"adas-host",   message:{ type:"mcp-result", payload:{ requestId, result, error } } }
  // Send is matched on message.ACTION, receive on message.TYPE: that is not a typo.
  // The host's first message is init; its payload.connectorId goes on every call.
  // mcpCall(tool, args, connectorId?) resolves with the tool's own answer, or rejects
  // with its reason: the host's error, the tool's {ok:false}, or a timeout.

  const CALL_TIMEOUT_MS = 15000;
  const pending = new Map();
  let hostConnectorId = null;

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || typeof d !== "object" || d.source !== "adas-host") return;
    const m = d.message || {};
    if (m.type === "init") { hostConnectorId = m.payload?.connectorId || hostConnectorId; return; }
    if (m.type !== "mcp-result") return;
    const call = pending.get(m.payload?.requestId);
    if (!call) return;
    pending.delete(m.payload.requestId);
    clearTimeout(call.timer);
    if (m.payload.error) call.reject(new Error(m.payload.error));
    else call.settle(m.payload.result);
  });

  // Results arrive MCP-wrapped ({ content:[{ type:"text", text:"<json>" }] }), sometimes twice.
  // A tool that fails with { ok:false } and no isError arrives as a SUCCESS: look inside.
  function toolAnswer(raw) {
    let v = raw;
    for (let i = 0; i < 3; i++) {
      const block = v?.content?.[0];
      if (v?.isError === true) throw new Error(block?.text || "the tool reported an error");
      if (block?.type !== "text") break;
      try { v = JSON.parse(block.text); } catch { return block.text; }
    }
    if (v && v.ok === false) throw new Error(v.error || v.message || JSON.stringify(v));
    return v;
  }

  function mcpCall(tool, args = {}, connectorId = hostConnectorId) {
    return new Promise((resolve, reject) => {
      if (!connectorId) {
        reject(new Error("no connectorId: the host has not sent its init message (is this page running inside the app?)"));
        return;
      }
      const requestId = "req_" + Math.random().toString(36).slice(2);
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("no reply from the host to " + tool + " within " + CALL_TIMEOUT_MS / 1000 + "s"));
      }, CALL_TIMEOUT_MS);
      pending.set(requestId, {
        timer,
        reject,
        settle: (raw) => { try { resolve(toolAnswer(raw)); } catch (err) { reject(err); } },
      });
      window.parent.postMessage({
        source: "adas-plugin",
        message: { action: "mcp-call", payload: { requestId, connectorId, tool, args } },
      }, "*");
    });
  }

  const output = document.getElementById("output");
  const show = (text, failed) => { output.textContent = text; output.style.color = failed ? "#b00020" : ""; };

  document.getElementById("callTool").addEventListener("click", async () => {
    show("Calling...");
    try {
      const answer = await mcpCall("${connectorId}.echo", { message: "hello" });
      show(typeof answer === "string" ? answer : JSON.stringify(answer, null, 2));
    } catch (err) {
      show("Error: " + err.message, true);
    }
  });
</script>
</body>
</html>
`;
    files.push({
      path: `ui-dist/${pluginName}/index.html`,
      content: html,
    });
  }

  if (kind === "rn" || kind === "adaptive") {
    const tsx = `// ${pluginName} — React Native plugin SOURCE (editable). Generated by ateam_create_plugin.
//
// ⚠️  The mobile app loads the PRE-BUILT, COMMITTED bundle at
//     rn-bundle/${pluginName}.bundle.js, NOT this file. cp.getContextPlugin
//     advertises reactNative.bundleUrl only when that bundle exists on disk —
//     no bundle → mobile has nothing to download.
//
//     A deploy builds only what the connector's package.json declares: it runs
//     every "build" / "build:*" script there. This scaffold declares none, so
//     nothing rebuilds the bundle for you. Either rebuild it yourself (below),
//     or declare a "build:rn" script with esbuild in devDependencies and let
//     the deploy build it (a package with a build script is installed WITH its
//     devDependencies) — see ateam_get_spec(topic: "ui-plugins").
//
// After editing this file, rebuild the bundle and commit it (target=es2015 is
// REQUIRED — the mobile runtime evals the bundle with new Function(), which
// cannot parse async/await; es2015 downlevels it):
//   npx esbuild rn-src/${pluginName}.tsx --bundle --format=cjs --platform=neutral --target=es2015 --external:react --external:react-native --external:@adas/plugin-sdk --outfile=rn-bundle/${pluginName}.bundle.js

import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useApi } from '@adas/plugin-sdk';
import type { PluginProps } from '@adas/plugin-sdk';

// Plain object export — NO PluginSDK.register() (pollutes shared registry).
export default {
  id: '${pluginName}',
  type: 'ui',
  version: '1.0.0',
  capabilities: { haptics: true },

  Component({ bridge, native, theme }: PluginProps) {
    const api = useApi(bridge);
    const [output, setOutput] = useState<string>('');

    const handlePress = async () => {
      try {
        native?.haptics?.selection?.();
        const result = await api.call('${connectorId}.echo', { message: 'hello' });
        setOutput(JSON.stringify(result, null, 2));
      } catch (err: any) {
        native?.haptics?.notification?.('error');
        setOutput('Error: ' + err.message);
      }
    };

    const styles = StyleSheet.create({
      container: { padding: 16, backgroundColor: theme.colors.bg, flex: 1 },
      card: { backgroundColor: theme.colors.surface, padding: 12, borderRadius: 8 },
      title: { fontSize: 18, fontWeight: '600', color: theme.colors.text, marginBottom: 8 },
      button: { backgroundColor: theme.colors.accent, padding: 12, borderRadius: 6, marginTop: 12 },
      buttonText: { color: '#fff', textAlign: 'center', fontWeight: '600' },
      output: { color: theme.colors.textMuted, marginTop: 12, fontFamily: 'Menlo' },
    });

    return (
      <View style={styles.container}>
        <View style={styles.card}>
          <Text style={styles.title}>${pluginName}</Text>
          <Text style={{ color: theme.colors.textMuted }}>
            Plugin body — replace with your real UI.
          </Text>
          <TouchableOpacity style={styles.button} onPress={handlePress}>
            <Text style={styles.buttonText}>Call sample tool</Text>
          </TouchableOpacity>
          {!!output && <Text style={styles.output}>{output}</Text>}
        </View>
      </View>
    );
  },
};
`;
    files.push({
      path: `rn-src/${pluginName}.tsx`,
      content: tsx,
    });

    // Pre-built RN bundle — THIS is the file the mobile app actually downloads.
    // cp.getContextPlugin only advertises reactNative.bundleUrl when a
    // rn-bundle/<pluginId>.bundle.js (or index.bundle.js) exists on disk. A
    // deploy runs the connector's `build` / `build:*` scripts (Core's mcp-store,
    // connectorBuildScripts.js since Core 0fa6d551e), but this scaffold's
    // package.json declares none and has no dependencies, so nothing builds it
    // there: we SHIP it pre-built and committed. Without this file the manifest
    // carries render.reactNative.component but no bundleUrl and mobile renders
    // nothing (the web iframe still works), and Core refuses a connector that
    // has rn-src/ but no rn-bundle/*.bundle.js (422). Named per-plugin (matches
    // cp.getContextPlugin's \`${'$'}{pluginId}.bundle.js\` primary lookup) so multiple RN widgets can
    // coexist in one connector. Kept in sync with the .tsx above via the esbuild
    // command in its header. es2015 CJS, plain-object default export, no
    // async/await — passes the mobile new Function() load test.
    const rnBundle = `"use strict";
// ${pluginName} — pre-built React Native bundle (es2015 CJS). Generated by
// ateam_create_plugin from rn-src/${pluginName}.tsx. DO NOT hand-edit —
// edit the .tsx and rerun the esbuild command in its header, then commit this.
var React = require("react");
var ReactNative = require("react-native");
var sdk = require("@adas/plugin-sdk");
var useState = React.useState;
var h = React.createElement;
var View = ReactNative.View;
var Text = ReactNative.Text;
var TouchableOpacity = ReactNative.TouchableOpacity;
var StyleSheet = ReactNative.StyleSheet;
var useApi = sdk.useApi;

function Component(props) {
  var native = props.native, theme = props.theme;
  var api = useApi(props.bridge);
  var _s = useState(""), output = _s[0], setOutput = _s[1];

  function handlePress() {
    if (native && native.haptics && native.haptics.selection) native.haptics.selection();
    api.call("${connectorId}.echo", { message: "hello" }).then(function (result) {
      setOutput(JSON.stringify(result, null, 2));
    }, function (err) {
      if (native && native.haptics && native.haptics.notification) native.haptics.notification("error");
      setOutput("Error: " + (err && err.message ? err.message : String(err)));
    });
  }

  var c = theme.colors;
  var styles = StyleSheet.create({
    container: { padding: 16, backgroundColor: c.bg, flex: 1 },
    card: { backgroundColor: c.surface, padding: 12, borderRadius: 8 },
    title: { fontSize: 18, fontWeight: "600", color: c.text, marginBottom: 8 },
    button: { backgroundColor: c.accent, padding: 12, borderRadius: 6, marginTop: 12 },
    buttonText: { color: "#fff", textAlign: "center", fontWeight: "600" },
    output: { color: c.textMuted, marginTop: 12, fontFamily: "Menlo" }
  });

  return h(View, { style: styles.container },
    h(View, { style: styles.card },
      h(Text, { style: styles.title }, "${pluginName}"),
      h(Text, { style: { color: c.textMuted } }, "Plugin body — replace with your real UI."),
      h(TouchableOpacity, { style: styles.button, onPress: handlePress },
        h(Text, { style: styles.buttonText }, "Call sample tool")),
      output ? h(Text, { style: styles.output }, output) : null
    )
  );
}

var plugin = {
  id: "${pluginName}",
  type: "ui",
  version: "1.0.0",
  capabilities: { haptics: true },
  Component: Component
};

module.exports = plugin;
module.exports.default = plugin;
`;
    files.push({
      path: `rn-bundle/${pluginName}.bundle.js`,
      content: rnBundle,
    });
  }

  // Emit a manifest.json with the render block the platform requires. A plugin
  // is only DISCOVERABLE + RENDERABLE if it appears in the connector's
  // ui.listPlugins / ui.getPlugin output WITH a render.{ mode, iframeUrl?,
  // reactNative? } — dropping the HTML/TSX files alone is NOT enough. This
  // manifest is the source of truth for that block; connectors whose
  // ui.listPlugins is generated from ui-dist/<plugin>/manifest.json pick it up
  // automatically, and for connectors with a HARDCODED plugin list (e.g.
  // personal-assistant-ui-mcp) copy this render block into their ui.getPlugin.
  const mode = kind === "iframe" ? "iframe" : kind === "rn" ? "react-native" : "adaptive";
  const render = { mode };
  if (kind === "iframe" || kind === "adaptive") render.iframeUrl = `/ui/${pluginName}/index.html`;
  if (kind === "rn" || kind === "adaptive") render.reactNative = { component: pluginName };
  const prettyName = pluginName.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  files.push({
    path: `ui-dist/${pluginName}/manifest.json`,
    content: JSON.stringify({
      id: pluginName,
      name: prettyName,
      version: "1.0.0",
      description: `${prettyName} plugin — replace with your real description.`,
      render,
      channels: ["command"],
      capabilities: { commands: [] },
    }, null, 2) + "\n",
  });

  return files;
}



// WHERE THE CHAIN ACTUALLY LIVES IN THE RESPONSE.
//
// The agent API answers {ok, success, data:{...}}, so the tree is at
// data.chainJobs / data.executionSteps — NOT at chain.chainJobs, which is what
// ateam_get_chain's own description has been telling readers (and what I wrote
// the chain-aware tools against). Reading the wrong path does not throw: it
// yields job_count 0, step_count 0, ok:true — a GREEN, EMPTY answer, which is
// the single most misleading result this platform can produce and the thing its
// own docs warn about. Verified against a live 2-skill chain
// (auto-orchestrator -> staff-scheduling): 2 jobs, 3 steps.
//
// Accepts every wrapping rather than betting on one, so a shape change degrades
// to "still finds it" instead of "silently reports an empty run".
function chainTreeOf(resp) {
  const c = resp?.data || resp?.chain || resp || {};
  const inner = c.chain || c;
  return {
    jobs: inner.chainJobs || c.chainJobs || [],
    steps: inner.executionSteps || c.executionSteps || [],
    skillChain: inner.skillChain || c.skillChain || [],
  };
}

// A docs answer says which environment gave it (MGAP-A15; api.js servedBy).
// FIRST, so it is the first thing read, before any section a long answer is
// cut at. The Builder's docs are JSON objects; anything else passes unchanged.
function withServedBy(doc, sid) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return doc;
  return { served_by: servedBy(sid), ...doc };
}

// ─── Composite: Build & Run — the pipeline ────────────────────────────
// Validates → Deploys → Health-checks → Optionally tests
// One call replaces: validate_solution + deploy_solution + get_solution(health)
//
// ateam_build_and_run runs it: for as long as it takes on stdio, and within
// HOSTED_CALL_BUDGET_MS over the hosted transport (buildRunWithinBudget).
async function runBuildAndRun({ solution_id: solIdArg, solution: solutionArg, skills, connectors, mcp_store, github, test_message, test_skill_id }, sid) {
  let solution = solutionArg;
  // If only solution_id passed (no full solution), we'll pull from GitHub
  const solutionId = solution?.id || solIdArg;
  if (!solutionId) {
    return { ok: false, phase: "pre_check", error: "Provide either solution (object) or solution_id (string)." };
  }
  // An id no path can carry is refused before anything is sent: deployed, it
  // would be a solution no later tool call could address.
  pathSeg(solutionId);
  const phases = [];

  // Guard: reject large mcp_store — agent should use github_patch instead
  if (mcp_store) {
    const totalSize = Object.values(mcp_store).reduce((sum, files) => {
      return sum + (Array.isArray(files) ? files.reduce((s, f) => s + (f.content?.length || 0), 0) : 0);
    }, 0);
    if (totalSize > 200_000) {
      return {
        ok: false,
        phase: "pre_check",
        error: `mcp_store is too large (${Math.round(totalSize / 1024)}KB). Max ~200KB inline.`,
        message: "Connector code is too large to pass inline. Write files individually to GitHub, then deploy from there.",
        _fix: [
          "1. Write each file: ateam_github_patch(solution_id, path: 'connectors/<id>/server.js', content: '...')",
          "2. Repeat for package.json, UI assets, etc.",
          "3. Deploy: ateam_build_and_run(solution, skills) — will auto-pull from GitHub",
        ],
      };
    }
  }

  // Phase 0: Auto-detect GitHub repo — if no mcp_store passed and repo exists, pull bundle from GitHub
  let effectiveMcpStore = mcp_store;
  let effectiveSkills = skills;
  // WHAT THE CALLER WROTE, captured before Phase 0 fills the gaps from the repo.
  // `connectors` is reassigned below when it is synthesized from mcp_store keys,
  // so it has to be read here.
  const inline = {
    solution: Boolean(solutionArg),
    skills: Array.isArray(skills) && skills.length > 0,
    connectors: Array.isArray(connectors) && connectors.length > 0,
  };
  // Set only when Phase 0 actually read the bundle. `github` alone does not say
  // that: a caller may pass github:true together with mcp_store, and then
  // nothing is pulled.
  let pulledMcpStore = false;
  if (!mcp_store) {
    try {
      const ghStatus = await get(apiPath`/deploy/solutions/${solutionId}/github/status`, sid);
      // repo_url only says a REPO EXISTS. It has never said the repo carries
      // this solution's connector source, and treating the two as the same
      // claim is how a connector with nothing in the repo used to slip
      // through Phase 0 and then vanish from connectors[] below. The real
      // per-connector answer comes from pull-bundle, and it is acted on
      // there — this stays a cheap "is GitHub worth asking at all?" gate.
      if (ghStatus?.repo_url) {
        github = true;
      }
    } catch { /* no repo — first deploy, mcp_store expected */ }
  }
  if (github && !mcp_store) {
    try {
      // NAME THE BRANCH. build_and_run deploys the SHIPPED state — that is
      // the whole dev → promote → main design, and why the Builder refuses
      // this deploy with MAIN_BEHIND_DEV until you promote. This call used
      // to send {} and lean on the Builder's default, which was `main` until
      // Builder 873558e changed it to `dev`: from then on this deployed
      // UNSHIPPED dev while every doc, the guard and deployed_from_branch
      // all still said main. The Builder now refuses a branch-less read
      // (BRANCH_REQUIRED), so the intent has to be stated here, from the
      // one owner of the branch story.
      const pullResult = await post(
        apiPath`/deploy/solutions/${solutionId}/github/pull-bundle`,
        { branch: BRANCH_WORKFLOW.deploy_branch },
        sid,
        // A read over POST (it bundles the repo, writes nothing): declared
        // idempotent, so one lost answer does not fail the whole deploy.
        { timeoutMs: 60_000, idempotent: true },
      );
      if (!pullResult.ok) return pullRefused(pullResult, pullResult.error || "Failed to pull bundle from GitHub");
      // A LISTED FILE THE BUILDER COULD NOT READ OR PARSE IS NOT ABSENT
      // (Builder #144, B144R-6). The bundle comes back without it, and saying
      // so in a note while deploying the rest shipped the solution without a
      // skill, without its solution.json, or with a connector short of a file.
      const notRead = bundleNotRead(pullResult);
      if (notRead) return notRead;
      effectiveMcpStore = pullResult.mcp_store || {};
      pulledMcpStore = true;
      // Use solution from GitHub if not passed inline
      if (!solution && pullResult.solution) {
        solution = pullResult.solution;
      }
      // Use skills from GitHub if not passed inline
      if (!effectiveSkills?.length && pullResult.skills?.length) {
        effectiveSkills = pullResult.skills;
      }
      // Synthesize connectors[] metadata from mcp_store keys if not passed inline.
      // The pull-bundle endpoint returns mcp_store (files) and solution.platform_connectors
      // (declarations) but not a top-level connectors[] array. The validator/deploy
      // pipeline expects one, so build it from the mcp_store we just pulled.
      //
      // ROBUSTNESS: mcp_store is normally keyed by CONNECTOR ID, but a bad/older
      // pull-bundle can key it by the full `connectors/<id>/<file>` path — in
      // which case the old `map(id => ...)` registered ONE connector PER FILE with
      // the path as its id (observed 2026-08-15: db.connectors got
      // connectors/expense-tracker-mcp/server.js etc. as rows). Collapse either
      // shape to the connector id and dedupe, so a mis-keyed mcp_store can never
      // manufacture file-path connectors. (Core also rejects "/"-bearing ids at
      // its boundary as defense-in-depth.)
      //
      // B5 — A CONNECTOR WITH NO SOURCE IN THE REPO MUST NOT VANISH.
      // Synthesizing purely from mcp_store keys means a declared connector the
      // repo does not carry is simply ABSENT from connectors[], so nothing
      // validates it, nothing reports it, and the deploy proceeds as though it
      // were never part of the solution. Phase 0 made this likelier by
      // treating "the repo exists" (repo_url) as "the repo has the source" —
      // two different claims.
      //
      // pull-bundle now answers per connector, so union those ids in. A
      // connector listed here still deploys when its authored source lives in
      // the Builder's store; what it can no longer do is disappear.
      const missingSource = Array.isArray(pullResult.connectors_missing_source)
        ? pullResult.connectors_missing_source : [];
      if (!connectors?.length && (Object.keys(effectiveMcpStore).length > 0 || missingSource.length > 0)) {
        const connIds = [...new Set([
          ...Object.keys(effectiveMcpStore).map((k) => {
            const m = String(k).match(/^connectors\/([^/]+)\//);
            return m ? m[1] : k;
          }),
          ...missingSource.map((c) => (typeof c === "string" ? c : c?.id)).filter(Boolean),
        ])];
        connectors = connIds.map((id) => ({
          id,
          name: id,
          transport: "stdio",
        }));
      }
      phases.push({
        phase: "github_pull",
        status: "done",
        skills_found: pullResult.skills_found || 0,
        connectors_found: pullResult.connectors_found || 0,
        files_loaded: pullResult.files_loaded || 0,
        connectors_synthesized: connectors?.length || 0,
        // Named, not swallowed. The repo existing said nothing about these.
        ...(missingSource.length > 0 && {
          connectors_missing_source: missingSource,
          note: "These connectors are declared but the repo carries no source for them. They are still deployed if the Builder holds their authored source; if it does not, validation refuses and ateam_get_connector_source / ateam_recover_connector_source tell you which.",
        }),
      });
    } catch (err) {
      return pullRefused(jsonVerdictOf(err.body) || {}, err.message);
    }
  }

  // Guard: solution required (either inline or from GitHub)
  if (!solution) {
    // Phase 0 READ an existing repo's deploy branch and it holds no solution.
    if (pulledMcpStore) return deployBranchHoldsNo("solution");
    return {
      ok: false,
      phase: "pre_check",
      error: "No solution provided and none found in GitHub repo.",
      message: "Pass solution inline or ensure solution.json exists in the GitHub repo.",
    };
  }

  // Guard: skills required (either inline or from GitHub)
  if (!effectiveSkills?.length) {
    // Same as the solution guard: Phase 0 read an existing repo's deploy branch.
    if (pulledMcpStore) return deployBranchHoldsNo("skills");
    return {
      ok: false,
      phase: "pre_check",
      error: "No skills provided and none found in GitHub repo.",
      message: "Pass skills inline or ensure they exist in the GitHub repo (skills/{id}/skill.json).",
    };
  }

  // Phase 1: Validate
  let validation;
  try {
    validation = await post("/validate/solution", { solution, skills: effectiveSkills, connectors, mcp_store: effectiveMcpStore }, sid, { timeoutMs: 120_000, idempotent: true });
    phases.push({ phase: "validate", status: "done" });
  } catch (err) {
    // A DEAD SOCKET IS NOT A FORMAT ERROR. "fetch failed" / ECONNREFUSED /
    // ETIMEDOUT / socket hang up mean the deploy service was unreachable —
    // telling the agent to go re-read the solution spec sends it to fix
    // something that is not broken, at the cost of several turns. Observed
    // 2026-08-21 (job_aehopl8z): the backend had been restarted mid-run and
    // the agent burned turns on get_spec and spec_search chasing a phantom
    // format problem. The two diagnoses are opposites; pick by the cause.
    //
    // BY THE CAUSE, NOT THE WORDS. f0bb2c2 matched /…|network|aborted/ over
    // err.message, which carries the response body (formatError), so a 400
    // whose body said "network" was told to RETRY an unchanged definition,
    // and a gateway 524 was sent to re-read the spec. Now: isTimeoutError
    // (a timeout or a gateway, from the status and request()'s own mark);
    // neverSent (request()'s mark on a refused connection or an unresolvable
    // host, which it rethrows as a fresh Error with no cause); or the socket's
    // errno in err.cause for a connection that died before any answer.
    const transport = isTimeoutError(err) || err?.neverSent === true || typeof err?.cause?.code === "string";
    return {
      ok: false,
      phase: "validation",
      error: err.message,
      retryable: transport,
      message: transport
        ? "The deploy service was UNREACHABLE — this is a transport failure, not a problem with your solution. Do NOT re-read the spec or change your definition. Wait a few seconds and RETRY the same call; if it keeps failing, the backend is down or was restarted mid-run."
        : "Validation call failed. Check your solution/skill format against the spec (ateam_get_spec topic='solution').",
    };
  }

  // Check for blocking errors
  const errors = validation.errors || validation.validation?.errors || [];
  if (errors.length > 0) {
    return {
      ok: false,
      phase: "validation",
      errors,
      warnings: validation.warnings || validation.validation?.warnings || [],
      message: `Validation found ${errors.length} error(s). Fix them and try again.`,
    };
  }

  // Phase 2: Deploy
  //
  // pulled_from_github NAMES THE PARTS THAT ARE THE REPO'S CONTENT, and it
  // must be exact. The Builder (#50) saves those parts into its store as a
  // MIRROR: FS-only, never written back; it records a sync baseline instead
  // (which side changed is decided from that, not from updated_at). An
  // inline solution or skills it writes to `dev`, where an inline edit
  // belongs. (Inline connector CODE is a different, older story: on a repo
  // that exists, no deploy writes it to GitHub at all. Use ateam_github_write
  // for code.) And its MAIN_BEHIND_DEV guard checks only the files the named
  // parts were read from.
  //
  //   solution   pulled, and the caller passed no connectors[] of its own:
  //              the Builder import adds new connector ids to
  //              solution.platform_connectors, so an inline connectors[] is
  //              an edit to solution.json.
  //   skills     pulled.
  //   mcp_store  pulled (Phase 0 pulls exactly when no mcp_store was passed).
  //
  // A LIST, NOT A FLAG. A flag for "all of it" (github:true, the previous cut
  // of this change) left build_and_run(solution) with two wrong answers:
  // mirror everything and the inline solution never reaches GitHub, or mirror
  // nothing and the pulled skills are written back to dev, so the next
  // identical call is refused because of its own write. It is also a name
  // the Builders running today do not know. github:true is one they do, and
  // their async hop turns it into a completeness check that refuses any
  // connector whose source lives only in the Builder store.
  //
  // Sent on EVERY deploy, [] when nothing was pulled, so a Builder can tell
  // "pulled nothing" from "a client that does not say".
  //
  // skip_github_push is NOT that statement. It follows the `github` argument,
  // which is also set together with an inline mcp_store, when nothing is
  // pulled. It is sent exactly as before (99bba7e), for the Builders that
  // read it.
  const pulledFromGithub = pulledMcpStore
    ? [
        ...(!inline.solution && !inline.connectors ? ["solution"] : []),
        ...(!inline.skills ? ["skills"] : []),
        "mcp_store",
      ]
    : [];
  const deployBody = {
    solution, skills: effectiveSkills, connectors, mcp_store: effectiveMcpStore,
    ...(github && { skip_github_push: true }),
    pulled_from_github: pulledFromGithub,
  };
  let deploy;
  try {
    // Try sync first (fast for small solutions)
    deploy = await post("/deploy/solution", deployBody, sid, { timeoutMs: 120_000 });
    phases.push({ phase: "deploy", status: deploy.ok ? "done" : "failed" });
  } catch (err) {
    // A VERDICT IS NOT A TIMEOUT. isTimeoutError counts every 502, so a 502
    // whose body named what failed was re-POSTed in async mode. Only a
    // failure with no verdict may move to the async door.
    if (!isTimeoutError(err) || jsonVerdictOf(err.body)) {
      return { ok: false, phase: "deployment", phases, error: err.message, validation_warnings: validation.warnings || [] };
    }

    // Timeout → retry with async mode + polling
    phases.push({ phase: "deploy", status: "async_retry" });
    try {
      // The SAME body. The async door must not learn less about where the
      // payload came from than the sync one did.
      const asyncResult = await post("/deploy/solution", { ...deployBody, async: true }, sid, { timeoutMs: 15_000 });

      if (asyncResult.job_id) {
        // Poll for completion (up to 10 min)
        const jobId = asyncResult.job_id;
        // Built once, before the loop: see pollDeployJob.
        const jobPath = apiPath`/deploy/jobs/${jobId}`;
        const maxWait = 600_000;
        const pollInterval = 5_000;
        const start = Date.now();
        while (Date.now() - start < maxWait) {
          await new Promise(r => setTimeout(r, pollInterval));
          try {
            const job = await get(jobPath, sid);
            if (job.status === 'done' || job.status === 'failed') {
              deploy = job;
              phases.push({ phase: "deploy", status: job.status });
              break;
            }
          } catch (err) {
            // #4 Silent-catch audit: poll errors are usually transient
            // (network blip, restart). Logging at debug level so they
            // don't drown the console but ARE visible if you bump the
            // log level after a stuck deploy.
            if (process.env.MCP_DEBUG_POLLS) console.warn(`[ateam_build_and_run] poll ${jobId} error (will retry): ${err.message}`);
          }
        }
        if (!deploy) {
          return { ok: false, phase: "deployment", phases, error: "Async deploy timed out after 10 minutes", validation_warnings: validation.warnings || [],
            hint: "Deploy is too large even for async mode. Use incremental tools instead: ateam_patch(solution_id, target:'skill', skill_id, updates) for skill changes, ateam_upload_connector(solution_id, connector_id, github:true) for connector code changes." };
        }
      }
    } catch (asyncErr) {
      return { ok: false, phase: "deployment", phases, error: `Sync timed out, async fallback failed: ${asyncErr.message}`, validation_warnings: validation.warnings || [],
        hint: "Deploy timed out. Use incremental tools: ateam_patch for skill changes, ateam_upload_connector for connector changes. These deploy one component at a time and never timeout." };
    }
  }

  if (!deploy.ok) {
    return {
      ok: false,
      phase: "deployment",
      phases,
      deploy,
      validation_warnings: validation.warnings || [],
      message: "Deployment returned an error. See deploy details above.",
    };
  }

  // Phase 2.5: Restart connectors that have source code (upload triggers stop+start)
  //
  // A SECOND UPLOAD, AND STILL THE ONLY ONE FOR SOME CHANGES. The deploy above
  // has already written every connector in mcp_store to the Builder's slot and
  // uploaded it (the deploy door's preSyncConnectors), so on a first deploy this
  // sends Core the same code again (~34s of K15's 133s). But pre-sync skips a
  // connector that is up when its hash matches, and that hash covers only the
  // launch file, package.json and rn-bundle/* (Builder exportDeploy.js
  // _computeConnectorSourceHash, c88b12e). A change anywhere else in a running
  // connector (rn-src/*.tsx, the only RN source the spec teaches, or a module
  // server.js imports) is skipped there and Core keeps the old code. The upload
  // route this calls hashes every file, so this phase is what delivers that
  // change. Delete it when pre-sync hashes every file it uploads.
  //
  // A runtime:"device" connector is SKIPPED. It has authored source — the RN
  // bundle (rn-src/, package.json, the esbuild config) — so it looks like an
  // ordinary connector to a loop that only asks "does it have files?". But
  // there is no server process to restart: the bundle ships to the phone.
  // Uploading it here 409s on the merge and then health marked the connector
  // "error", failing a deploy whose connector was working as designed.
  //
  // Classified from the DECLARED connectors[], which the caller authored —
  // not by asking Core. Same ownership rule the Builder now follows.
  const deviceConnectorIds = new Set(
    (connectors || [])
      .filter((c) => c && typeof c === "object" && c.runtime === "device" && c.id)
      .map((c) => c.id),
  );
  if (effectiveMcpStore && Object.keys(effectiveMcpStore).length > 0) {
    const connectorResults = [];
    for (const [connId, files] of Object.entries(effectiveMcpStore)) {
      if (!Array.isArray(files) || files.length === 0) continue;
      if (deviceConnectorIds.has(connId)) {
        connectorResults.push({ id: connId, ok: true, tools: 0, skipped: "device_runtime" });
        continue;
      }
      try {
        // THE MERGE BASE IS THE BRANCH THESE FILES CAME FROM. The upload
        // merges `files` over the connector's GitHub state at `ref` (default
        // `dev`), laid over the files Core already runs. With the default,
        // files that exist only on dev rode into a run that says it deploys
        // main. ref:main keeps those out. It does NOT remove a file that is
        // already running in Core (the deployed copy is the floor of the
        // merge), e.g. one a dev iteration uploaded earlier. An inline
        // mcp_store keeps the default: those files are the caller's
        // iteration, and dev is where iteration lives.
        const uploadResult = await post(
          apiPath`/deploy/solutions/${solutionId}/connectors/${connId}/upload`,
          { files, ...(pulledMcpStore && { ref: BRANCH_WORKFLOW.deploy_branch }) },
          sid,
          { timeoutMs: 120_000 },
        );
        // THE UPLOAD'S OWN VERDICT. This recorded ok:true for every answer, so
        // an upload whose stages said PARTIAL or FAILED read as a clean restart
        // — among them stages.skills: a skill that imports this connector did
        // not get its new tool list, and Core still refuses the new tool to it
        // (RUN5-3). Its stage and its report ride along.
        const skillsStage = uploadResult?.stages?.skills;
        connectorResults.push({
          id: connId,
          ok: uploadResult?.ok !== false,
          tools: uploadResult?.tools || 0,
          ...(skillsStage && { skills: skillsStage }),
          ...(skillsStage && skillsStage !== "NOT_RUN" && uploadResult.skill_tools && { skill_tools: uploadResult.skill_tools }),
          ...(uploadResult?.ok === false && uploadResult.failed_steps && { failed_steps: uploadResult.failed_steps }),
        });
      } catch (err) {
        connectorResults.push({ id: connId, ok: false, error: err.message });
      }
    }
    phases.push({
      phase: "connector_restart",
      status: connectorResults.every(r => r.ok) ? "done" : "partial",
      connectors: connectorResults,
    });
  }

  // Phase 3: Health check (with brief wait for propagation)
  let health;
  try {
    await sleep(2000);
    health = await get(apiPath`/deploy/solutions/${solutionId}/health`, sid);
    phases.push({ phase: "health", status: "done" });
  } catch (err) {
    health = { error: err.message };
    phases.push({ phase: "health", status: "error", error: err.message });
  }

  // Phase 4: Warm test (optional)
  let test_result;
  if (test_message) {
    const skillId = test_skill_id || effectiveSkills?.[0]?.id;
    if (skillId) {
      try {
        test_result = await post(
          apiPath`/deploy/solutions/${solutionId}/skills/${skillId}/test`,
          { message: test_message },
          sid,
          { timeoutMs: 90_000 },
        );
        phases.push({ phase: "test", status: "done", skill_id: skillId });
      } catch (err) {
        test_result = { error: err.message };
        phases.push({ phase: "test", status: "error", error: err.message });
      }
    }
  }

  // Phase 5: GitHub push — only when NOT deployed from GitHub
  let github_result;
  if (github) {
    // "Deployed from GitHub" only when something WAS pulled: github:true with
    // an inline mcp_store pulls nothing and skips the push all the same.
    github_result = pulledMcpStore
      ? { skipped: true, reason: 'Deployed from GitHub — push-back skipped.' }
      : { skipped: true, reason: 'github:true was passed with inline code — nothing was pulled, and the push was skipped.' };
    phases.push({ phase: "github", status: "skipped", reason: pulledMcpStore ? "pulled_from_github" : "github_flag_inline_payload" });
  } else {
    try {
      github_result = await post(
        apiPath`/deploy/solutions/${solutionId}/github/push`,
        { push_to_github: true, message: `Deploy: ${solution.name || solutionId}` },
        sid,
        { timeoutMs: 60_000 },
      );
      phases.push({
        phase: "github",
        status: github_result.skipped ? "skipped" : "done",
        ...(github_result.repo_url && { repo_url: github_result.repo_url }),
      });
    } catch (err) {
      github_result = { error: err.message };
      phases.push({ phase: "github", status: "error", error: err.message });
    }
  }

  // Auto-seed / refresh the agent onboarding doc. Non-fatal — any failure
  // here is swallowed so it can't break a successful deploy. The tool is
  // idempotent: if the rendered doc is byte-identical to what's in the
  // repo, it returns unchanged:true and writes no commit.
  let agent_doc_result = null;
  try {
    agent_doc_result = await handlers.ateam_write_agent_doc({ solution_id: solutionId }, sid);
    phases.push({
      phase: "agent_doc",
      status: agent_doc_result?.unchanged ? "unchanged" : "done",
      created: agent_doc_result?.created || false,
      preserved_notes: agent_doc_result?.preserved_notes || false,
    });
  } catch (err) {
    agent_doc_result = { error: err.message };
    phases.push({ phase: "agent_doc", status: "skipped", reason: err.message });
  }

  // Phase 6: Widget health — if the solution declares UI plugins, verify each
  // one actually renders (Core discovered it + it has a render block). Catches
  // the silent "declared but non-rendering" widget at deploy time.
  let widget_health = null;
  try {
    widget_health = await verifyWidgetHealth(solutionId, sid);
    if (widget_health) {
      phases.push({ phase: "widget_health", status: widget_health.ok ? "done" : "warn", checked: widget_health.checked });
    }
  } catch { /* advisory — never fail a successful deploy on the health check */ }

  // Is there a branch story to tell at all? A pull or a landed push proves a
  // repo; otherwise ask the one probe that knows, rather than guessing from a
  // failed or skipped push — mirroring ateam_patch's local split.
  // Something was PULLED — not merely `github` set, which an inline mcp_store
  // can carry while nothing is read from the repo.
  const pulledFromRepo = pulledMcpStore;
  const githubConnected = (pulledFromRepo || github_result?.branch)
    ? true
    : await probeGithubConnected(solutionId, sid);
  const branches = describeDeployBranches({
    pulledFromRepo, githubResult: github_result, githubConnected, widgetHealth: widget_health,
  });

  return {
    ok: true,
    solution_id: solutionId,
    // WHAT WAS DEPLOYED vs WHERE THE PUSH LANDED are two different facts —
    // and for a tenant with no repo, neither exists. describeDeployBranches
    // decides all three.
    ...(branches.deployed_from_branch && { deployed_from_branch: branches.deployed_from_branch }),
    ...(branches.pushed_to_branch && { pushed_to_branch: branches.pushed_to_branch }),
    phases,
    deploy: {
      skills_deployed: deploy.import?.skills || [],
      connectors: deploy.import?.connectors || 0,
      ...(deploy.deploy_warnings?.length > 0 && { warnings: deploy.deploy_warnings }),
      ...(deploy.auto_expanded_skills?.length > 0 && { auto_expanded: deploy.auto_expanded_skills }),
    },
    health,
    ...(widget_health && { widget_health }),
    ...(test_result && { test_result }),
    // The GitHub outcome is reported WHATEVER it was. Filtering out the error
    // case left a failed push visible only inside `phases` — which nothing
    // reads — while _status went on claiming the push succeeded.
    ...(github_result && { github: github_result }),
    ...(agent_doc_result && !agent_doc_result.error && { agent_doc: agent_doc_result }),
    ...(validation.warnings?.length > 0 && { validation_warnings: validation.warnings }),
    // _status must describe WHAT HAPPENED — it once asserted "pushed to main"
    // unconditionally, keyed only on widget_health. See describeDeployBranches.
    _status: branches._status,
    _next: branches._next,
  };
}

/**
 * ateam_get_solution(view:"triggers"): is each schedule REGISTERED, and will it
 * fire? Read per skill from the Builder's probe of Core's trigger registry
 * (GET /deploy/solutions/:id/skills/:sk/triggers → Core cp.triggers_api). Until
 * 2026-10-01 nothing a builder could call showed the registry or the halt, so
 * "the schedule is set up" was never checked against anything.
 *
 * system_halted is one platform-wide switch, so the skills' answers are one
 * answer. It is Core's value when Core reports it; until then it is null with
 * system_halted_source "not reported by Core yet" — named, never a guessed false.
 */
const TRIGGERS_NOT_REPORTED = "not reported by Core yet";
const TRIGGERS_NOTHING_ASKED = "no skill to check — Core was not asked";

async function solutionTriggers(solution_id, skill_id, sid) {
  const skillIds = skill_id
    ? [skill_id]
    : ((await get(apiPath`/deploy/solutions/${solution_id}/skills`, sid))?.skills || []).map((s) => s.id).filter(Boolean);
  const perSkill = [];
  for (const id of skillIds) {
    perSkill.push({ skill_id: id, answer: await get(apiPath`/deploy/solutions/${solution_id}/skills/${id}/triggers`, sid) });
  }
  const reported = perSkill.map((p) => p.answer?.system_halted).find((v) => typeof v === "boolean");
  const first = (key) => perSkill.map((p) => p.answer?.[key]).find((v) => v != null) ?? null;
  // Each skill says whether ITS registered triggers carried next_run_at; one
  // skill with none must not speak for one whose rows did.
  const nextRunFromCore = perSkill.some((p) => p.answer?.next_run_at_source === "core");
  const unasked = perSkill.length === 0;
  return {
    ok: true,
    solution_id,
    system_halted: typeof reported === "boolean" ? reported : null,
    system_halted_source: typeof reported === "boolean" ? "core" : unasked ? TRIGGERS_NOTHING_ASKED : TRIGGERS_NOT_REPORTED,
    halt: first("halt"),
    next_run_at_source: nextRunFromCore ? "core" : unasked ? TRIGGERS_NOTHING_ASKED : TRIGGERS_NOT_REPORTED,
    done_rule: first("done_rule"),
    triggers: perSkill.flatMap((p) => (p.answer?.triggers || []).map((t) => ({ skill_id: p.skill_id, ...t }))),
    skills_checked: perSkill.map((p) => p.skill_id),
  };
}

// Exported for tests. handleToolCall below is the runtime entry point and stays
// the only one production code should use; reaching a handler directly lets a
// test EXECUTE it instead of asserting against this file's source text, which
// is the difference between proving behaviour and matching a string that a
// rename would quietly satisfy.
export const handlers = {
  // (_args, sid) — the SESSION ID IS LOAD-BEARING HERE.
  //
  // getBaseUrl(sessionId) resolves per-session first (api.js:326-339): a caller
  // that passed `url` to ateam_auth is talking to THAT api, and the session
  // holds it. Bootstrap called it with NO argument, so it skipped the
  // per-session and bearer branches every time and reported the process
  // DEFAULT — https://api.ateam-ai.com.
  //
  // The result was a tool that says PROD while the session is authenticated to
  // DEV, in the one field whose whole job is to tell you which environment you
  // are on. Observed live: a session working entirely against
  // dev-api.ateam-ai.com was told base_url: https://api.ateam-ai.com, and had
  // to learn from deploy errors which environment it was actually on. The
  // dangerous direction is the mirror image — believing you are on dev.
  ateam_bootstrap: async (_args, sid) => ({
    // FIRST: where this session is and how to move (signInSteps.js). A session
    // was on one workspace while the user needed another, and nothing said which.
    session: openingFor(sid),
    served_by: servedBy(sid),
    runtime: {
      ateam_mcp_version: MCP_VERSION,
      base_url: shownBase(getBaseUrl(sid)),
      // "as set by ateam_auth's `url`" (af5e366) was written 22 minutes before
      // bff5934 made the KEY pick the environment (MGAP-A31).
      _note: "The version of the ateam-mcp process actually serving this call, and the API THIS SESSION talks to: the environment its sign-in's key names (adas_<env>_…), a `url` given to ateam_auth for a host that is neither environment, or this server's default before any sign-in. " +
        "`served_by` (top of this result, and on every ateam_get_spec / ateam_get_examples / ateam_get_workflows / ateam_spec_search result) names that environment: prod or dev, or the base itself for any other host. It says which API ANSWERED; the environment of this session's sign-in is in `session`. " +
        "If a fix looks missing, check this FIRST — a local MCP process keeps running the code it loaded at session start, so a pushed/published fix is not live until the process restarts.",
    },
    platform_positioning: {
      name: "A-Team",
      category: "AI Team Solution Platform",
      summary: "A-Team is a platform for building governed AI Teams as complete operational solutions.",
    },
    design_advisor: {
      _first_call: "ateam_get_spec(topic:'capabilities') — the capability index, organised by what a solution DOES ('can I see? can I talk with them out loud? do I know where they are and that they are moving? can I act while they sleep? can I remember each user? can I show them something?'). Read it BEFORE the advisor: it needs no auth, no tenant and no LLM, so it cannot be down, and it is the only entry point you can find by thinking about YOUR problem rather than our vocabulary. Every other spec topic is named after one of our build artifacts.",
      _important: "BEFORE and WHILE you design any skill/solution you MUST consult ateam_design_advisor. You do NOT know which platform capabilities exist or when to use them — the advisor does. Describe your goal to it and it returns pointers to the right capabilities (per-actor storage, widgets, triggers, sub-agents, mobile data, run-scripts, multi-skill handoff, GitHub, …) with the /spec topic to read next and the tool to wire each. It's advisory — you decide and own the design — but skipping it means you'll miss capabilities the platform already provides.",
      how: "ateam_design_advisor({ goal: '<what you are building, in your words>', design_state: {} }). Re-call it as the design evolves (pass the current design_state) to get 'what's still missing' hints. Then ateam_get_spec(topic) for any capability it points you to. For anything deeper — details, examples, or topics outside the capability list — ateam_spec_search({ query: '<how do I…>' }) does a semantic search over the FULL spec docs.",
      // A MANDATE WITH NO FALLBACK IS A SINGLE POINT OF FAILURE, and it failed:
      // on 2026-09-04 the advisor errored three times for one design and the
      // agent, told to consult it and given nowhere else to go, fell back to
      // reading whichever spec topic happened to mention the thing it wanted —
      // and concluded a capability was absent that had shipped. Name the other
      // doors here, at the point where the obligation is stated.
      //
      // "neither fails the way the advisor can" (2268b3f) was false for a session
      // that had not signed in: ateam_spec_search went through the key-gated
      // connector-call route (b90f423) and answered 401. It now calls the
      // keyless POST /spec/search (MGAP-A3), and this names the mechanism
      // instead of promising the outcome. test/spec-search-keyless.test.mjs
      // drives all three doors with no credentials.
      if_the_advisor_does_not_answer:
        "It is not the only door and you are NOT stuck. Three doors need NO sign-in, no tenant and no LLM: " +
        "ateam_get_spec(topic:'capabilities') is the question-shaped capability index — every 'can I …?' with a " +
        "one-word answer and where to read next; ateam_get_spec(topic:'device-capabilities') is the GENERATED " +
        "capability matrix (what the phone can do, per API, with status); and ateam_spec_search({query}) searches the " +
        "full spec corpus. The advisor is different: it runs your tenant's LLM, so it can refuse a session that has not " +
        "signed in, and it can time out. If the advisor answers " +
        "with `truncated: true`, what you got is CORRECT but INCOMPLETE: use it, and treat a capability's absence as " +
        "UNKNOWN rather than 'no' — re-ask with a narrower goal, or check the three doors above. " +
        // ONE home for what a failed call means for the design (review M39-4):
        // the tool's own description, which every agent sees.
        "What a failed call means for your design, storage first: the ateam_design_advisor description.",
    },
    what_is_a_team: {
      definition: "A Team is a structured multi-role AI system composed of Skills, Connectors, Governance contracts, and Managed Runtime deployment.",
      core_components: {
        skill: "Operational AI role — intents, tools, policies, workflows",
        solution: "Complete AI Team system — multiple skills + routing + grants + handoffs",
        connector: "External system integration via MCP tools",
        governance: "Permissions, grants, handoffs, auditability",
        deploy: "Activation into controlled runtime on A-Team Core",
      },
    },
    minimal_authoring: {
      _important: "READ THIS BEFORE WRITING. Most of what historic A-Team docs describe as required is now AUTO-GENERATED at deploy time. Writing the verbose form is wasted tokens — the platform overwrites your hand-written intents, tools, scenarios, etc. with its generated equivalents.",
      author_writes_per_skill: [
        "id, name, version, description",
        "role.persona (the agent's instructions in prose — this is the irreducible content)",
        "connectors[] (which MCP connector ids the skill uses)",
        "policy.guardrails (optional — always[]/never[] rules)",
        "handoff_when (optional — one-sentence routing trigger; LLM-synthesizes one if you omit it)",
      ],
      author_writes_per_solution: [
        "id, name, description, version",
        "linked_skills[] (skill ids the solution composes)",
        "routing_mode: \"auto\"  (opt into the auto-generated orchestrator)",
        "style: \"mobile\" | \"voice\" | etc (Phase 1 channel style cascade)",
      ],
      platform_generates_at_deploy: [
        "skill.tools[]   — Phase 2b: fetched from each connector's live tool inventory",
        "skill.intents   — Phase 3: LLM-synthesized from persona + tools",
        "skill.scenarios — auto from intents",
        "skill.engine    — Phase 4: resolved from preset name or default",
        "skill.security  — Phase 2: tool classifications auto-applied",
        "skill.access_policy — defaults",
        "solution orchestrator skill — Phase 6: generated when routing_mode:auto",
        "solution.handoffs[] — Phase 6: orchestrator → each worker",
        `solution.ui_plugins[] — recorded from each connector's ui.listPlugins + ui.getPlugin by ateam_build_and_run's deploy on every run, and by ateam_redeploy of the whole solution only while the list is empty; it is the list a connector not started yet is shown from. ${PLUGIN_LISTED_LIVE}`,
        "Style block prepended to every skill persona — Phase 1",
      ],
      replace_rule: "REPLACE wins per-field. Any field you write explicitly overrides the platform-generated equivalent. Delete it to opt back into automation.",
      // Through the TOOL: the reader is an MCP client and cannot GET anything
      // (2a07c08 wrote "GET /spec/skill"). search:"auto_expand" returns just that
      // block, typical_minimal_skill included, from each page.
      read_first: "ateam_get_spec(topic:\"skill\", search:\"auto_expand\") → the auto_expand block has the full list and a typical_minimal_skill example. ateam_get_spec(topic:\"solution\", search:\"auto_expand\") → same.",
    },
    example_solutions: [
      { name: "Fleet Command Center", description: "Live vehicle tracking, route optimization, safety monitoring, governed execution" },
      { name: "Customer Support Operations Team", description: "Multi-role support system with escalation, refund controls, CRM integration" },
      { name: "Enterprise Compliance Platform", description: "Approval flows, audit logs, policy enforcement" },
    ],
    developer_loop: {
      _note: "This is the recommended build loop. 6 steps from definition to running skill with GitHub version control.",
      steps: [
        { step: 1, action: "Learn", description: "Get the spec and study examples", tools: ["ateam_get_spec", "ateam_get_examples"] },
        { step: 2, action: "Build & Run", description: "Define your solution + skills + connector code, then validate, deploy, and health-check in one call. Include mcp_store with connector source code on the first deploy.", tools: ["ateam_build_and_run"] },
        { step: 3, action: "Version", description: `Writes land on \`${BRANCH_WORKFLOW.write_branch}\`, NOT ${BRANCH_WORKFLOW.deploy_branch}. ${BRANCH_WORKFLOW.deploy_side} The repo (one per TENANT) is the source of truth for connector code.`, tools: ["ateam_github_status", "ateam_github_log", BRANCH_WORKFLOW.promote_tool] },
        // ITERATE IS NOT SHIP. This step used to carry the ship loop (one_line)
        // and list promote + build_and_run, so the loop an agent follows most
        // often told it to ship every change.
        { step: 4, action: "Iterate", description: `Change it on \`${BRANCH_WORKFLOW.write_branch}\` and deploy it from \`${BRANCH_WORKFLOW.write_branch}\` to test it, with no promote. Connector code: ateam_github_patch, ONE FILE AT A TIME, then ateam_upload_connector(solution_id, connector_id, github:true). Skill or solution definitions: ateam_patch, which writes \`${BRANCH_WORKFLOW.write_branch}\` and redeploys in the same call. ${BRANCH_WORKFLOW.iterate_note} NEVER re-pass all connector code inline after first deploy.`, tools: ["ateam_github_patch", "ateam_upload_connector", "ateam_patch", "ateam_redeploy"] },
        { step: 5, action: "Test & Debug", description: `Test BEFORE you ship, against what step 4 deployed from \`${BRANCH_WORKFLOW.write_branch}\`. ` + "Chat with the solution via ateam_conversation (auto-routes; the next turn: conversation_flow.steps[3]; who it runs as: conversation_flow.who_it_runs_as). It is ASYNC — see conversation_flow below: kick off → get chain_id → poll ateam_chain_status until chain_done → read the reply. Use ateam_test_pipeline for intent debugging, ateam_test_voice for voice. For a UI plugin, ateam_verify_surface PROVES it renders with data (required evidence for a user-visible fix). Diagnose with logs and metrics. ⚠️ A tool answering ok:true with EMPTY/zero data is not proof it worked — that is the signature of a connector swallowing its own error. Read ateam_connector_logs before you believe a green result.", tools: ["ateam_conversation", "ateam_chain_status", "ateam_get_chain", "ateam_test_pipeline", "ateam_test_skill", "ateam_test_voice", "ateam_verify_surface", "ateam_connector_logs", "ateam_get_execution_logs", "ateam_get_metrics"] },
        { step: 6, action: "Ship", description: `${BRANCH_WORKFLOW.promote_is_a_ship_not_a_checkpoint} Then ateam_build_and_run(solution_id) deploys \`${BRANCH_WORKFLOW.deploy_branch}\`. ${BRANCH_WORKFLOW.the_silent_mistake} ${BRANCH_WORKFLOW.rollback}`, tools: [BRANCH_WORKFLOW.promote_tool, "ateam_build_and_run", "ateam_github_list_versions", "ateam_github_rollback"] },
      ],
    },
    conversation_flow: {
      _important: "ateam_conversation is ASYNC and CHAIN-based. A conversation runs across handoffs + askAnySkill subcalls for possibly minutes — a synchronous wait would hit the 100s edge timeout (524). ALWAYS poll by CHAIN, NEVER by a single job (a job can terminate while the chain is still active).",
      steps: [
        "1. KICK OFF — ateam_conversation(solution_id, message[, actor_id]) → returns { chain_id, actor_id, ran_as } immediately (what actor_id and ran_as are: who_it_runs_as below). The reply is NOT here.",
        "2. POLL (chip-quick, cheap) — loop ateam_chain_status(chain_id) every ~2s. It returns the whole-chain aggregate { chain_status, chain_done, pending_question, result }. Stop when chain_done === true. " + WAITING_ON_THE_USER + " (step 4)",
        "3. READ THE REPLY — when chain_done, use result. For full per-job detail / the routed worker's output, call ateam_get_chain(chain_id) ONCE (it returns the entire chain tree: every job + every tool step). Do NOT poll get_chain in a loop — it's heavy.",
        "4. NEXT TURN — a reply or the next message: ateam_conversation(solution_id, message). " + CONVERSATION_CONTINUES + " " + REPLY_WINDOW + " Repeat from step 2.",
      ],
      who_it_runs_as: TEST_RUNS_AS_AT,
      example: {
        kickoff: 'ateam_conversation(solution_id: "ada", message: "log 3 glasses of water") → { chain_id: "job_ab12", actor_id: "usr_you", ran_as: "usr_you" }',
        poll: 'ateam_chain_status(chain_id: "job_ab12") → { chain_status: "running", chain_done: false } … repeat … → { chain_status: "completed", chain_done: true, result: "…" }',
        full_tree: 'ateam_get_chain(chain_id: "job_ab12") → { chainJobs: [ {jobId, skill, status, relation, depth} … ], executionSteps: [ … ] }',
        continue: 'ateam_conversation(solution_id: "ada", message: "yes")  (inside the window in steps[3])',
      },
    },
    // RENDERED FROM BRANCH_WORKFLOW — do not restate the model here.
    branching: {
      _important: `TWO BRANCHES, and the step between them is EXPLICIT: ${BRANCH_WORKFLOW.one_line}.`,
      dev: BRANCH_WORKFLOW.write_side,
      main: BRANCH_WORKFLOW.deploy_side,
      the_loop: BRANCH_WORKFLOW.loop,
      the_mistake_this_causes: BRANCH_WORKFLOW.the_silent_mistake,
      promote_is_a_ship: BRANCH_WORKFLOW.promote_is_a_ship_not_a_checkpoint,
      rollback: BRANCH_WORKFLOW.rollback,
      no_git_at_all: BRANCH_WORKFLOW.no_git_at_all,
    },
    first_questions: [
      { id: "goal", question: "What do you want your Team to accomplish?", type: "text" },
      { id: "domain", question: "Which domain fits best?", type: "enum", options: ["ecommerce", "logistics", "enterprise_ops", "other"] },
      { id: "systems", question: "Which systems should the Team connect to?", type: "multi_select", options: ["slack", "email", "zendesk", "shopify", "jira", "postgres", "custom_api", "none"] },
      { id: "security", question: "What environment constraints?", type: "enum", options: ["sandbox", "controlled", "regulated"] },
    ],
    github_tools: {
      _note: `Version control for solutions. ${BRANCH_WORKFLOW.one_line}. See \`branching\` above — it is the same definition.`,
      tools: ["ateam_github_push", "ateam_github_pull", "ateam_github_status", "ateam_github_read", "ateam_github_patch", "ateam_github_log", "ateam_github_promote", "ateam_github_rollback", "ateam_github_list_versions"],
      repo_structure: {
        "solution.json": "Full solution definition",
        "skills/{skill-id}/skill.json": "Individual skill definitions",
        "connectors/{connector-id}/server.js": "Connector MCP server code",
        "connectors/{connector-id}/package.json": "Connector dependencies",
      },
      // It said "main for every deploy" and "promote is the ONLY thing that
      // moves work", in the same response as the iterate loop that deploys dev
      // with no promote. Rendered from the owner now, like `branching`.
      branch: `${BRANCH_WORKFLOW.write_side} ${BRANCH_WORKFLOW.deploy_side}`,
      checkpoints: `${BRANCH_WORKFLOW.tag_format} tags are created automatically by each promote. ${BRANCH_WORKFLOW.promote_is_a_ship_not_a_checkpoint}`,
      iteration_workflow: {
        the_loop: BRANCH_WORKFLOW.loop,
        // ITERATE, THEN SHIP. code_changes was the ship loop under the label
        // "iteration" (github_patch → promote → build_and_run), the defect
        // developer_loop step 4 was fixed for.
        code_changes: `ateam_github_patch (ONE FILE PER CALL) → ateam_upload_connector(solution_id, connector_id, github: true) deploys it from \`${BRANCH_WORKFLOW.write_branch}\` to test. Ship when it is right: ${BRANCH_WORKFLOW.promote_tool}(solution_id) → ateam_build_and_run(solution_id).`,
        definition_changes: `ateam_patch writes \`${BRANCH_WORKFLOW.write_branch}\` and redeploys in the same call → test → ${BRANCH_WORKFLOW.promote_tool}(solution_id) when you want it in production`,
        first_deploy: "Must include mcp_store — this creates the GitHub repo",
        after_first_deploy: `NEVER pass mcp_store again. Write files via ateam_github_patch and test them with ateam_upload_connector; to ship, promote, then ateam_build_and_run(solution_id) auto-detects the repo and deploys \`${BRANCH_WORKFLOW.deploy_branch}\`.`,
        do_not_skip_promote: BRANCH_WORKFLOW.the_silent_mistake,
      },
      when_to_use_what: {
        ateam_github_write: `Write/create connector files on \`${BRANCH_WORKFLOW.write_branch}\` — ONE FILE PER CALL (server.js, package.json, UI assets). Use this after first deploy; ${BRANCH_WORKFLOW.promote_tool} ships it to \`${BRANCH_WORKFLOW.deploy_branch}\`.`,
        ateam_github_patch: "Edit existing files with search/replace (surgical edits to large files)",
        ateam_patch: `Edit skill definitions (intents, tools, policy) — auto-pushes to \`${BRANCH_WORKFLOW.write_branch}\`. Promote when you want it in production.`,
        "ateam_build_and_run()": `Deploy \`${BRANCH_WORKFLOW.deploy_branch}\` (after a promote) — auto-pulls from GitHub if the repo exists. No need to pass mcp_store or github flag.`,
        "ateam_build_and_run(mcp_store)": "FIRST DEPLOY ONLY — creates the GitHub repo. Never use mcp_store again after first deploy.",
        ateam_github_promote: `SHIP ${BRANCH_WORKFLOW.write_branch} → ${BRANCH_WORKFLOW.deploy_branch}. ${BRANCH_WORKFLOW.promote_is_a_ship_not_a_checkpoint} dry_run:true previews what would ship.`,
        ateam_github_rollback: BRANCH_WORKFLOW.rollback,
      },
    },
    advanced_tools: {
      _note: "These tools are available but hidden from the default tool list. Call them by name when you need fine-grained control.",
      debugging: ["ateam_get_execution_logs", "ateam_connector_logs", "ateam_get_metrics", "ateam_diff", "ateam_get_connector_source", "ateam_get_deployed_connector_source"],
      manual_lifecycle: ["ateam_validate_skill", "ateam_validate_solution", "ateam_deploy_solution", "ateam_deploy_skill", "ateam_deploy_connector", "ateam_update", "ateam_redeploy"],
      async_testing: ["ateam_test_status", "ateam_test_abort"],
      other: ["ateam_upload_connector_files", "ateam_solution_chat"],
    },
    static_pages: {
      features: "https://ateam-ai.com/#features",
      use_cases: "https://ateam-ai.com/#usecases",
      security: "https://ateam-ai.com/#security",
      engine: "https://ateam-ai.com/#engine",
    },
    // 727cae5 wrote this when the array held only platform services. The
    // solution schema has since let it carry the solution's OWN connectors
    // (source:"solution"), and plugin discovery walks it (MGAP-A13). "Merged
    // into every skill's tool catalog" was never the rule the Builder enforces:
    // a skill reaches a connector's tools through its own connectors[] (Builder
    // spec platform_connectors.used_by, validation used_by_without_skill_connector).
    platform_connectors: {
      _note: "Shared infrastructure MCPs available to all solutions. Reference by id in your solution's `platform_connectors` array, and add the id to the connectors[] of each skill that uses it: a skill reaches a connector's tools only through its OWN connectors[], which the deploy auto-imports (no bridge code). Do NOT bundle their source in mcp_store — they run as fixed Docker services on ADAS Core. " +
        "The same array can also carry a connector THIS SOLUTION owns, as { id, source: 'solution' }: its code lives in connectors/<id>/ of the solution repo and ships in ateam_build_and_run's connectors[]/mcp_store. The 'do not bundle' rule is for platform entries (source omitted or 'platform') only.",
      available: [
        {
          id: "memory-mcp",
          name: "Memory Engine",
          purpose: "Long-term memory + ephemeral context, per-tenant per-actor",
          tool_prefixes: ["memory.", "context."],
          typical_use: "Store user preferences/facts, recall rules, persist working context across conversations",
        },
        {
          id: "docs-index-mcp",
          name: "Docs Index",
          purpose: "Source-agnostic document corpus retrieval (chunking, embeddings, cosine search)",
          tool_prefixes: ["docs.corpus.", "docs.ingest.", "docs.search", "docs.file.", "docs.sync.", "docs.stats"],
          typical_use: "Index documents from any source (Dropbox, Gmail attachments, uploaded files), answer questions with retrieved chunks + citations. Fed by source connectors (e.g. dropbox-mcp) that call docs.ingest.file.",
        },
        {
          id: "browser-mcp",
          name: "Browser",
          purpose: "Headless Chromium automation (Playwright) + Auth WebView for OAuth/cookie capture",
          tool_prefixes: ["web.", "auth."],
          typical_use: "Navigate, read, click, type, screenshot any public web page; scrape data for enrichment. Auth WebView handles OAuth code extraction and cookie capture without exposing passwords to the LLM.",
          ui_plugins: ["browser-view", "auth-webview"],
        },
        {
          id: "gmail-mcp",
          name: "Gmail",
          purpose: "Gmail inbox operations via OAuth",
          tool_prefixes: ["gmail."],
          typical_use: "Fetch, search, send, label, cleanup, trash, archive, move, mark-read on the user's Gmail. Requires platform.auth.ensureConnected('gmail') first.",
        },
        {
          id: "whatsapp-mcp",
          name: "WhatsApp",
          purpose: "WhatsApp messaging via pairing-code auth",
          tool_prefixes: ["whatsapp."],
          typical_use: "Send and fetch WhatsApp messages, list chats, manage contacts. UI plugin provides the pairing-code connect flow.",
          ui_plugins: ["whatsapp-setup"],
        },
        {
          id: "telegram-mcp",
          name: "Telegram",
          purpose: "Telegram messaging via bot token",
          tool_prefixes: ["telegram."],
          typical_use: "Send messages to chats/groups, fetch updates, subscribe to inbound messages.",
        },
        {
          id: "mobile-device-mcp",
          name: "Mobile Device",
          purpose: "Native mobile capabilities — calendar, contacts, SMS, notifications, location",
          tool_prefixes: ["device.calendar.", "device.contacts.", "device.sms.", "device.notifications.", "device.location."],
          typical_use: "Read/write the device calendar, look up contacts, send SMS, read notifications, get current location. Backed by the mobile app's native bridge.",
        },
        {
          id: "travel-mcp",
          name: "Travel",
          purpose: "Unified travel search — flights, hotels, homes",
          tool_prefixes: ["travel."],
          typical_use: "Search flights (Google Flights), hotels (Booking.com), homes (Airbnb); plan a roundtrip combining flights+hotels; check user's existing bookings.",
        },
        {
          id: "nutrition-mcp",
          name: "Nutrition",
          purpose: "Meal logging, calorie/macro tracking, hydration",
          tool_prefixes: ["nutrition."],
          typical_use: "Log meals from text or photo, compute calories/macros, track water intake, daily/weekly summaries. Photo input via camera UI plugin.",
          ui_plugins: ["nutrition-dashboard", "nutrition-camera"],
        },
        {
          id: "cloud-docs",
          name: "Cloud Docs",
          purpose: "Cloud-storage ingest source (Dropbox/Drive) feeding docs-index",
          tool_prefixes: ["cloud."],
          typical_use: "Connect a Dropbox or Drive account, list folders, ingest a folder into a docs-index corpus, check sync status. Pairs with docs-index-mcp.",
        },
      ],
      how_to_use: {
        step_1: "Declare in solution: platform_connectors: [{ id: 'memory-mcp', required: true }]",
        step_2: "Add the id to the connectors[] of each skill that uses it — its tools are then auto-imported into THAT skill's catalog (no code to write, no bridge needed). A skill without it in connectors[] does not see them.",
        step_3: "Reference tools in skill.tools[] with source.type='mcp_bridge', connection_id matching the connector id",
      },
      do_not: [
        "Do NOT include platform connector source code in mcp_store — they're managed by the platform, not by your solution",
        "Do NOT try to deploy a duplicate platform connector as a solution connector — use the platform one directly",
        "Do NOT build stdio bridge connectors for platform services — the platform auto-merges their tools",
      ],
    },
    critical_connector_rules: {
      _note: "CRITICAL: Read this before writing ANY connector code. Violations are caught at deploy time and BLOCKED.",
      transport: "A-Team connectors use STDIO transport — child processes communicating via stdin/stdout JSON-RPC.",
      MUST_use: "StdioServerTransport from @modelcontextprotocol/sdk, or raw readline over process.stdin.",
      MUST_NOT_use: [
        "express(), fastify(), Koa, or any web framework",
        "http.createServer() or app.listen(PORT)",
        "HttpServerTransport, SSEServerTransport, or StreamableHTTPServerTransport",
      ],
      stdout_rule: "stdout = JSON-RPC channel. Use console.error() for logging, NOT console.log().",
      lifecycle_rule: "MCP servers must stay alive. Never call process.exit().",
    },
    assistant_behavior_contract: {
      first_run_requirements: [
        "Explain platform before endpoints",
        "Frame as AI Team solution platform",
        "Give at least one example solution",
        "Define Skill vs Solution vs Connector",
        "Ask user what solution they want to build",
      ],
      thinking_order: ["Platform", "Solution", "Skills", "Connectors", "Governance", "Build & Run"],
      tone: "Architectural, enterprise-grade, serious — BUT translate to plain language for non-technical (business) users; never assume the user is a developer.",
      // ── Conversation style — the user is usually a BUSINESS user, not a developer.
      // Follow this for every message you send them. (Backlog findings #1,#3,#4.)
      conversation_style: {
        audience: "Assume a business user with NO technical knowledge unless proven otherwise. Never say CLI, connector, persona, handoff, repo, JSON, deploy, source:local — translate to plain words: 'your tools', 'team member', 'their job', 'save it live'.",
        format: "Scannable, never a wall of text. Short lead line → bullets → done. Offer concrete choices (with an emoji) plus an open option. Ask ONE thing at a time.",
        grounding: "Ground every message in the user's REAL data — fetch the solution + skill names (ateam_show_solution_minimal) and open the FIRST message with them (e.g. 'You have ada — a personal assistant — 14 skills incl. Life Manager, Travel Agent…'). No generic filler welcomes.",
        build_time_vs_runtime: "Distinguish how a skill behaves for its END USERS (goes in the persona) from settings the BUILDER must choose now. Bake adaptive behavior into the persona; only ask the builder about genuine build-time choices (which tools, guardrails). Do NOT ask the builder runtime questions ('what is YOUR level?') for a reusable skill.",
        confirm: "Confirm in plain language before anything that changes the team, then show the result simply: '✅ Added Japanese Tutor to your team.'",
      },
      // ── Where the user's work lands — ALWAYS make this visible. (Backlog finding #6.)
      // "Derive environment from the authed api url" (dbd38f7) predates bff5934,
      // since which ateam_auth RETURNS the environment (MGAP-A31). Every
      // backticked field here must exist in the result it is read from
      // (test/sign-in-texts.test.mjs).
      environment_transparency: {
        on_connect: "State it explicitly: 'Connected to <workspace> on <environment> — changes you make deploy here.' READ both, do not derive them from a url: ateam_bootstrap's first field, `session`, names the workspace and the environment of this session's sign-in, and how to switch; ateam_auth returns `tenant` and `environment` (the same answer: 'unstated' for an older key that names none — then say you cannot confirm it). Show a human label (PROD / DEV), not a raw host. Never silently operate on a workspace or environment the user didn't expect.",
        after_deploy: "Confirm WHERE it landed with a link: '✅ Added <thing> to <solution> (tenant <t>, <env>) — view it: <app url>.'",
      },
      // ── Delivering a build. (Backlog findings #2,#7,#8.)
      build_flow: {
        follow_the_stages: "Drive builds through thinking_order + minimal_authoring (below) — do NOT improvise. A skill is mainly its role.persona + connectors; the platform generates intents/tools/scenarios.",
        ui_is_in_scope: "If the user asks for a UI / app screen / dashboard, the WIDGET is part of the build — deliver it, don't silently defer it. If you must stage it, say so up front and get agreement.",
        pick_build_path_by_tenant_state: "Choose the write path by the tenant's GitHub state: repo connected → normal github flow; NO repo (Core-only / freshly onboarded) → use source:'local' for definition edits and ateam_create_plugin/ateam_upload_connector for widgets (they fall back to deployed source). If a github write returns github_not_connected, guide the user to connect GitHub (mcp.ateam-ai.com/connect-github) — do not surface the raw error. SOLUTION_NOT_FOUND is not a GitHub problem: this workspace has no solution by that id, and the error says what to do (ateam_list_solutions, or the solution may be in another workspace).",
      },
      always: [
        "Open with a grounded welcome built from the user's real solution + skill names (business-friendly).",
        "State tenant + environment on connect, and where things land after each deploy (with a link).",
        "Explain Skill vs Solution vs Connector in plain words before building",
        "Use ateam_build_and_run for the full lifecycle (validates automatically)",
        "Use ateam_patch for skill/solution definition changes (updates + redeploys automatically)",
        // It said ateam_github_patch + ateam_build_and_run(github:true), four
        // lines above the rule below. build_and_run deploys `main`, so it
        // either refuses (MAIN_BEHIND_DEV) or deploys without the patch.
        "Use ateam_github_patch + ateam_upload_connector(solution_id, connector_id, github:true) for connector code changes after first deploy; promote + ateam_build_and_run(solution_id) only to ship",
        "Study the connector example (ateam_get_examples type='connector') before writing connector code",
        "Ask discovery questions if goal unclear — one at a time, with choices",
        "Deliver the FULL ask, including any requested UI/widget; stage only with the user's agreement",
        // "After ANY write, say the change is not live" was false for ateam_patch,
        // which redeploys in the same call.
        `After a repo-only write (ateam_github_patch / ateam_github_write), say it is not deployed yet and name the next step: deploy it from \`${BRANCH_WORKFLOW.write_branch}\` to test (ateam_upload_connector / ateam_redeploy), or ship it: ${BRANCH_WORKFLOW.one_line}.`,
      ],
      never: [
        "Talk to a business user like a developer — no jargon, no walls of text",
        "Send a generic welcome that ignores the user's actual solution/skills",
        "Ask the builder a runtime question that the deployed skill should ask its end-users",
        "Silently defer or drop a named part of the request (e.g. the UI)",
        "Leave the user guessing which tenant/environment they're changing",
        "Surface a raw error (524 / SOLUTION_NOT_FOUND / github_not_connected) — translate it and guide the next step",
        "Call validate + deploy + health separately when ateam_build_and_run does it in one step",
        "Dump raw spec unless requested",
        "Write connector code that starts a web server — connectors MUST use stdio transport",
      ],
    },
  }),

  ateam_auth: async ({ api_key, master_key, tenant, url }, sessionId) => {
    // A platform session (ateam-proxy-mcp's one session for every tenant) is
    // signed in AFRESH: nothing the previous tenant left — url, master key,
    // actor, context — reaches this one. First, before anything below reads the
    // record. See resetPlatformSession.
    resetPlatformSession(sessionId);

    // Master key mode: cross-tenant auth using shared secret
    if (master_key) {
      if (!tenant) {
        return { ok: false, message: "Master key requires a tenant parameter. Specify which tenant to operate on." };
      }
      const apiUrl = url ? url.replace(/\/+$/, "") : undefined;
      // A refused key leaves the session exactly as it was (api.js beginSignIn).
      const refused = beginSignIn(sessionId);
      setSessionCredentials(sessionId, { tenant, apiKey: null, apiUrl, explicit: true, masterKey: master_key });
      // Verify by listing solutions
      try {
        const result = await get("/deploy/solutions", sessionId);
        const urlNote = apiUrl ? ` (via ${shownBase(apiUrl)})` : "";
        return {
          ok: true,
          tenant,
          masterMode: true,
          message: `Master key authenticated to tenant "${tenant}"${urlNote}. ${result.solutions?.length || 0} solution(s) found. Use tenant parameter on any tool to switch tenants without re-auth.`,
        };
      } catch (err) {
        const base = getBaseUrl(sessionId);
        refused();
        return { ok: false, tenant, message: `Master key auth failed: ${signInRefusal(err, base, sessionId)}` };
      }
    }

    // Normal API key mode
    if (!api_key) {
      return { ok: false, message: "Provide either api_key or master_key." };
    }
    // ── THE KEY NAMES ITS ENVIRONMENT ──────────────────────────────────────
    //
    // One public MCP endpoint, and until now nothing about a session said which
    // environment it was on: the caller passed `url` or silently got the prod
    // default. A dev key at the prod base is just a 401, diagnosed after the
    // fact (see the hint below) and never prevented. The process starts at the
    // key, so the key carries the environment.
    //
    // NO FALLBACK, in either direction. A key that names an environment routes
    // there and NOWHERE else; if that backend rejects it, that is the answer.
    // Retrying the sibling host is how a dev key deploys to production.
    const keyEnv = parseApiKey(api_key).env;
    const explicitUrl = url ? url.replace(/\/+$/, "") : undefined;

    // An explicit url that CONTRADICTS the key is refused here, locally, before
    // any network call. The override still exists for unusual hosts (localhost,
    // a staging box) — envForBaseUrl only recognises the known prod/dev hosts,
    // so anything else passes through untouched. What it must never be is a way
    // to cross environments by accident.
    if (keyEnv && explicitUrl) {
      const urlEnv = envForBaseUrl(explicitUrl);
      if (urlEnv && urlEnv !== keyEnv) {
        return {
          ok: false,
          message: `Refusing to authenticate: this key names the "${keyEnv}" environment, but url points at "${urlEnv}" (${shownBase(explicitUrl)}). One of them is wrong, and guessing which would mean operating on the wrong system. Drop the url argument to use the key's own environment, or use a key for "${urlEnv}".`,
        };
      }
    }

    const apiUrl = explicitUrl || baseUrlForKeyEnv(api_key) || undefined;

    // ── WHO IS THIS KEY? ───────────────────────────────────────────────────
    //
    // It used to be answered by splitting the string, which is exactly why the
    // customer's name travelled inside the credential — into logs, screenshots,
    // support tickets. A SEALED key (`adas_<env>_<blob>`) does not carry it, so
    // we ASK. Order of preference, and nothing beyond it:
    //
    //   1. an explicit `tenant` argument
    //   2. the tenant the key still spells out (older formats)
    //   3. GET /auth/whoami
    //
    // A sealed key whose whoami fails is REFUSED. Not "authenticated without a
    // tenant", not retried elsewhere: ateam_auth is the moment a session learns
    // who it is, and half-knowing is how a caller ends up acting on the wrong
    // account. Nothing here invents a tenant under any circumstances.
    let resolvedTenant = tenant || parseApiKey(api_key).tenant;
    if (!resolvedTenant) {
      const base = apiUrl || getBaseUrl(sessionId);
      try {
        const me = await whoami(api_key, base);
        resolvedTenant = me.tenant;
      } catch (err) {
        // The API recognised the key and refused its PERSON (deleted, or no
        // longer active): that is the answer, not a host that cannot say who
        // the key is — "upgrade it or pass tenant" would send the reader the
        // wrong way. formatError reads the whole body (whoami carries it).
        const person = personRefused(err?.status, err?.body);
        if (person) {
          return { ok: false, code: person.code, message: `Authentication failed: ${signInRefusal(err, base, sessionId, "/auth/whoami")}` };
        }
        return {
          ok: false,
          message:
            `This key does not name its tenant — the tenant is sealed inside it and only the server can read it — ` +
            `and ${shownBase(base)} could not tell me who you are: ${err.message} ` +
            `Nothing was authenticated: acting on a guessed tenant is the one failure this must never have. ` +
            `If that host is an older deployment without /auth/whoami, upgrade it or pass tenant: "<name>" explicitly.`,
        };
      }
    }
    if (!resolvedTenant) {
      return {
        ok: false,
        message: `Could not resolve tenant from api_key (expected format: adas_<env>_<key>). Pass the "tenant" arg explicitly, or check that your API key is well-formed.`,
      };
    }

    // A refused key leaves the session exactly as it was (api.js beginSignIn):
    // it stayed on the refused key, and its opening said it was signed in.
    const refused = beginSignIn(sessionId);
    setSessionCredentials(sessionId, { tenant: resolvedTenant, apiKey: api_key, apiUrl, explicit: true });
    // Verify the key works by listing solutions
    try {
      const result = await get("/deploy/solutions", sessionId);
      // Persist the override per bearer (every later session of it) only for a
      // key the API ACCEPTED. It was stored before this check (8fc71af), so a
      // refused key was re-applied to each new session of the bearer for
      // SESSION_TTL — a reconnect or a new chat stayed on it. A new sign-in on
      // the A-Team page drops it (oauth.js exchangeAuthorizationCode).
      setAuthOverride(sessionId, { tenant: resolvedTenant, apiKey: api_key, apiUrl });
      const urlNote = apiUrl ? ` (via ${shownBase(apiUrl)})` : "";
      const environment = sessionEnvironment(sessionId);
      return {
        ok: true,
        tenant: resolvedTenant,
        // The environment is part of WHO YOU ARE NOW, so it is reported here and
        // in ateam_bootstrap.runtime, from the same resolution — one question,
        // one answer.
        //
        // A KEY THAT NAMES NO ENVIRONMENT GETS NO CLAIM. Until keys are
        // recreated, a legacy `adas_<tenant>_<hex>` still authenticates and
        // still lands on the process default — which is PRODUCTION. That
        // routing predates this change and is not made worse by it, but
        // reporting it as `environment: "prod"` would be: it would turn an
        // unstated default into a confident assertion, which is the exact
        // failure this whole change exists to remove. So the field says
        // `unstated`, and the note says which base was used and why.
        // ONE owner of the answer (api.js sessionEnvironment), read by the
        // `session` opening too: they disagreed for this very key.
        environment,
        ...(environment === "unstated" && !explicitUrl && {
          environment_note: `This key does not name an environment, so the process default was used (${shownBase(getBaseUrl(sessionId))}). Recreate it as adas_<env>_<tenant>_<hex> to make the environment explicit — until then nothing here can confirm which system you are on.`,
        }),
        base_url: shownBase(getBaseUrl(sessionId)),
        message: `Authenticated to tenant "${resolvedTenant}"${urlNote}. ${result.solutions?.length || 0} solution(s) found.`,
      };
    } catch (err) {
      // OPEN-18: a well-formed `adas_<tenant>_<hex>` key that's rejected is often
      // a key for the OTHER environment (a dev key against the prod base, or vice
      // versa). Surface the base we tried and, if it looks like that mismatch,
      // say to retry with that API's base as url — instead of a generic
      // "invalid/unconfigured key". The text names no host but prod's.
      const base = getBaseUrl(sessionId) || "";
      // Read the base the key was tried at, THEN put the session back, THEN
      // say why: built before, the refusal described the unverified key as
      // the session's own ("may have been rotated").
      refused();
      const upstream = signInRefusal(err, base, sessionId);
      // A KEY WHOSE PERSON IS GONE WAS RECOGNISED. KEY_OWNER_DELETED /
      // KEY_OWNER_INACTIVE prove this API knows the key, so the older-key
      // "WRONG API, most likely — not a bad key" below would be false for it:
      // say what the API said, first.
      const person = personRefused(err?.status, err?.body);
      if (person) {
        return {
          ok: false,
          tenant: resolvedTenant,
          code: person.code,
          message: `Authentication failed: ${upstream} (tried ${base ? shownBase(base) : "the default base"}).`,
        };
      }
      const parsedKey = parseApiKey(api_key);
      const wellFormedKey = parsedKey.isValid;
      const triedProd = /(?:^|\/\/)api\.ateam-ai\.com/.test(base);
      // THE HEADLINE MUST NOT CONTRADICT THE HINT. The upstream message is
      // "Invalid or unconfigured API key" — which for a well-formed key tried
      // against the WRONG ENVIRONMENT is false: the key is fine, the target is
      // wrong. Leading with it sent the reader to get a replacement key they
      // did not need. The hint below already said the right thing and rescued a
      // session on 2026-08-21, but only because someone read past the first
      // line. Lead with the likely cause; keep the upstream text as detail.
      // A key that NAMES its environment cannot be in the wrong one — routing
      // came from the key itself, and a contradicting url was refused above. So
      // this hint is only for the older no-env keys that still land on the prod
      // default. Offering it for an env-bearing key would send the reader
      // chasing an environment mismatch that the format has already ruled out.
      if (wellFormedKey && triedProd && !parsedKey.env) {
        return {
          ok: false,
          tenant: resolvedTenant,
          env_mismatch_suspected: true,
          message:
            // PUBLIC TEXT NAMES PRODUCTION ONLY (Arie, 2026-10-01): this named
            // the other environment's host as the url to retry with.
            `WRONG API, most likely — not a bad key. "adas_${resolvedTenant}_…" is an older, well-formed key that names no API, ` +
            `and it was tried against PROD (${base}), which is the default. A key from another A-Team API is rejected there: ` +
            `retry with that API's base as url (ateam_auth(api_key, url:"<its API base>")), or use a current key, which names its own API. ` +
            `Only if that also fails is the key itself the problem. ` +
            `Upstream said: ${upstream}`,
        };
      }
      return {
        ok: false,
        tenant: resolvedTenant,
        // It ended "get a valid API key at …/get-api-key" (c61e60b). The
        // upstream error already carries what to do (formatError's 401/403
        // hints render the shared steps).
        message: `Authentication failed: ${upstream} (tried ${base ? shownBase(base) : "the default base"}).`,
      };
    }
  },

  ateam_get_spec: async ({ topic, section, search }, sid) => {
    // Served LOCALLY (no round-trip): the monitoring contract is a property of
    // THIS ateam-mcp build, so it must answer even when the API is unreachable —
    // that is exactly when a caller is asking "what can I poll to find out?".
    if (topic === "monitoring") {
      return {
        ateam_mcp_version: MCP_VERSION,
        safe_to_poll: monitoringTools,
        not_safe_to_poll: tools
          .filter(t => t.monitoring?.safe === false)
          .map(t => ({ name: t.name, cost: t.monitoring.cost, output: t.monitoring.output, use_instead: t.monitoring.use_instead })),
        unclassified_are_unsafe: true,
        rules: [
          "output:'bounded' means bounded IN THE RUN'S SIZE — not merely small today. A tool that returns 200 steps for a 200-step job is grows_with_run and is never poll-safe.",
          "A tool with no monitoring field is UNCLASSIFIED — treat it as unsafe to poll.",
          "NEVER apply an 'idle_seconds > N ⇒ dead' rule. On this platform a healthy build regularly sits minutes inside a single provider call; read activity_source alongside it.",
        ],
        watching_a_run: "Poll ateam_chain_status (every ~2s, or ~30s for a long build) and read chain_done + last_activity_at/idle_seconds/activity_source. Call ateam_get_chain ONCE at the end for the full tree.",
      };
    }
    // An unknown topic used to leave `path` undefined, so the fetch targeted
    // "<base>undefined" — a host that does not exist. The DNS failure surfaced
    // as "check your internet connection", about a deployment that had just
    // answered. get_examples, twenty lines below, has had exactly this guard
    // since 04c24ce; it was never brought up here.
    let path = SPEC_PATHS[topic];
    // A search hit that names an example (ateam_spec_search) is read with
    // ateam_get_examples; its name is not a spec topic.
    if (!path && /^\/?(?:spec\/)?examples\//.test(String(topic))) {
      throw new Error(`"${topic}" is an example, not a spec topic: read it with ateam_get_examples(type: "<the part after examples/>").`);
    }
    if (!path) {
      throw new Error(
        `Unknown spec topic "${topic}". Available: ${Object.keys(SPEC_PATHS).join(", ")}.`
      );
    }
    const params = new URLSearchParams();
    if (section) params.set('section', section);
    const searched = search || SPEC_TOPIC_PART[topic];
    if (searched) params.set('search', searched);
    const qs = params.toString();
    if (qs) path += `?${qs}`;
    return withServedBy(await get(path, sid), sid);
  },

  ateam_get_workflows: async (_args, sid) => withServedBy(await get("/spec/workflows", sid), sid),

  ateam_get_examples: async ({ type }, sid) => {
    // An unknown type used to reach get(undefined) and fetch the API root, so a
    // typo answered with something that looked like a valid response. Say what
    // exists instead — the caller cannot see this map.
    // Own keys only: "toString" or "constructor" must not resolve to something
    // inherited from Object.prototype and be fetched as a path.
    const path = Object.hasOwn(EXAMPLE_PATHS, String(type)) ? EXAMPLE_PATHS[type] : null;
    if (!path) {
      throw new Error(
        `Unknown example type "${type}". Available: ${EXAMPLE_TYPES.join(", ")}.`
      );
    }
    return withServedBy(await get(path, sid), sid);
  },

  // Design-time capability advisor. Proxies to the Builder's /spec/advisor
  // (LLM over the curated capability catalog). SIGNED-IN ONLY: it runs the
  // tenant's LLM, so the Builder refuses a call with no verified key (401
  // SIGN_IN_REQUIRED, Builder #81), and the sign-in gate (publicTools.js: every
  // tool not listed there is refused first) stops a key-less session before
  // this runs. This comment used to say "Public endpoint (auth-exempt)"
  // (5f539fa) — the exemption that let a bare X-ADAS-TENANT header bill
  // another tenant's LLM.
  ateam_design_advisor: async ({ goal, design_state }, sid) => {
    if (!goal || typeof goal !== "string") throw new Error("goal required (a string describing what you're building)");
    // Direct call to the Builder's /spec/advisor. The session's X-ADAS-TENANT
    // header rides along (post() sets it), so the Builder resolves this tenant's
    // LLM via Core's sys.llm gateway (stage→tier→model, transparent — no keys in
    // the Builder). Reachable externally on prod: the relay forwards /spec/*.
    // A read over POST: declared idempotent, so a transport failure may be re-sent (api.js mayAutoRetry).
    return post("/spec/advisor", { goal, design_state: design_state || {} }, sid, { timeoutMs: 90_000, retries: 1, idempotent: true });
  },

  // Semantic search over the full /spec corpus: the Builder's POST /spec/search,
  // which needs NO key, tenant or LLM (its apiKeyAuth exempts the route, and it
  // reaches sysSpecSearch-mcp over the docker network).
  //
  // 3a23931 called exactly this. b90f423 moved it, with the advisor, onto the
  // key-gated connector-call route (/deploy/solutions/_/connectors/
  // sysSpecSearch-mcp/call) to dodge prod /spec 404s; 8e84d1f moved the advisor
  // back once the relay forwarded /spec, and left this one behind. So a session
  // that had not signed in got 401 "Missing API key" from the doc search that
  // bootstrap names as the door that works without the advisor (MGAP-A3).
  ateam_spec_search: async ({ query, top_k }, sid) => {
    if (!query || typeof query !== "string") throw new Error("query required (a string question)");
    const r = await post(
      "/spec/search",
      { query, ...(top_k ? { top_k } : {}) },
      sid,
      // A search over POST: declared idempotent (api.js mayAutoRetry).
      { timeoutMs: 30_000, retries: 1, idempotent: true },
    );
    return withServedBy(r, sid);
  },

  // ─── Composite: Build & Run ────────────────────────────────────────
  // The pipeline is runBuildAndRun. Over the hosted transport the call waits
  // for it at most HOSTED_CALL_BUDGET_MS; resume:true waits for the same run
  // again and never deploys (see "The hosted call's budget").

  ateam_build_and_run: async (args, sid) => buildRunWithinBudget(args, sid),

  // ─── Composite: Patch ──────────────────────────────────────────────
  // Updates → Redeploys → Optionally tests
  // One call replaces: ateam_update + ateam_redeploy

  ateam_patch: async ({ solution_id, target, skill_id, updates, test_message, dry_run, source, include_definition }, sid) => {
    const phases = [];
    let isNewSkill = false;
    let _connectorToolPush = null;
    let writeBranch = "dev"; // github/patch default; overwritten by the actual response branch
    const _diff = { arrays_merged: [], arrays_replaced: [], scalars_changed: [], sections_replaced: [] };

    // Two backing stores, chosen EXPLICITLY by `source` (never inferred):
    //   'github' (default) — GitHub-first: read from GitHub → apply patch → write
    //     back → redeploy. GitHub stays the single source of truth.
    //   'local' — Builder-FS-first: read from and write to the Builder store for a
    //     repo-less bootstrap tenant (freshly onboarded from a template, GitHub not
    //     yet connected). GitHub is still master overall; local is a temporary
    //     bootstrap until the tenant connects a repo (then local is pushed → GitHub).
    // Redeploy (Phase 4) is local (Builder FS → Core) in BOTH modes.
    let isLocal = source === "local";
    // Was a source EXPLICITLY chosen? An unspecified source is the default ("github")
    // and MAY auto-degrade to local when the tenant hasn't connected a repo — a simple
    // def patch must work FS-only (Arie's rule: create/patch allowed offline; only
    // GitHub-native ops refuse). An explicit source:'github' is honored as-is (the
    // caller asked for GitHub → it fails loud if not connected), and explicit 'local'
    // stays local.
    const sourceExplicit = source === "github" || source === "local";
    let degradedToLocal = false;

    // Phase 1: Read current state (or create scaffold if new skill)
    let current;
    const filePath = target === "skill" && skill_id
      ? `skills/${skill_id}/skill.json`
      : `solution.json`;
    try {
      if (isLocal) {
        // Read the raw definition from the Builder store — no GitHub repo needed.
        if (target === "skill" && skill_id) {
          const r = await get(apiPath`/deploy/solutions/${solution_id}/skills/${skill_id}`, sid);
          current = r.skill || r.definition || r;
        } else {
          // ?raw=1 → the agent-api returns the UNSTRIPPED solution (keeps
          // linked_skills/conversation) so _delete/_push operate on the real arrays.
          const r = await get(apiPath`/deploy/solutions/${solution_id}/definition?raw=1`, sid);
          current = r.solution || r;
        }
        if (!current || typeof current !== "object") {
          throw new Error(`Local ${filePath} not found (empty definition)`);
        }
      } else {
        try {
          const readResult = await get(apiPath`/deploy/solutions/${solution_id}/github/read?path=${filePath}`, sid);
          current = JSON.parse(readResult.content);
        } catch (ghErr) {
          // Auto-degrade a DEFAULT-source patch to the Builder FS when the tenant
          // hasn't connected GitHub. A github/read failure alone is ambiguous (could
          // be a wrong solution_id or a transient Core hiccup — both must still fail
          // loud), so disambiguate with the definitive /github/connected probe and
          // only degrade on a genuine "not connected". Explicit source:'github' never
          // degrades. The local write below reconciles to GitHub once connected.
          let connected = true;
          if (!sourceExplicit) {
            // null (the probe itself failed) counts as connected → don't mask the real read error
            connected = (await probeGithubConnected(solution_id, sid)) !== false;
          }
          if (!sourceExplicit && !connected) {
            isLocal = true;
            degradedToLocal = true;
            const r = target === "skill" && skill_id
              ? await get(apiPath`/deploy/solutions/${solution_id}/skills/${skill_id}`, sid)
              : await get(apiPath`/deploy/solutions/${solution_id}/definition?raw=1`, sid);
            current = target === "skill" && skill_id
              ? (r.skill || r.definition || r)
              : (r.solution || r);
            if (!current || typeof current !== "object") {
              throw new Error(`Local ${filePath} not found (empty definition)`);
            }
          } else {
            throw ghErr; // connected (real error) or explicit github → surface it
          }
        }
      }
    } catch (err) {
      // OPEN-31 guard: only scaffold-create when the skill is GENUINELY ABSENT.
      // The old code scaffolded on ANY read error, so a transient github/read
      // failure (fetch failed, 5xx, parse error) silently OVERWROTE a full
      // deployed skill with a bare scaffold on the next write — total data loss.
      //
      // A genuine "doesn't exist" is a 404 (or the local empty-definition throw).
      // Anything else = the store is unreachable/broken → FAIL LOUD, never write.
      const notFound = err.status === 404 || /not found \(empty definition\)/i.test(err.message || "");
      if (target === "skill" && skill_id && !notFound) {
        return {
          ok: false, phase: "read",
          error: `Refusing to patch "${skill_id}": could not read its current definition from ${isLocal ? "the Builder store" : "GitHub"} (${err.message}). This is NOT a "skill doesn't exist" error (that would be a 404) — scaffolding now could DESTROY the existing definition. Retry once the store is reachable, or check ateam_get_solution(solution_id, skill_id).`,
          phases,
        };
      }
      // Even on a real 404, the skill may exist in the OTHER source (deployed to
      // the Builder store but not pushed to GitHub, or vice versa). Scaffolding
      // then would destroy/diverge that real def — cross-check before creating.
      if (target === "skill" && skill_id) {
        let otherDef = null;
        try {
          const other = isLocal
            ? JSON.parse((await get(apiPath`/deploy/solutions/${solution_id}/github/read?path=${filePath}`, sid)).content)
            : await get(apiPath`/deploy/solutions/${solution_id}/skills/${skill_id}`, sid);
          otherDef = other?.skill || other?.definition || other;
        } catch { otherDef = null; /* absent in the other source too → truly new */ }
        const otherIsReal = otherDef && typeof otherDef === "object" && (
          (Array.isArray(otherDef.tools) && otherDef.tools.length > 0) ||
          (Array.isArray(otherDef.connectors) && otherDef.connectors.length > 0) ||
          otherDef.voice_native || otherDef.ui_plugins ||
          (otherDef.role && otherDef.role.persona)
        );
        if (otherIsReal) {
          return {
            ok: false, phase: "read",
            error: `Refusing to patch "${skill_id}": it was not found in ${isLocal ? "the Builder store" : "GitHub"}, but a full definition EXISTS in ${isLocal ? "GitHub" : "the Builder store"}. Scaffold-creating here would destroy/diverge it. Sync the two first (ateam_redeploy / ateam_verify_consistency), then retry — do NOT patch-create over an existing skill.`,
            phases,
          };
        }
      }
      // If it's a skill that GENUINELY doesn't exist (404 in the primary source
      // AND absent from the other), create a default scaffold. This lets agents
      // use ateam_patch to both CREATE and UPDATE skills — no separate step.
      if (target === "skill" && skill_id) {
        console.log(`[ateam_patch] Skill "${skill_id}" genuinely absent (404, both sources) — creating new skill scaffold`);
        isNewSkill = true;
        current = {
          id: skill_id,
          name: skill_id.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
          description: "",
          version: "0.1.0",
          phase: "PROBLEM_DISCOVERY",
          connectors: [],
          problem: { statement: "", context: "", goals: [] },
          scenarios: [],
          role: { name: "", persona: "", goals: [], limitations: [], communication_style: { tone: "professional", verbosity: "concise" } },
          intents: { supported: [], thresholds: { accept: 0.8, clarify: 0.5, reject: 0.5 }, out_of_domain: { action: "redirect", message: "" } },
          tools: [],
          policy: { access: { requires_roles: [] }, guardrails: { never: [], always: [] }, approvals: [], workflows: [], escalation: { enabled: false, conditions: [], target: "" } },
          engine: { rv2: { max_iterations: 10, iteration_timeout_ms: 120000, allow_parallel_tools: false, on_max_iterations: "ask_user" }, hlr: { enabled: true, critic: { enabled: true, check_interval: 3, strictness: "medium" }, reflection: { enabled: true, depth: "shallow" }, replanning: { enabled: true, max_replans: 3 } }, autonomy: { level: "supervised" }, finalization_gate: { enabled: true, max_retries: 2 } },
          access_policy: { rules: [{ tools: ["*"], effect: "allow" }] },
          grant_mappings: [],
          channels: [],
          conversation: [],
          triggers: [],
          meta_tools: [],
          glossary: {},
        };
        phases.push({ phase: "read", status: "created_scaffold", skill_id });
      } else {
        return { ok: false, phase: "read", error: `Failed to read ${filePath} from ${isLocal ? "Builder store (local)" : "GitHub"}: ${err.message}` };
      }
    }

    // Phase 2: Apply patch in memory
    let patched = { ...current };
    try {
      for (const [key, value] of Object.entries(updates || {})) {
        if (key === "persona_append" && typeof value === "string") {
          // persona_append: shorthand for appending text to role.persona without
          // rewriting the whole string. Historically agents set this expecting
          // it to work; the planner only reads role.persona, so this shorthand
          // now merges into the correct field. A trailing separator is inserted
          // if the existing persona doesn't already end with whitespace.
          if (!patched.role || typeof patched.role !== "object") patched.role = {};
          const existing = typeof patched.role.persona === "string" ? patched.role.persona : "";
          const sep = (!existing || /\s$/.test(existing)) ? "" : "\n\n";
          patched.role.persona = existing + sep + value;
        } else if (key.endsWith("_push")) {
          // Array push: tools_push, intents.supported_push, etc.
          // BUG FIX: previously did `patched[field] = ...` which created a
          // top-level key with a literal dot (e.g. patched["intents.supported"])
          // instead of pushing into patched.intents.supported. Traverse the
          // dotted path correctly. Also enforce array-only values — was silently
          // falling through to the dot-notation branch when given a single
          // object, leaving a stray "<field>_push" sibling key behind.
          if (!Array.isArray(value)) {
            return { ok: false, phase: "patch", error: `${key} requires an array value (got ${typeof value}). Wrap the item in [] — e.g. {"${key}": [{...}]}.` };
          }
          const field = key.replace(/_push$/, "");
          const { parent, leaf } = _resolveDottedField(patched, field);
          parent[leaf] = [...(Array.isArray(parent[leaf]) ? parent[leaf] : []), ...value];
          // Record the merge so a successful push is NOT reported as an empty
          // diff / silent no-op (OPEN-21 reporting gap).
          _diff.arrays_merged.push({ field, added: value.length });
          // OPEN-21: a connector's tools are granted by LINKING the connector
          // (connectors_push), NOT by pushing a definition into tools[]. Flag an
          // obviously connector-served push so we can redirect the agent.
          if (field === "tools") {
            const connectorish = value
              .filter((t) => t?.source?.type === "mcp_bridge" || (typeof t?.name === "string" && t.name.endsWith(":*")))
              .map((t) => t?.name).filter(Boolean);
            if (connectorish.length) _connectorToolPush = connectorish;
          }
        } else if (key.endsWith("_delete")) {
          if (!Array.isArray(value)) {
            return { ok: false, phase: "patch", error: `${key} requires an array of names/ids (got ${typeof value}). Pass {"${key}": ["name1", "name2"]}.` };
          }
          const field = key.replace(/_delete$/, "");
          const { parent, leaf } = _resolveDottedField(patched, field);
          const arr = Array.isArray(parent[leaf]) ? parent[leaf] : [];
          // Match by EITHER id OR name OR primitive value. Old logic short-
          // circuited on item.name first ("name || id || self"), which silently
          // failed when an item had both name and id and the caller passed the
          // id. Now we check both keys + the primitive case.
          const matchValues = new Set(value.map(v => (v && typeof v === 'object') ? (v.id ?? v.name) : v));
          const before = arr.length;
          parent[leaf] = arr.filter(item => {
            if (item == null) return true;
            if (typeof item !== 'object') return !matchValues.has(item);
            if (item.id !== undefined && matchValues.has(item.id)) return false;
            if (item.name !== undefined && matchValues.has(item.name)) return false;
            return true;
          });
          if (parent[leaf].length === before && value.length > 0) {
            // Surface a "not found" hint instead of silent ok:true. Helps
            // agents catch typos and the "wrong key" class of bugs.
            phases.push({ phase: 'patch', warning: `${key}: nothing matched [${value.join(', ')}] — array unchanged` });
          }
        } else if (key.endsWith("_update")) {
          if (!Array.isArray(value)) {
            return { ok: false, phase: "patch", error: `${key} requires an array of update objects (got ${typeof value}). Pass {"${key}": [{name: "x", description: "..."}]}.` };
          }
          const field = key.replace(/_update$/, "");
          const { parent, leaf } = _resolveDottedField(patched, field);
          const arr = Array.isArray(parent[leaf]) ? parent[leaf] : [];
          // Same fix as _delete — match upd → existing by EITHER id OR name.
          for (const upd of value) {
            const updKey = (upd && typeof upd === 'object') ? (upd.id ?? upd.name) : upd;
            const idx = arr.findIndex(item => {
              if (!item || typeof item !== 'object') return item === updKey;
              return item.id === updKey || item.name === updKey;
            });
            if (idx >= 0) arr[idx] = { ...arr[idx], ...upd };
            else arr.push(upd);
          }
          parent[leaf] = arr;
        } else if (key === "_replace" || key.endsWith("_replace")) {
          // Escape-hatch flags handled by the guard — skip them here so they
          // don't get written into the patched object as literal fields.
          continue;
        } else if (key.includes(".")) {
          // Dot notation: "role.persona", "intents.thresholds.accept"
          const parts = key.split(".");
          // Sibling-loss guard: if the leaf resolves to an existing non-empty
          // array and the incoming value is also an array, refuse the replace
          // unless the caller opted in. (Dot-notation is how many agents
          // accidentally hit this — e.g. updates:{ "linked_skills": ["one"] }
          // on target='solution'.)
          const leafKey = parts[parts.length - 1];
          let cursor = patched;
          for (let i = 0; i < parts.length - 1; i++) {
            if (!cursor || typeof cursor[parts[i]] !== 'object') { cursor = null; break; }
            cursor = cursor[parts[i]];
          }
          const currentLeaf = cursor && Object.prototype.hasOwnProperty.call(cursor, leafKey) ? cursor[leafKey] : undefined;
          const guardErr = _guardArrayReplace({ target, key: leafKey, value, current: currentLeaf, updates });
          if (guardErr) return guardErr;
          if (Array.isArray(value) && Array.isArray(currentLeaf)) _diff.arrays_replaced.push(key);
          else if (typeof value === 'object' && value !== null && !Array.isArray(value)) _diff.sections_replaced.push(key);
          else _diff.scalars_changed.push(key);
          let obj = patched;
          for (let i = 0; i < parts.length - 1; i++) {
            if (!obj[parts[i]] || typeof obj[parts[i]] !== "object") obj[parts[i]] = {};
            obj = obj[parts[i]];
          }
          obj[parts[parts.length - 1]] = value;
        } else {
          // Direct top-level field replacement. Sibling-loss guard: if this
          // names a known array field and would drop items, refuse unless the
          // caller passed _replace:true (object-level) or <field>_replace:true.
          const guardErr = _guardArrayReplace({ target, key, value, current: patched[key], updates });
          if (guardErr) return guardErr;
          if (Array.isArray(value) && Array.isArray(patched[key])) _diff.arrays_replaced.push(key);
          else if (typeof value === 'object' && value !== null && !Array.isArray(value)) _diff.sections_replaced.push(key);
          else _diff.scalars_changed.push(key);
          patched[key] = value;
        }
      }
      phases.push({ phase: "patch", status: "done" });
    } catch (err) {
      return { ok: false, phase: "patch", error: `Failed to apply patch: ${err.message}` };
    }

    // Dry-run: return diff + would-be after-state without writing to GitHub
    // or redeploying. Lets an agent preview any destructive-looking edit.
    // would_write mirrors the EXACT persistence request the real run makes
    // (method/endpoint/body key) so create-vs-update routing bugs surface in
    // dry-run instead of only on the real write.
    if (dry_run) {
      const would_write = isLocal
        ? (target === "skill" && skill_id && isNewSkill
            ? { method: "POST", endpoint: apiPath`/deploy/solutions/${solution_id}/skills`, body_key: "skill", creates: true }
            : target === "skill" && skill_id
              ? { method: "PATCH", endpoint: apiPath`/deploy/solutions/${solution_id}/skills/${skill_id}`, body_key: "updates" }
              : { method: "PATCH", endpoint: apiPath`/deploy/solutions/${solution_id}`, body_key: "state_update" })
        : { method: "POST", endpoint: apiPath`/deploy/solutions/${solution_id}/github/patch`, body_key: "content" };
      return {
        ok: true,
        dry_run: true,
        target,
        solution_id,
        skill_id,
        phases,
        _diff,
        // OPEN-8: the full after-state (a big skill/solution def) blows the ~50KB
        // output cap and truncates the rest of the result. Return a compact
        // summary by default; pass include_definition:true for the whole thing.
        ...(include_definition
          ? {
              after_state: patched,
              // The base of this after-state came from a git read, so it inherits
              // that copy's staleness — notably regenerated connector tools. Say so
              // rather than letting an agent treat it as runtime truth.
              _ateam_representation: _representationFor(
                target === "skill" && skill_id ? `skills/${skill_id}/skill.json` : "solution.json",
                patched,
                solution_id,
              ),
            }
          : { after_state_summary: _summarizeDef(patched) }),
        would_write,
        would_write_bytes: JSON.stringify(patched, null, 2).length,
        hint: "No changes applied. Remove dry_run:true to commit + redeploy. (Pass include_definition:true for the full after_state.)",
      };
    }

    // Phase 3: Write patched version back to the chosen store.
    try {
      const patchKeys = Object.keys(updates || {});
      const message = `Patch: ${target}${skill_id ? ` ${skill_id}` : ""} — ${patchKeys.join(", ")}`;
      if (isLocal) {
        // Write the FULL patched object to the Builder store. The client-side
        // merge above already resolved _push/_delete/_update, so we send the
        // resolved object. THREE distinct Builder routes, each with its own
        // body contract (mismatching them 400s):
        //   • NEW skill    → POST /deploy/solutions/:id/skills   { skill }
        //     (creates via the Builder, applies the full definition, and
        //      pushes the topology skills[] entry — the PATCH route can't
        //      create: it 404s on resolveSkillId / 400s "Updates object is
        //      required". This was the japanese-tutor repo-less bug.)
        //   • EXISTING skill → PATCH …/skills/:skillId           { updates }
        //   • Solution       → PATCH /deploy/solutions/:id       { state_update }
        if (target === "skill" && skill_id && isNewSkill) {
          await post(apiPath`/deploy/solutions/${solution_id}/skills`, { skill: patched }, sid, { timeoutMs: 30_000 });
          phases.push({ phase: "local_write", status: "done", created: true });
        } else if (target === "skill" && skill_id) {
          await patch(apiPath`/deploy/solutions/${solution_id}/skills/${skill_id}`, { updates: patched }, sid, { timeoutMs: 30_000 });
          phases.push({ phase: "local_write", status: "done" });
        } else {
          await patch(apiPath`/deploy/solutions/${solution_id}`, { state_update: patched }, sid, { timeoutMs: 30_000 });
          phases.push({ phase: "local_write", status: "done" });
        }
      } else {
        // github/patch writes to `dev` by default (agents don't edit prod
        // directly). Capture the ACTUAL branch it committed to — do NOT assume
        // 'main'; mislabeling it strands the change off `main` until an explicit
        // ateam_github_promote (was: the result hardcoded branch:"main").
        const ghResp = await post(apiPath`/deploy/solutions/${solution_id}/github/patch`, {
          path: filePath,
          content: JSON.stringify(patched, null, 2),
          message,
        }, sid, { timeoutMs: 30_000 });
        writeBranch = ghResp?.branch || writeBranch;
        // The Builder may have left its own copy of the file alone (it had a
        // change the commit did not carry — a hotfix from main, a save that
        // never reached GitHub), or now hold main content dev lacks. Its note
        // says so and what to do; the redeploy below is refused and names it.
        const fsMirror = ghResp?.fs_mirror;
        phases.push({
          phase: "github_write", status: "done", branch: writeBranch,
          ...((fsMirror?.mirrored === false || fsMirror?.other_branch) && fsMirror.note && { builder_copy: fsMirror.note }),
        });
      }
    } catch (err) {
      const store = isLocal ? "Builder store (local)" : "GitHub";
      return { ok: false, phase: isLocal ? "local_write" : "github_write", error: `Patch applied but failed to write to ${store}: ${err.message}`, phases };
    }

    // Phase 3b: If new skill, add it to solution.json topology (skills[], linked_skills)
    if (isNewSkill && skill_id) {
      try {
        const skillEntry = { id: skill_id, name: patched.name || skill_id, role: "worker", description: patched.description || "", connectors: patched.connectors || [] };
        if (isLocal) {
          // Local: _push the entries via the Builder store (dedup handled by the
          // store's _push — it updates in place if the id already exists).
          await patch(apiPath`/deploy/solutions/${solution_id}`, {
            state_update: { skills_push: [skillEntry], linked_skills_push: [skill_id] },
          }, sid, { timeoutMs: 30_000 });
          phases.push({ phase: "solution_topology", status: "done", added: skill_id });
        } else {
          const solRead = await get(apiPath`/deploy/solutions/${solution_id}/github/read?path=solution.json`, sid);
          const sol = JSON.parse(solRead.content);
          // Add to skills[] if not already present
          if (!sol.skills) sol.skills = [];
          if (!sol.skills.find(s => s.id === skill_id)) {
            sol.skills.push(skillEntry);
          }
          // Add to linked_skills if not already present
          if (!sol.linked_skills) sol.linked_skills = [];
          if (!sol.linked_skills.includes(skill_id)) {
            sol.linked_skills.push(skill_id);
          }
          await post(apiPath`/deploy/solutions/${solution_id}/github/patch`, {
            path: "solution.json",
            content: JSON.stringify(sol, null, 2),
            message: `Add skill "${skill_id}" to solution topology`,
          }, sid, { timeoutMs: 30_000 });
          phases.push({ phase: "solution_topology", status: "done", added: skill_id });
        }
      } catch (err) {
        // Non-fatal: skill.json was written, topology can be fixed manually
        phases.push({ phase: "solution_topology", status: "warning", error: err.message });
        console.warn(`[ateam_patch] Failed to add ${skill_id} to solution topology: ${err.message}`);
      }
    }

    // Phase 4: Redeploy from GitHub (extended timeout — deploys can take 60-120s).
    // Every path that reaches here attempts it (dry_run returned above). If it
    // fails or times out, ok is false and `patch_persisted` says the edit is
    // kept — see "A PATCH THAT DID NOT REBUILD" below.
    let redeployResult;
    try {
      const rdEndpoint = (target === "skill" && skill_id)
        ? apiPath`/deploy/solutions/${solution_id}/skills/${skill_id}/redeploy`
        : apiPath`/deploy/solutions/${solution_id}/redeploy`;
      // Async-first, same as ateam_redeploy: a bulk (solution) redeploy of a
      // many-skill solution takes >100s and 524s on the sync path — the patch
      // then LOOKED like it failed / never reached Core. Kick async + poll;
      // fall back to sync for older backends.
      const kicked = await post(rdEndpoint, { async: true }, sid, { timeoutMs: 30_000 });
      redeployResult = (kicked?.async && kicked.job_id)
        ? await pollDeployJob(kicked.job_id, sid, { label: skill_id ? `redeploy-skill ${skill_id}` : "redeploy-bulk", maxMs: 15 * 60_000, intervalMs: 2000 })
        : kicked;
      // The SAME verdict ateam_redeploy reports. This was its own copy,
      // `ok === false ? "error" : "done"`, so a job that crashed (no ok at all)
      // read as a completed rebuild, and a degraded one as a clean one.
      // `single` for a skill target, as ateam_redeploy passes it: a prod
      // Builder's single-skill job states its reason only in `message`, and
      // without it this phase said nothing about why.
      const rd = redeployVerdict(redeployResult, { single: target === "skill" && Boolean(skill_id) });
      phases.push({
        phase: "redeploy",
        status: rd.failed ? "error" : "done",
        ...(rd.failed && rd.reason && { error: rd.reason }),
        // A REFUSAL carries its code and its way out (the Builder's pre-deploy
        // check: DRIFT_DETECTED, naming the file changed on both sides and how
        // to choose). Only the bare reason used to reach the caller — "Pre-
        // deploy consistency check failed" — with the file and the hint dropped.
        ...(rd.failed && redeployResult?.code && { code: redeployResult.code }),
        ...(rd.failed && redeployResult?.hint && { hint: redeployResult.hint }),
        ...(rd.degraded && { code: "DEPLOYED_WITH_ERRORS", outcome: rd.outcome, ...(rd.reason && { reason: rd.reason }) }),
      });
    } catch (err) {
      // The edit is saved; the rebuild never answered. Not a success — the
      // verdict below says so, with patch_persisted for "nothing was lost".
      phases.push({ phase: "redeploy", status: "timeout_or_error", error: err.message });
      console.warn(`[ateam_patch] Redeploy failed after successful patch: ${err.message}`);
    }

    // Phase 3: Optional re-test
    let test_result;
    if (test_message && skill_id) {
      try {
        await sleep(1000);
        test_result = await post(
          apiPath`/deploy/solutions/${solution_id}/skills/${skill_id}/test`,
          { message: test_message },
          sid,
          { timeoutMs: 90_000 },
        );
        phases.push({ phase: "test", status: "done" });
      } catch (err) {
        test_result = { error: err.message };
        phases.push({ phase: "test", status: "error", error: err.message });
      }
    }

    const redeployOk = phases.some(p => p.phase === "redeploy" && p.status === "done");
    const redeployDegraded = phases.some(p => p.phase === "redeploy" && p.code === "DEPLOYED_WITH_ERRORS");
    const store = isLocal ? "Builder store (local)" : "GitHub";
    // The rebuild RAN either way — the edit is live — so a degraded one keeps
    // ok, but it is not a ✅.
    const redeployedLine = redeployDegraded
      ? `⚠️ Patched on ${store} + redeployed WITH ERRORS — it reached Core but did not come up clean; see redeploy.verification.`
      : `✅ Patched on ${store} + redeployed.`;

    // Widget health — if the redeploy landed and the solution declares UI
    // plugins, verify each renders (Core discovered it + has a render block).
    let widget_health = null;
    if (redeployOk) {
      try {
        widget_health = await verifyWidgetHealth(solution_id, sid);
        if (widget_health) phases.push({ phase: "widget_health", status: widget_health.ok ? "done" : "warn", checked: widget_health.checked });
      } catch { /* advisory — never downgrade a successful patch on the health check */ }
    }

    // Phase 5: validation verdict (skill target only). NON-BLOCKING — "silent is
    // the bug": a patch that leaves the definition invalid used to return ok:true
    // with NO verdict, so an agent (or a persona routing here as the "cheapest
    // correct tool") never saw it went red, and an invalid def slipped toward
    // Core. Report the verdict keyed by skill_id; never block.
    //
    // NOTHING ELSE CHECKS IT EITHER, so say that and no more. f09301b told the
    // caller "build_and_run will refuse to deploy while errors stand". It will
    // not: build_and_run's only gate is POST /validate/solution, which runs the
    // SOLUTION validator (cross-skill contracts, connectors, privileges) and has
    // never run this per-skill check (2db689b onward). A red verdict here and a
    // green deploy are both true at once. error_count can be
    // inflated by auto-imported connector tools (INVALID_TOOL_INPUTS /
    // MISSING_TOOL_OUTPUT fire on every solution because Core resolves their
    // contract at deploy, not the author) — so lead with the author-facing
    // signal: which sections are still incomplete, plus any unresolved refs.
    //
    // THE ROUTE IS /validate. This asked for …/skills/:id/validation from the
    // day it shipped (f09301b). The skill-validator has never served that path
    // — its route is …/skills/:id/validate (2b467c9), which proxies to the
    // Builder's /api/solutions/:id/skills/:id/validation — so every call 404'd
    // into a bare catch, and this verdict never once reached a caller.
    //
    // ADVISORY, SO IT GETS AN ADVISORY BUDGET. The patch is saved and its
    // redeploy has run by now; the request default (120s, 2 retries) could hold
    // that finished result for ~6 minutes, long enough for a client to time out
    // and lose it. The route itself gives up after 15s.
    //
    // AND IT SAYS WHEN IT COULD NOT ANSWER. A verdict that is missing because
    // the check failed must not look like a verdict that was never asked for.
    let validation = null;
    if (target === "skill" && skill_id) {
      try {
        const vr = await get(
          apiPath`/deploy/solutions/${solution_id}/skills/${skill_id}/validate`,
          sid,
          { timeoutMs: 20_000, retries: 0 },
        );
        const v = vr?.validation || vr || {};
        const incomplete_sections = Object.entries(v.sections || {})
          .filter(([, s]) => s && s.complete === false)
          .map(([name]) => name);
        const unresolved = Object.entries(v.unresolved_refs || {}).filter(([, n]) => Number(n) > 0);
        // UNKNOWN IS NOT FALSE. `valid` is read as the Builder states it; a
        // response without it is null, so an absent field can never raise the
        // INVALID banner below, and every reader of `valid` agrees.
        const tri = (x) => (typeof x === "boolean" ? x : null);
        const valid = tri(v.valid);
        validation = {
          skill_id,
          valid,
          ready_to_export: tri(v.ready_to_export),
          error_count: v.error_count ?? null,
          warning_count: v.warning_count ?? null,
          ...(incomplete_sections.length && { incomplete_sections }),
          ...(unresolved.length && { unresolved_refs: Object.fromEntries(unresolved) }),
          ...(v.error_count > 0 && {
            _note: `error_count can include auto-import connector-tool artifacts — INVALID_TOOL_INPUTS / MISSING_TOOL_OUTPUT fire on every solution because Core resolves an auto-imported tool's contract at deploy, not the author. Act on incomplete_sections${unresolved.length ? " + unresolved_refs" : ""} first.`,
          }),
          // What happened to the patch is stated as it happened: "redeployed"
          // only when the redeploy phase says so.
          ...(valid === false && {
            _verdict: `Skill "${skill_id}" is INVALID — the patch was still saved${redeployOk ? " and redeployed" : " (its redeploy did not complete — see phases)"} (non-blocking). build_and_run does not run this check (its gate is the solution validator), so it will not stop on it either: fix the above yourself, then re-check.`,
          }),
        };
        phases.push({ phase: "validation", status: "done" });
      } catch (err) {
        // Still advisory: the saved patch is not downgraded. But the reason is
        // kept, with the status that tells a missing route from a slow one.
        phases.push({
          phase: "validation",
          status: "unavailable",
          ...(err?.status && { http_status: err.status }),
          error: String(err?.message || err).slice(0, 500),
        });
        console.warn(`[ateam_patch] Validation verdict unavailable for ${skill_id}: ${err?.message || err}`);
      }
    }
    const validationStatus = (validation && validation.valid === false)
      ? ` ⚠️ Skill "${skill_id}" is INVALID (${validation.error_count ?? "?"} error(s)) — see validation (advisory: neither this patch nor build_and_run blocks on it).`
      : "";

    // A PATCH THAT DID NOT REBUILD IS NOT A SUCCESSFUL PATCH.
    //
    // This returned ok:true whenever the write landed, even if the redeploy
    // failed or timed out, on the reasoning that the edit "is not lost". The
    // edit genuinely is not lost — but ok:true is not where that belongs.
    //
    // Changing skill.connectors[] makes the connector-derived half of tools[]
    // STALE, and only the redeploy rebuilds it. So a green patch with a failed
    // redeploy hands back exactly the state this whole fix exists to prevent: a
    // skill whose declarations say one thing and whose generated tools still
    // say another, reported as done. The caller stops, because it was told it
    // succeeded.
    //
    // ok now reflects the LIFECYCLE — update, rebuild, validate, redeploy —
    // and `patch_persisted` carries the "nothing was lost" fact as a field,
    // where a caller can act on it, instead of as a lie in the status.
    //
    // It is redeployOk and nothing else. It was `redeployResult === undefined ?
    // true : redeployOk` (daf254a), on the idea that undefined meant "no
    // redeploy attempted" (dry_run). But dry_run returns long before this line,
    // so undefined only ever meant the redeploy THREW — a timeout, a 5xx, a
    // dropped socket — and exactly the failure this block exists to report came
    // back ok:true.
    const lifecycleOk = redeployOk;
    // The redeploy was REFUSED (it carries a hint), not merely unfinished: a
    // retry of ateam_redeploy is refused the same way until the caller acts.
    const refused = phases.find((p) => p.phase === "redeploy" && p.status === "error" && p.hint);

    return {
      ok: lifecycleOk,
      ...(!lifecycleOk && {
        patch_persisted: true,
        phase: "redeploy",
        error: refused
          ? `The edit was saved to ${store}, but the redeploy was REFUSED${refused.code ? ` (${refused.code})` : ""}: ` +
            `${asSentence(refused.error || "the Builder refused it")} Nothing is lost — the definition is stored. ` +
            `Core still runs the previous deploy. ${refused.hint}`
          : `The edit was saved to ${store} but the redeploy did not complete, so the skill's ` +
            `connector-derived tools were NOT rebuilt. Nothing is lost and nothing needs re-patching — ` +
            `the definition is stored. Finish it with ateam_redeploy(solution_id` +
            (skill_id ? `, skill_id: "${skill_id}"` : "") + `). Until then Builder and Core disagree ` +
            `about this skill's tools.`,
        ...(refused && { hint: refused.hint, ...(refused.code && { code: refused.code }) }),
      }),
      solution_id,
      source: isLocal ? "local" : "github",
      ...(degradedToLocal && {
        degraded_to_local: true,
        _degrade_note: `GitHub isn't connected for this tenant, so this patch was saved to the Builder store only (the edit succeeded). It will be pushed to GitHub automatically once the tenant connects a repo (Tenant Admin → GitHub). GitHub-native actions (promote, connector-source patch, github-sourced deploy) will refuse until then.`,
      }),
      ...(isLocal ? {} : {
        branch: writeBranch,
        // Be explicit: a github write lands on `dev`, not prod. The change is
        // NOT on `main` until an explicit ateam_github_promote(dev→main).
        ...(writeBranch !== "main" && { _branch_note: `Committed to "${writeBranch}" (not main). Run ateam_github_promote(solution_id) to ship dev→main; otherwise a future build_and_run(main) won't include this.` }),
      }),
      phases,
      // The full patched definition can be 10s of KB and pushes the rest of the
      // result (redeploy status, widget_health) past the ~50KB output ceiling,
      // truncating it. Return a compact summary by default; pass
      // include_definition:true for the whole thing.
      ...(include_definition
        ? { patched }
        : { patched_summary: _summarizeDef(patched) }),
      _diff,
      ...(_connectorToolPush && {
        _connector_tool_hint:
          `Heads up: ${_connectorToolPush.join(", ")} look like CONNECTOR-served tools. A skill gains a connector's tools by LINKING the connector — updates:{ "connectors_push": ["<connector-id>"] } — NOT by pushing a definition into tools[]; Core auto-imports the connector's live tools at deploy. tools_push is only for the skill's OWN tool definitions.`,
      }),
      ...(isNewSkill && { created_skill: skill_id }),
      ...(redeployResult && { redeploy: redeployResult }),
      ...(validation && { validation }),
      ...(widget_health && { widget_health }),
      ...(test_result && { test_result }),
      _status: (redeployOk
        ? (widget_health && !widget_health.ok
            ? `${redeployedLine} ⚠️ ${widget_health.issues?.length || 0} widget(s) not rendering — see widget_health.`
            : redeployedLine)
        : refused
          ? `⚠️ Patched on ${store} ✅ but the redeploy was REFUSED${refused.code ? ` (${refused.code})` : ''} — see error and hint.`
          : `⚠️ Patched on ${store} ✅ but the redeploy did NOT complete, so connector-derived tools were not rebuilt — Builder and Core disagree until you run: ateam_redeploy(solution_id` + (skill_id ? `, skill_id: "${skill_id}"` : '') + ')') + validationStatus,
      _next: isLocal
        ? 'Local edit saved + redeployed. When the tenant connects a GitHub repo, the local state is pushed → GitHub (which then becomes master).'
        : 'Your changes are on `dev`. They are NOT in production until you promote: ateam_github_promote(solution_id) merges dev → main (dry_run:true to preview), then ateam_build_and_run to deploy.',
    };
  },

  // ─── Original handlers (unchanged) ────────────────────────────────

  // Validation is a read over POST: declared idempotent, so a transport failure
  // may still be re-sent (api.js mayAutoRetry).
  ateam_validate_skill: async ({ skill }, sid) => post("/validate/skill", { skill }, sid, { idempotent: true }),

  ateam_validate_solution: async ({ solution, skills, connectors, mcp_store }, sid) =>
    post("/validate/solution", { solution, skills, connectors, mcp_store }, sid, { idempotent: true }),

  // solution.id is checked before the deploy, as in ateam_build_and_run.
  ateam_deploy_solution: async ({ solution, skills, connectors, mcp_store }, sid) => {
    pathSeg(solution?.id);
    return post("/deploy/solution", { solution, skills, connectors, mcp_store }, sid);
  },

  ateam_deploy_skill: async ({ solution_id, skill }, sid) =>
    post(apiPath`/deploy/solutions/${solution_id}/skills`, { skill }, sid),

  ateam_deploy_connector: async ({ connector }, sid) =>
    post("/deploy/connector", { connector }, sid),

  ateam_upload_connector_files: async ({ connector_id, files }, sid) => {
    // A MISSING ARGUMENT MUST NAME ITSELF. Omitting `files` crashed with
    // "files is not iterable" — a stack-trace phrase that names a JS type
    // problem, not the thing the caller has to change, and it reads like the
    // tool is broken rather than the call. Same for a non-array.
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error(
        `ateam_upload_connector_files needs files: an ARRAY of { path, content } (content_base64 or url also accepted). ` +
        `Got ${files === undefined ? "nothing" : JSON.stringify(files).slice(0, 60)}. ` +
        `To upload a connector already in the repo, use ateam_upload_connector(connector_id, github:true) instead.`,
      );
    }
    if (!connector_id) throw new Error("ateam_upload_connector_files needs connector_id — the connector these files belong to.");
    // Resolve content_base64 and url into plain content before sending to backend
    const resolved = [];
    for (const file of files) {
      if (!file.path) continue;
      let content = file.content;
      if (!content && file.content_base64) {
        content = Buffer.from(file.content_base64, "base64").toString("utf-8");
      }
      if (!content && file.url) {
        const resp = await fetch(file.url);
        if (!resp.ok) throw new Error(`Failed to fetch ${file.url}: ${resp.status}`);
        content = await resp.text();
      }
      if (content === undefined || content === null) {
        throw new Error(`File "${file.path}": provide one of content, content_base64, or url`);
      }
      resolved.push({ path: file.path, content });
    }
    return post(apiPath`/deploy/mcp-store/${connector_id}`, { files: resolved }, sid);
  },

  ateam_list_solutions: async (_args, sid) => {
    const raw = await get("/deploy/solutions", sid);
    // Enrich each solution with GitHub metadata (repo_url, branch, CLAUDE.md)
    // so an agent sees everything it needs to clone + onboard in one call.
    // Fetches run in parallel; failures are non-fatal (fall back to the raw row).
    const solutions = Array.isArray(raw?.solutions) ? raw.solutions : Array.isArray(raw) ? raw : [];
    const enriched = await Promise.all(solutions.map(async (s) => {
      const out = { ...s };
      try {
        const gh = await get(apiPath`/deploy/solutions/${s.id}/github/status`, sid);
        if (gh?.exists && gh.repo_url) {
          out.repo_url = gh.repo_url;
          out.github_full_name = gh.full_name || null;
          out.default_branch = gh.default_branch || "main";
          out.latest_commit_sha = gh.latest_commit?.sha || null;
          // Probe for agent-onboarding doc; swallow 404 etc.
          try {
            const probe = await get(apiPath`/deploy/solutions/${s.id}/github/read?path=CLAUDE.md`, sid);
            out.has_claude_md = Boolean(probe?.content);
          } catch { out.has_claude_md = false; }
          out.local_dev_quickstart = {
            _note: "Share these 3 lines with a developer (or their agent). They will clone the repo and, if CLAUDE.md is present, their agent sees the full onboarding on session start.",
            clone: `git clone ${gh.repo_url}`,
            cd: `cd ${(gh.full_name || "").split("/").pop() || s.id}`,
            // It said `ateam_auth(api_key: "adas_<tenant>_<hex>")` (e75feac):
            // an agent typing a key, in a format bff5934 retired.
            auth_in_new_session: "Call ateam_bootstrap: its `session` field says which workspace the session is on and how to sign in — never with a key in the chat.",
            needs_github_collaborator_access: !gh.repo_url.includes("public") ? true : false,
          };
        }
      } catch { /* non-fatal — leave the row as-is */ }
      return out;
    }));
    return { ...raw, solutions: enriched };
  },

  ateam_get_solution: async ({ solution_id, view, skill_id, section, offset, limit }, sid) => {
    const base = apiPath`/deploy/solutions/${solution_id}`;
    const paged = (offset != null || limit != null);
    if (view === "triggers") {
      const result = await solutionTriggers(solution_id, skill_id, sid);
      return paged ? _pageJson(result, offset, limit) : result;
    }
    if (skill_id) {
      const r = await get(apiPath`/deploy/solutions/${solution_id}/skills/${skill_id}`, sid);
      // OPEN-8: a single skill def can be 50KB+ and truncate at the output cap.
      // `section` slices it to one field (dotted paths ok, e.g. intents.supported);
      // offset/limit page the raw bytes — so a big skill is always readable.
      let result = r;
      if (section === "tools") {
        // WHAT THE SKILL CAN DO is what its deploy sends: the Builder's
        // `deployed.tools` — the author's tools AND the ones imported from its
        // connectors (Builder BL-38). skill.json holds the author's tools
        // only, so slicing `skill.tools` answered [] for a skill whose tools
        // all come from its connectors. `authored_tools` is the file's list,
        // the one an edit changes.
        result = toolsSectionOf(r, solution_id, skill_id);
      } else if (section) {
        const skill = r?.skill || r?.definition || r || {};
        const val = String(section).split(".").reduce((o, k) => (o == null ? undefined : o[k]), skill);
        result = {
          ok: true, solution_id, skill_id, section, [section]: val,
          _note: `Sliced to '${section}'. Omit 'section' for the full skill; ateam_show_skill_minimal gives the slim authoring view.`,
        };
      }
      return paged ? _pageJson(result, offset, limit) : result;
    }
    const paths = {
      definition: `${base}/definition`,
      skills: `${base}/skills`,
      health: `${base}/health`,
      status: apiPath`/deploy/status/${solution_id}`,
      export: `${base}/export`,
      validate: `${base}/validate`,
      connectors_health: `${base}/connectors/health`,
    };
    const viewResult = await get(paths[view], sid);
    return paged ? _pageJson(viewResult, offset, limit) : viewResult;
  },

  ateam_update: async ({ solution_id, target, skill_id, updates }, sid) => {
    if (target === "skill") {
      return patch(apiPath`/deploy/solutions/${solution_id}/skills/${skill_id}`, { updates }, sid);
    }
    return patch(apiPath`/deploy/solutions/${solution_id}`, { state_update: updates }, sid);
  },


  ateam_solution_chat: async ({ solution_id, message }, sid) =>
    post(apiPath`/deploy/solutions/${solution_id}/chat`, { message }, sid),

  ateam_test_connector: async ({ solution_id, connector_id, tool, args }, sid) =>
    post(apiPath`/deploy/solutions/${solution_id}/connectors/${connector_id}/call`, { tool, args }, sid, { timeoutMs: 30_000 }),

  // ─── Developer Tools ────────────────────────────────────────────

  ateam_get_execution_logs: async ({ solution_id, skill_id, job_id, chain_id, limit }, sid) => {
    // A CHAIN IS NOT A JOB — DO NOT RESOLVE ONE DOWN TO THE OTHER.
    //
    // Callers hold a chain id (ateam_conversation returns chain_id;
    // ateam_chain_status takes chain_id) while this tool spoke only job_id, the
    // inner id nobody ever sees. The tempting fix — look the chain up in the
    // list and pass its root job on — is WRONG in the direction the system moved:
    // a chain is root job + every handoff + every askAnySkill subcall, so it
    // would return ONE job's trace under the name of the whole chain. A partial
    // trace that calls itself complete is worse than a refusal: it makes the
    // handoff you are hunting look like it never happened.
    //
    // So a chain id goes to the CHAIN endpoint, which returns every job and every
    // step across the whole tree — the actual "what ran". (2026-08-22.)
    if (!job_id && chain_id) {
      const chain = await get(apiPath`/deploy/jobs/${chain_id}/chain`, sid);
      const { jobs, steps } = chainTreeOf(chain);
      return {
        ok: true,
        scope: "chain",
        chain_id,
        solution_id,
        job_count: jobs.length,
        step_count: steps.length,
        jobs,
        steps,
        _note: `FULL CHAIN: ${jobs.length} job(s) — root + handoffs + subcalls — and ${steps.length} tool call(s) across all of them. Each step carries _skill/_jobId/_depth/_relation so you can see WHICH skill made it. For one job alone, pass job_id.`,
      };
    }

    const qs = new URLSearchParams();
    if (skill_id) qs.set("skill_id", skill_id);
    if (job_id) qs.set("job_id", job_id);
    // actor_id is NOT set here. It rides X-ADAS-ACTOR-ID for every tool, from
    // the session (api.js headers/touchSession) — this tool having its own
    // private path was how the other five ended up with none at all.
    if (limit) qs.set("limit", String(limit));
    const qsStr = qs.toString() ? `?${qs}` : "";
    return get(apiPath`/deploy/solutions/${solution_id}/logs${rawQuery(qsStr)}`, sid);
  },

  ateam_conversation: async ({ solution_id, message, actor_id, attachments, wait, timeout_ms }, sid) => {
    // ALWAYS async on the wire. A conversation can run for minutes (auto-route
    // → worker → sub-skills), and a synchronous hold would blow past the 100s
    // Cloudflare edge limit → 524. So we kick off, return the chain id (job_id)
    // immediately, and the caller polls a SLIM status. `wait`/`timeout_ms` are
    // accepted for back-compat but no longer hold the HTTP request open.
    // Files go as dev-app sends them (src/testAttachments.js), checked before any request.
    const files = await prepareTestAttachments(attachments);
    const body = { message, async: true, ...(actor_id ? { actor_id } : {}), ...(files ? { attachments: files } : {}) };
    const kickoff = await post(apiPath`/deploy/solutions/${solution_id}/test`, body, sid, { timeoutMs: 15_000 });
    // The CHAIN id — not a single job id — is the conversation's identity and
    // what you poll. The Builder returns it as chain_id (falls back to the
    // root job id only if an older Builder didn't send one).
    const chainId = kickoff?.chain_id || kickoff?.chainId || kickoff?.job_id || kickoff?.jobId || null;
    return {
      ...kickoff,
      chain_id: chainId,
      _poll: chainId
        ? {
            _note: "Conversation started (async). The reply is NOT in this response — poll the CHAIN for it.",
            slim: `ateam_chain_status(chain_id: "${chainId}")  → cheap chip-quick poll; loop ~2s until chain_done===true (whole chain terminal, not just one job). Then read result.`,
            waiting_on_the_user: WAITING_ON_THE_USER,
            full: `ateam_get_chain(job_id: "${chainId}")  → full tree + per-job detail (heavier; use once, not in a poll loop)`,
            // It said "ateam_conversation(actor_id: …) to continue the thread"
            // (a793b34): actor_id continues nothing (CONVERSATION_CONTINUES).
            continue: "ateam_conversation(solution_id, message). " + CONVERSATION_CONTINUES + " " + REPLY_WINDOW,
            // The Builder's ran_as rides in ...kickoff above; point at what it
            // means, so an agent reads WHO the job ran as and not only the thread.
            who_it_ran_as: TEST_RUNS_AS_AT,
          }
        : undefined,
    };
  },

  ateam_connector_logs: async ({ solution_id, connector_id, since, limit, errors_only }, sid) => {
    if (!solution_id) throw new Error("solution_id required");
    if (!connector_id) throw new Error("connector_id required");
    const qs = new URLSearchParams();
    if (since) qs.set("since", String(since));
    if (limit) qs.set("limit", String(limit));
    if (errors_only === true) qs.set("errors_only", "true");
    const qsStr = qs.toString() ? `?${qs}` : "";
    return get(
      apiPath`/deploy/solutions/${solution_id}/connectors/${connector_id}/logs${rawQuery(qsStr)}`,
      sid
    );
  },

  ateam_verify_surface: async ({ solution_id, plugin_id, expect, actor_id }, sid) => {
    if (!solution_id) return { ok: false, error: "solution_id required" };
    if (!plugin_id) return { ok: false, error: "plugin_id required" };
    const body = {};
    if (expect) body.expect = expect;
    if (actor_id) body.actor_id = actor_id;
    // Forwards to the skill-validator, which runs Core's ui.surfaceProbe via /mcp.
    // 60s: navigate + settle + warm-retry inside Core, plus the hop — ONE
    // attempt. The warm-retry already happens inside Core. request()'s default
    // retries:2 made it up to three probes and ~195s (60+5+60+10+60): every
    // retry of a timeout or a 502/504 starts another headless-browser run, and
    // aborting our fetch does not stop the one already running in Core.
    try {
      return await post(
        apiPath`/deploy/solutions/${solution_id}/plugins/${plugin_id}/verify-surface`,
        body, sid, { timeoutMs: 60000, retries: 0 }
      );
    } catch (err) {
      // A FAILING surface is this tool's whole job, not a transport error. The
      // route maps a negative verdict to 422 (503 for inconclusive), which the
      // generic error path turned into "returned 422" — hiding the failures that
      // say WHY the screen is broken, and leaving the caller as blind as before
      // it ran the probe. Hand the verdict back as a result instead of throwing.
      //
      // Only "surface_failed" is that answer: the probe rendered the surface and
      // found it broken. Core's other negative verdicts (ui.surfaceProbe) say the
      // probe never got that far — "inconclusive" (browser-mcp unavailable; fail-
      // closed, it cannot certify), "no_probe" (the harness never installed),
      // "misconfigured" (no probe ticket), "bad_input" / "forbidden" (Core refused
      // the call). Those are failed calls, and a verdict tool says so in `error`
      // (mcpFailure.isLogicalFailure) — none of them carries one.
      const parsed = jsonBodyOf(err?.body);
      if (parsed && (parsed.verdict || Array.isArray(parsed.failures))) {
        if (parsed.verdict !== "surface_failed" && parsed.error == null) {
          const why = Array.isArray(parsed.failures) && parsed.failures.length ? `: ${parsed.failures.join("; ")}` : "";
          parsed.error = `the surface probe did not run (verdict ${parsed.verdict || "none"})${why}`;
        }
        return parsed;
      }
      throw err;
    }
  },

  ateam_test_skill: async ({ solution_id, skill_id, message, wait, wait_for, chain_timeout_ms, actor_id, attachments }, sid) => {
    // Resolve wait mode. Priority: wait_for (new explicit form) > wait (legacy).
    // wait:false  → "never"   (return job_id, no polling)
    // wait:true   → "root"    (poll root job to completion — current default)
    // wait_for set → use as-is (may also be "chain")
    let resolvedWait = wait_for || (wait === false ? "never" : "root");
    if (!["root", "chain", "never"].includes(resolvedWait)) {
      throw new Error(`Invalid wait_for: ${JSON.stringify(resolvedWait)}. Must be "root", "chain", or "never".`);
    }

    // Kick off the test (always async on the wire so the Builder doesn't time
    // out on long-running chains). When wait_for:"root" we then poll the
    // single-job status; when wait_for:"chain" we poll the chain tree until
    // every job is terminal; when wait_for:"never" we return the job_id and
    // caller polls themselves.
    const isWireAsync = resolvedWait !== "root";
    // Files go as dev-app sends them (src/testAttachments.js), checked before any request.
    const files = await prepareTestAttachments(attachments);
    const body = { message, ...(isWireAsync ? { async: true } : {}), ...(actor_id ? { actor_id } : {}), ...(files ? { attachments: files } : {}) };
    const kickoffTimeoutMs = isWireAsync ? 15_000 : 90_000;
    const kickoff = await post(apiPath`/deploy/solutions/${solution_id}/skills/${skill_id}/test`, body, sid, { timeoutMs: kickoffTimeoutMs });

    if (resolvedWait === "never" || resolvedWait === "root") {
      // Back-compat path: kickoff response is the same shape callers see today.
      return kickoff;
    }

    // wait_for:"chain" — poll the chain tree until every job is terminal.
    const rootJobId = kickoff?.job_id || kickoff?.jobId;
    if (!rootJobId) {
      // Builder returned no job_id — surface kickoff so caller can debug.
      return { ok: false, error: "ateam_test_skill (wait_for:'chain'): kickoff response has no job_id", kickoff };
    }

    const POLL_MIN_MS = 10_000;
    const POLL_MAX_MS = 900_000;
    const totalTimeoutMs = Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, Number(chain_timeout_ms) || 300_000));
    const POLL_INTERVAL_MS = 2_000;
    const startedAt = Date.now();

    const creds = getCredentials(sid);
    const apiKey = creds?.apiKey;
    if (!apiKey) throw new Error("No api_key in session — call ateam_auth(api_key) first.");
    const coreUrl = process.env.ADAS_CORE_URL || "http://adas-backend:4000";

    const isTerminal = (status) => status === "done" || status === "completed" || status === "error" || status === "failed" || status === "aborted";

    let lastChain = null;
    while (Date.now() - startedAt < totalTimeoutMs) {
      const qs = new URLSearchParams();
      qs.set("skillSlug", skill_id);
      // Builder proxy, not ADAS_CORE_URL (docker-internal; see ateam_chain_status).
      const data = await get(apiPath`/deploy/jobs/${rootJobId}/chain?${rawQuery(qs)}`, sid)
        .catch(err => ({ ok: false, error: err.message }));
      lastChain = data;
      const jobs = Array.isArray(data?.chainJobsList) ? data.chainJobsList : Array.isArray(data?.chainJobs) ? data.chainJobs : null;
      if (jobs && jobs.length > 0 && jobs.every(j => isTerminal(j.status))) {
        return { ok: true, job_id: rootJobId, wait_for: "chain", chain: data, kickoff, elapsed_ms: Date.now() - startedAt };
      }
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
    return {
      ok: false,
      error: `Chain wait timed out after ${totalTimeoutMs}ms — some jobs are still running. Increase chain_timeout_ms or poll manually via ateam_test_status(include_chain:true).`,
      job_id: rootJobId,
      wait_for: "chain",
      chain: lastChain,
      kickoff,
      elapsed_ms: Date.now() - startedAt,
    };
  },

  ateam_test_notification: async ({ solution_id, actor_id, content, urgency, source, metadata, reply_handler, ...rest }, sid) => {
    if (!solution_id) throw new Error("solution_id required");
    if (!actor_id) throw new Error("actor_id required");
    if (!content || typeof content !== "string") throw new Error("content required (string)");

    // v1: reply_handler is intentionally NOT supported (privilege-escalation
    // surface — caller could route user's next reply to any skill with
    // arbitrary context). Reject the field rather than silently dropping it,
    // so callers know to stop relying on it. v2 will add allowlist + schema.
    if (reply_handler !== undefined) {
      throw new Error("reply_handler is not supported in v1 of ateam_test_notification (security: caller-supplied skill + context = privilege escalation). v2 will add a tenant skill allowlist + context schema. For routing/engagement tests, use ateam_test_skill instead.");
    }
    // Defense-in-depth: also reject any unknown field that might smuggle a
    // reply_handler via case variants or aliases.
    for (const k of Object.keys(rest || {})) {
      if (/reply/i.test(k) || /handler/i.test(k)) {
        throw new Error(`Unsupported field "${k}" in ateam_test_notification (likely a reply_handler alias — see v1 safety note).`);
      }
    }

    // Rate limit: 10 calls / minute / session. In-memory; bounded leak fine
    // for a test tool. Survives until process restart, which is acceptable
    // (the bound is per-session, not per-tenant).
    const RATE_LIMIT = 10;
    const RATE_WINDOW_MS = 60_000;
    if (!globalThis.__notifyRateLimit) globalThis.__notifyRateLimit = new Map();
    const bucket = globalThis.__notifyRateLimit;
    const now = Date.now();
    const entry = bucket.get(sid) || { times: [] };
    entry.times = entry.times.filter(t => now - t < RATE_WINDOW_MS);
    if (entry.times.length >= RATE_LIMIT) {
      const waitMs = RATE_WINDOW_MS - (now - entry.times[0]);
      throw new Error(`Rate limited: max ${RATE_LIMIT} ateam_test_notification calls per minute per session. Retry in ${Math.ceil(waitMs / 1000)}s.`);
    }
    entry.times.push(now);
    bucket.set(sid, entry);

    // Forward the caller's authed api_key to Core. Tenant scoping is
    // enforced by the key itself (Core's attachActor parses the tenant out
    // of adas_<tenant>_<hex> and pins req.tenant). This removes the need
    // for the MCP server to hold CORE_MCP_SECRET for this tool — the
    // caller's own credential is what authorizes the action.
    const creds = getCredentials(sid);
    const tenant = creds?.tenant;
    const apiKey = creds?.apiKey;
    if (!tenant || !apiKey) {
      // It said `call ateam_auth(api_key: "adas_<tenant>_<hex>") first`
      // (e65a5d9): an agent typing a key, in a retired format.
      throw new Error("This session holds no workspace API key: ateam_test_notification needs a session signed in with a workspace's key (a master key is not supported for this tool). ateam_bootstrap's `session` field says how this session signs in.");
    }

    const coreUrl = process.env.ADAS_CORE_URL || "http://adas-backend:4000";

    // Force [TEST] prefix on the user-visible content. Anti-phishing rail:
    // even if a tenant admin api key were misused, the recipient sees
    // [TEST] on the actual message — they can't be fooled into thinking
    // it's a system-initiated production notification.
    const safeContent = content.startsWith("[TEST]") ? content : `[TEST] ${content}`;

    // Audit log (cheap — console). Replace with structured audit when one exists.
    const contentHash = (await import("node:crypto")).createHash("sha256").update(content).digest("hex").slice(0, 12);
    console.log(JSON.stringify({
      audit: "ateam_test_notification",
      tenant,
      solution_id,
      actor_id,
      caller_session: sid?.slice(0, 8),
      content_preview: content.slice(0, 60),
      content_hash: contentHash,
      urgency: urgency || "normal",
      at: new Date().toISOString(),
    }));

    const body = {
      actorId: actor_id,
      content: safeContent,
      urgency: urgency || "normal",
      metadata: { ...(metadata || {}), source: source || "ateam-test", _test: true },
    };

    const res = await fetch(`${coreUrl}/api/internal/notify-user`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // api-key auth — tenant pinned by Core's attachActor from the key itself.
        "x-api-key": apiKey,
        "X-ADAS-SERVICE": "ateam-mcp.test_notification",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { ok: false, error: text.slice(0, 400) }; }

    if (!res.ok) {
      // Surface Core's actual reason — "actor not found in tenant" is the
      // most common (caller mistyped the actor_id), 502 = notif-router down.
      throw new Error(`Core /api/internal/notify-user returned ${res.status}: ${data.error || JSON.stringify(data).slice(0, 200)}`);
    }

    return {
      ok: true,
      tenant,
      actor_id,
      dispatchId: data.dispatchId || null,
      notification_id: data.dispatchId || null, // alias matching the spec
      results: data.results || [],
      content_preview: safeContent.slice(0, 80),
    };
  },

  ateam_test_pipeline: async ({ solution_id, skill_id, message }, sid) => {
    // NEVER INTERPOLATE undefined INTO A PATH. Omitting skill_id produced a
    // request to /skills/undefined/test-pipeline, so the server answered about
    // a skill literally named "undefined" — the caller then hunts a routing
    // problem instead of reading "you forgot skill_id".
    if (!skill_id) {
      throw new Error(
        `ateam_test_pipeline needs skill_id — it tests ONE skill's intent pipeline. ` +
        `List them with ateam_get_solution(view:"skills"). To send a message without choosing a skill, use ateam_conversation (it auto-routes).`,
      );
    }
    if (!message) throw new Error("ateam_test_pipeline needs message — the utterance to run through the pipeline.");
    return post(apiPath`/deploy/solutions/${solution_id}/skills/${skill_id}/test-pipeline`, { message }, sid, { timeoutMs: 30_000 });
  },

  ateam_test_voice: async ({ solution_id, messages, phone_number, skill_slug, timeout_ms }, sid) => {
    // Without this, omitting `messages` died on messages.length with
    // "Cannot read properties of undefined (reading 'length')" — an internal
    // crash where the caller needed one sentence about the argument. Note it
    // is messageS (a turn array), which is easy to miss next to every other
    // test tool taking a single `message`.
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error(
        `ateam_test_voice needs messages: an ARRAY of caller turns, e.g. ["book me an appointment", "tomorrow at 3"]. ` +
        `Got ${messages === undefined ? "nothing" : JSON.stringify(messages).slice(0, 60)}. ` +
        `(It is "messages", plural — unlike ateam_test_skill/ateam_conversation, which take a single message.)`,
      );
    }
    const body = { messages };
    if (phone_number) body.phone_number = phone_number;
    if (skill_slug) body.skill_slug = skill_slug;
    if (timeout_ms) body.timeout_ms = timeout_ms;
    // Timeout scales with message count — each turn may invoke skills
    const perTurnMs = timeout_ms || 60_000;
    const timeoutTotal = Math.min(perTurnMs * messages.length + 30_000, 600_000);
    return post(`/deploy/voice-test`, body, sid, { timeoutMs: timeoutTotal });
  },

  ateam_test_status: async ({ solution_id, skill_id, job_id, chain_id, include_chain }, sid) => {
    // Given a CHAIN id, answer about the chain. The per-skill test endpoint below
    // is per-job and needs a skill — neither of which a caller holding a chain id
    // has. Routing a chain id there would report the root job's status as if it
    // were the run's, and a root can be "completed" while a handoff is still
    // going. Whole-chain status is what "is it done?" actually means.
    if (chain_id && !job_id) {
      const data = await get(apiPath`/deploy/jobs/${chain_id}/status`, sid);
      return { ok: true, scope: "chain", chain_id, ...data };
    }

    if (!job_id) {
      throw new Error("Pass chain_id (the whole run — recommended) or job_id. ateam_conversation returns chain_id.");
    }
    if (!skill_id) {
      // ASK FOR NOTHING THE TOOL CAN WORK OUT ITSELF. This used to throw
      // "job_id needs skill_id too — pass chain_id instead". The message was
      // accurate and well-written, and it was reached by FAILING FIRST, every
      // time: 4 occurrences on 4 different job ids in a single clean e2e, each
      // one a wasted turn. A good error still costs a round trip.
      //
      // /deploy/jobs/:id/status resolves ANY job id — it is the same endpoint
      // the chain path above already uses — so a job id without a skill needs no
      // skill at all. `scope` says which question was answered, because "this
      // job" and "the whole run" genuinely differ: a root job can read completed
      // while a handoff is still running.
      const data = await get(apiPath`/deploy/jobs/${job_id}/status`, sid);
      return {
        ok: true,
        scope: "job",
        job_id,
        ...data,
        _note: `Answered for THIS JOB. For the whole run — including handoffs a root job does not cover — pass chain_id instead${data?.chainId ? ` (this job's chain is "${data.chainId}")` : ""}.`,
      };
    }
    // Existing single-job snapshot via Builder (unchanged shape for back-compat).
    const single = await get(apiPath`/deploy/solutions/${solution_id}/skills/${skill_id}/test/${job_id}`, sid);
    if (!include_chain) return single;

    // Caller asked for the chain tree too. Fetch via Core's /api/job/:id/chain
    // and merge under response.chain. Single-job fields stay at the top level.
    const creds = getCredentials(sid);
    const apiKey = creds?.apiKey;
    if (!apiKey) return { ...single, chain: { ok: false, error: "include_chain requires api-key auth (call ateam_auth)" } };
    const qs = new URLSearchParams();
    if (skill_id) qs.set("skillSlug", skill_id);
    // Builder proxy, not ADAS_CORE_URL (docker-internal; see ateam_chain_status).
    const chain = await get(apiPath`/deploy/jobs/${job_id}/chain?${rawQuery(qs)}`, sid)
      .catch(err => ({ ok: false, error: err.message }));
    return { ...single, chain };
  },

  ateam_get_chain: async ({ chain_id, job_id, skill_slug }, sid) => {
    // CHAIN IS THE UNIT. Core resolves either id to the same chain (it walks up
    // to the root), so the tool takes the id the caller actually holds — the
    // chain id from ateam_conversation — and treats job_id as an alias for the
    // rarer case of holding an inner id. Same `chain_id || job_id` shape as
    // ateam_chain_status, so the two poll/inspect tools take the same argument.
    const id = chain_id || job_id;
    if (!id) throw new Error("chain_id required (job_id accepted as an alias)");
    const creds = getCredentials(sid);
    const apiKey = creds?.apiKey;
    if (!apiKey) throw new Error("No api_key in session — call ateam_auth(api_key) first.");
    // Via the Builder proxy (see ateam_chain_status) — Core's hostname is
    // docker-internal and unreachable from a desktop/laptop MCP process.
    const qs = new URLSearchParams();
    if (skill_slug) qs.set("skillSlug", skill_slug);
    const suffix = qs.toString() ? `?${qs}` : "";
    return await get(apiPath`/deploy/jobs/${id}/chain${rawQuery(suffix)}`, sid);
  },

  // SLIM chain status — the chip-quick poll. Hits Core /api/job/:id/status
  // (slimJob), which returns the WHOLE-CHAIN aggregate `chainStatus`/`chainDone`
  // (computeChainStatus over chainId) alongside the single-job status. This is
  // the right thing to poll on a loop after ateam_conversation: a single job
  // can terminate while the chain is still active — chainDone only flips when
  // the CHAIN is done. Cheap enough for periodic polling (no full tree).
  ateam_chain_status: async ({ chain_id, job_id }, sid) => {
    const id = chain_id || job_id;
    if (!id) throw new Error("chain_id required (job_id accepted as an alias)");
    // Routed through the BUILDER proxy (/deploy/jobs/:id/status), not
    // ADAS_CORE_URL directly. Core is the only holder of job state, but its
    // hostname is docker-internal — every laptop MCP session got a bare "fetch
    // failed" that read as "job not found" (2026-08-15: a full day spent reading
    // Mongo by hand to answer "is this run alive?"). Same reason ateam_verify
    // proxies. `get()` also carries the session's auth/tenant headers.
    const data = await get(apiPath`/deploy/jobs/${id}/status`, sid);
    // LAST ACTIVITY — the running-vs-corpse discriminator. `status:"running"` is
    // true for a healthy build AND a dead one; the only way to tell them apart
    // was querying llm_traces for the newest timestamp. Core bumps job.lastUpdate
    // in the same setStatus() call that writes job.subStatus, so the timestamp
    // and "what it was doing" move together — one cheap read, no tree walk, so
    // this stays safe to poll. idle_seconds alone needs interpreting (a live
    // build can sit minutes inside one provider call), which is why
    // activity_source ships with it: "idle 180s — in provider call" is a state
    // you can act on; "idle 180s" is a number you have to guess about.
    const lastActivityAt = data.lastUpdate ?? data.last_update ?? null;
    const idleSeconds = lastActivityAt
      ? Math.max(0, Math.round((Date.now() - new Date(lastActivityAt).getTime()) / 1000))
      : null;
    // Surface the chain-aggregate truth as the primary fields; keep the raw
    // slim job under `job` for callers that want per-job detail.
    return {
      chain_id: data.chainId || id,
      chain_status: data.chainStatus ?? data.status ?? null,
      chain_done: data.chainDone ?? data.done ?? null,
      pending_question: data.pendingQuestion || null,
      result: data.result ?? null,
      progress: data.progress || null,
      last_activity_at: lastActivityAt,
      idle_seconds: idleSeconds,
      activity_source: data.subStatus || null,
      job: data,
    };
  },

  ateam_get_widget_catalog: async ({ origin, format, solution_id }, sid) => {
    // Wraps Core's GET /api/ui-plugins (merged tenant plugin list) and enriches
    // each entry with the documentation/how-to-use layer. Filtering by origin
    // and the summary/full projection happen client-side here.
    //
    // Reaches the catalog through the Builder proxy (/deploy/.../ui-plugins) on
    // the normal base URL — reliable from any connection. (The old direct
    // ADAS_CORE_URL fetch "fetch failed" from remote/desktop MCP connections.)
    // solution_id is optional (one tenant = one solution): auto-resolve the
    // tenant's solution when omitted, per the doc — don't hard-error.
    let sol = solution_id;
    if (!sol) {
      const list = await get(`/deploy/solutions`, sid).catch((e) => { throw new Error(`solution_id omitted and could not list the tenant's solutions to auto-resolve: ${e.message}`); });
      const sols = Array.isArray(list?.solutions) ? list.solutions : [];
      if (sols.length === 1) sol = sols[0]?.id || sols[0];
      else if (sols.length === 0) throw new Error("solution_id omitted and this tenant has no solutions yet.");
      else throw new Error(`solution_id omitted and this tenant has multiple solutions (${sols.map((s) => s?.id || s).join(", ")}) — pass solution_id explicitly.`);
    }
    const data = await get(apiPath`/deploy/solutions/${sol}/ui-plugins`, sid);
    if (data?.ok === false) {
      throw new Error(`widget catalog unavailable: ${data.error || "unknown"}`);
    }

    // Project each plugin into the catalog shape with how_to_use guidance.
    const plugins = Array.isArray(data?.plugins) ? data.plugins : [];
    const wantSummary = format === "summary";
    const filterOrigin = origin && origin !== "all" ? origin : null;

    const widgets = plugins.map((p) => {
      const id = p?.id || "";
      const shortId = id.split(":").pop() || id;
      // origin classification: platform vs solution vs skill
      const src = p?._source || "";
      const inferredOrigin = src === "mcp_introspection" ? "platform"
        : src === "skill_declared" ? "skill"
        : "solution";
      const opener = Array.isArray(p?.capabilities?.commands) && p.capabilities.commands.length > 0
        ? `ui.${shortId}.${p.capabilities.commands[0].name || "open"}({ /* args per input_schema */ })`
        : `sys.focusUiPlugin({ plugin_id: "${id}" })`;
      const entry = {
        id,
        name: p?.name,
        version: p?.version,
        description: p?.description,
        type: p?.type || "ui",
        origin: inferredOrigin,
        owned_by_connector: p?._connector_id,
        render: p?.render,
        surface: p?.surface,
        capabilities: p?.capabilities,
        channels: p?.channels,
        commands: p?.capabilities?.commands || p?.commands || [],
        uiActions: p?.uiActions,
      };
      if (!wantSummary) {
        entry.how_to_use = {
          solution_json_snippet: { id, name: p?.name, version: p?.version, render: p?.render },
          opener_call: opener,
          persona_phrasing: `When the user wants to view ${(p?.description || p?.name || shortId).toString().toLowerCase()}, call ${opener.split("(")[0]}.`,
          binding_notes: {
            commands_input_schemas: (p?.capabilities?.commands || []).map(c => ({ command: c.name, schema: c.input_schema })),
            deeplink_template: p?.uiActions?.deeplink || null,
            view_entity_kinds: p?.uiActions?.intents?.view_entity?.entity_kinds || null,
            host_auto_routes_intents: Object.keys(p?.uiActions?.intents || {}),
          },
        };
      }
      return entry;
    });

    const filtered = filterOrigin ? widgets.filter(w => w.origin === filterOrigin) : widgets;
    const counts = {
      total: filtered.length,
      platform: filtered.filter(w => w.origin === "platform").length,
      solution: filtered.filter(w => w.origin === "solution").length,
      skill: filtered.filter(w => w.origin === "skill").length,
    };
    return { ok: true, generated_at: new Date().toISOString(), counts, widgets: filtered };
  },

  ateam_test_abort: async ({ solution_id, skill_id, job_id, chain_id }, sid) => {
    // ABORTING THE ROOT DOES NOT ABORT THE RUN. A chain is root + handoffs +
    // subcalls, each its own job; killing the root leaves the handoff running,
    // still burning tokens, still writing — while the caller has been told the
    // test was aborted. So a chain id aborts every job in the chain and REPORTS
    // each one, rather than quietly doing a fraction of what it claims.
    if (chain_id && !job_id) {
      const chain = await get(apiPath`/deploy/jobs/${chain_id}/chain`, sid);
      const { jobs } = chainTreeOf(chain);
      if (!jobs.length) {
        return { ok: false, scope: "chain", chain_id, error: `No jobs found for chain "${chain_id}".`,
                 hint: "The chain may belong to another solution or another actor. ateam_get_execution_logs(chain_id) shows what is visible to you." };
      }
      const aborted = [];
      for (const j of jobs) {
        const slug = j.skill || skill_id;
        try {
          await del(apiPath`/deploy/solutions/${solution_id}/skills/${slug}/test/${j.jobId}`, sid);
          aborted.push({ job_id: j.jobId, skill: slug, relation: j.relation, aborted: true });
        } catch (err) {
          // A job that was ALREADY finished cannot be aborted — that is not a
          // failure of the abort, but it must still be visible.
          aborted.push({ job_id: j.jobId, skill: slug, relation: j.relation, aborted: false, error: err.message });
        }
      }
      return {
        ok: aborted.some((a) => a.aborted),
        scope: "chain",
        chain_id,
        job_count: jobs.length,
        aborted_count: aborted.filter((a) => a.aborted).length,
        jobs: aborted,
      };
    }
    if (!job_id || !skill_id) {
      throw new Error("Pass chain_id to abort the whole run, or job_id + skill_id to abort one job.");
    }
    return del(apiPath`/deploy/solutions/${solution_id}/skills/${skill_id}/test/${job_id}`, sid);
  },

  ateam_get_connector_source: async ({ solution_id, connector_id, path }, sid) => {
    let data;
    try {
      data = await get(apiPath`/deploy/solutions/${solution_id}/connectors/${connector_id}/source`, sid);
    } catch (err) {
      // AUTHORED_SOURCE_MISSING is a real, actionable answer — not a lookup
      // failure. Returning the raw 404 would send a caller hunting for a wrong
      // solution_id, when the true state is "Core may be running this connector
      // and nobody can reproduce it". Say that, and name the two tools that act
      // on it, instead of leaving the agent to improvise a rewrite.
      const parsed = jsonBodyOf(err.body);
      if (err.status === 404 && parsed?.code === "AUTHORED_SOURCE_MISSING") {
        return {
          ok: false,
          code: "AUTHORED_SOURCE_MISSING",
          connector_id,
          error: parsed.error,
          deployed_in_core: parsed.deployed_in_core === true,
          next: parsed.deployed_in_core
            ? [
                `ateam_get_deployed_connector_source(solution_id:'${solution_id}', connector_id:'${connector_id}') — see what Core is actually running`,
                `ateam_recover_connector_source(solution_id:'${solution_id}', connector_id:'${connector_id}') — adopt it as authored source, stamped as recovered`,
              ]
            : [`ateam_create_connector — nothing has been authored for this connector yet`],
          warning: parsed.deployed_in_core
            ? "Do NOT write a replacement from memory. A running connector's code is recoverable; an improvised rewrite silently replaces working code with a guess."
            : undefined,
        };
      }
      throw err;
    }
    const files = Array.isArray(data?.files) ? data.files : [];
    // Provenance travels with every answer. Without it a caller cannot tell the
    // authored store from GitHub — and historically could not tell either from
    // Core's runtime copy, which is how a lost source looked like a present one.
    const prov = {
      provenance: data?.provenance,
      ...(data?.scheme && { scheme: data.scheme }),
      authored_source_of_record: data?.authored_source_of_record !== false,
      // A copy nested under the connector's own repo prefix (connectors/<id>/…
      // inside connector <id>) is left out of `files` by the Builder and named
      // here — it rides every answer, so an agent sees why a path it was given
      // is not in the manifest (CORE review B111-4).
      ...(Array.isArray(data?.nested_copies) && data.nested_copies.length > 0 && {
        nested_copies: data.nested_copies,
        ...(data.nested_copies_note && { nested_copies_note: data.nested_copies_note }),
      }),
    };
    // A whole connector's source easily exceeds the ~50KB tool-output ceiling and
    // truncates (you couldn't read the file you needed). So: no `path` → return a
    // FILE MANIFEST (paths + sizes, no content — small); with `path` → return just
    // that ONE file's content. Targeted, never truncated.
    if (!path) {
      return {
        ok: true,
        connector_id,
        ...prov,
        files: files.map((f) => ({ path: f.path, bytes: (f.content || "").length, encoding: f.encoding || "utf8" })),
        total_bytes: files.reduce((n, f) => n + (f.content || "").length, 0),
        hint: "Large source is not returned inline. Call again with path:'<file>' to read one file (e.g. path:'server.js').",
      };
    }
    const norm = String(path).replace(/^\.?\//, "");
    const file = files.find((f) => f.path === path || f.path === norm || f.path.replace(/^\.?\//, "") === norm);
    if (!file) {
      return { ok: false, connector_id, ...prov, error: `file '${path}' not found`, available: files.map((f) => f.path) };
    }
    return { ok: true, connector_id, ...prov, path: file.path, encoding: file.encoding || "utf8", content: file.content };
  },

  ateam_get_deployed_connector_source: async ({ solution_id, connector_id, path }, sid) => {
    const data = await get(apiPath`/deploy/solutions/${solution_id}/connectors/${connector_id}/deployed-source`, sid);
    const files = Array.isArray(data?.files) ? data.files : [];
    // The label rides on EVERY response shape, including the error one. A
    // caller that reads one file out of here must not be able to forget which
    // store it came from — that forgetting is the whole defect this splits.
    const label = {
      provenance: data?.provenance || "core_runtime",
      authored_source_of_record: false,
      note: "DEPLOYED copy from Core, not authored source. It reflects the last successful deploy and may differ from what the Builder can reproduce.",
    };
    if (!path) {
      return {
        ok: true,
        connector_id,
        ...label,
        files: files.map((f) => ({ path: f.path, bytes: (f.content || "").length, encoding: f.encoding || "utf8" })),
        total_bytes: files.reduce((n, f) => n + (f.content || "").length, 0),
        hint: "Call again with path:'<file>' to read one file.",
      };
    }
    const norm = String(path).replace(/^\.?\//, "");
    const file = files.find((f) => f.path === path || f.path === norm || f.path.replace(/^\.?\//, "") === norm);
    if (!file) {
      return { ok: false, connector_id, ...label, error: `file '${path}' not found`, available: files.map((f) => f.path) };
    }
    return { ok: true, connector_id, ...label, path: file.path, encoding: file.encoding || "utf8", content: file.content };
  },

  ateam_recover_connector_source: async ({ solution_id, connector_id, force = false }, sid) => {
    try {
      const data = await post(
        apiPath`/deploy/solutions/${solution_id}/connectors/${connector_id}/recover-from-core`,
        { force: force === true },
        sid,
      );
      return data;
    } catch (err) {
      // The refusal is the point of the tool, so report it as a decision the
      // caller has to make rather than as a failure it should retry past.
      const parsed = jsonBodyOf(err.body);
      if (err.status === 409 && parsed?.code === "AUTHORED_SOURCE_EXISTS") {
        return {
          ok: false,
          code: "AUTHORED_SOURCE_EXISTS",
          connector_id,
          error: parsed.error,
          next: [
            `ateam_get_connector_source(solution_id:'${solution_id}', connector_id:'${connector_id}') — the authored copy`,
            `ateam_get_deployed_connector_source(solution_id:'${solution_id}', connector_id:'${connector_id}') — the deployed copy`,
            "Compare them. Only if the deployed copy is the one to keep, call again with force:true.",
          ],
        };
      }
      if (err.status === 404 && parsed?.code === "NOTHING_TO_RECOVER") {
        return { ok: false, code: "NOTHING_TO_RECOVER", connector_id, error: parsed.error };
      }
      throw err;
    }
  },

  // Render + write CLAUDE.md into the solution's GitHub repo.
  // Preserves content below the sentinel unless overwrite=true.
  // Swallows errors internally when invoked non-interactively (see _writeAgentDocSafe).
  ateam_write_agent_doc: async ({ solution_id, overwrite = false }, sid) => {
    if (!solution_id) throw new Error("solution_id required");
    // Gather source material: the deployed solution definition + skills list.
    // These come straight from Core, so the doc always reflects what's running.
    const def = await get(apiPath`/deploy/solutions/${solution_id}/definition`, sid);
    const solution = def?.solution || def;
    let skills = [];
    try {
      const skillsRes = await get(apiPath`/deploy/solutions/${solution_id}/skills`, sid);
      skills = Array.isArray(skillsRes?.skills) ? skillsRes.skills : Array.isArray(skillsRes) ? skillsRes : [];
    } catch { /* no skills yet — render anyway */ }
    const connectors = Array.isArray(solution?.connectors) ? solution.connectors : [];

    const freshHeader = renderAgentDocHeader({ solution, skills, connectors });
    let existing = null;
    try {
      const r = await get(
        apiPath`/deploy/solutions/${solution_id}/github/read?path=CLAUDE.md`,
        sid,
      );
      existing = r?.content || null;
    } catch { /* file doesn't exist yet — treat as fresh create */ }
    const merged = overwrite ? freshHeader : mergeAgentDoc(freshHeader, existing);

    // Idempotent write: if the merged content is byte-identical to what's
    // already committed, skip the patch entirely. Prevents a noise commit on
    // every build_and_run when nothing meaningful changed.
    if (existing && existing === merged) {
      return {
        ok: true,
        solution_id,
        unchanged: true,
        created: false,
        preserved_notes: existing.includes(AGENT_DOC_SENTINEL),
        bytes: merged.length,
      };
    }

    const res = await post(
      apiPath`/deploy/solutions/${solution_id}/github/patch`,
      {
        path: "CLAUDE.md",
        content: merged,
        message: existing ? "CLAUDE.md: refresh auto-generated header" : "CLAUDE.md: seed agent onboarding doc",
      },
      sid,
    );
    return {
      ok: Boolean(res?.ok ?? true),
      solution_id,
      unchanged: false,
      created: !existing,
      preserved_notes: Boolean(existing && existing.includes(AGENT_DOC_SENTINEL)),
      bytes: merged.length,
      commit_url: res?.commit_url || null,
      commit_sha: res?.commit_sha || null,
    };
  },

  ateam_get_metrics: async ({ solution_id, job_id, chain_id, skill_id }, sid) => {
    // Same rule as ateam_get_execution_logs: a chain is not a job. Core's
    // insight is per-job, so a chain is measured by measuring EVERY job in it —
    // never by silently reporting the root and calling that the chain.
    if (!job_id && chain_id) {
      const chain = await get(apiPath`/deploy/jobs/${chain_id}/chain`, sid);
      const { jobs } = chainTreeOf(chain);
      const CAP = 10;
      const measured = jobs.slice(0, CAP);
      const per_job = [];
      for (const j of measured) {
        try {
          const m = await get(apiPath`/deploy/solutions/${solution_id}/metrics?job_id=${j.jobId}`, sid);
          per_job.push({ job_id: j.jobId, skill: j.skill, relation: j.relation, depth: j.depth, metrics: m });
        } catch (err) {
          // One unreadable job must not hide the rest — say which failed and why.
          per_job.push({ job_id: j.jobId, skill: j.skill, relation: j.relation, depth: j.depth, error: err.message });
        }
      }
      return {
        ok: true,
        scope: "chain",
        chain_id,
        solution_id,
        job_count: jobs.length,
        measured: per_job.length,
        // NO SILENT CAPS: if the chain is bigger than we measured, say so here
        // rather than let the caller read a partial roll-up as the whole chain.
        truncated: jobs.length > CAP ? `chain has ${jobs.length} jobs; measured the first ${CAP}` : null,
        per_job,
      };
    }
    const qs = new URLSearchParams();
    if (job_id) qs.set("job_id", job_id);
    if (skill_id) qs.set("skill_id", skill_id);
    const qsStr = qs.toString() ? `?${qs}` : "";
    return get(apiPath`/deploy/solutions/${solution_id}/metrics${rawQuery(qsStr)}`, sid);
  },

  // OPEN-7: one call that returns the REAL runtime end-state — connectors
  // connected + tools discovered, declared widgets actually rendering, skills
  // deployed — with the exact failing gaps, so you never guess-and-check.
  // All sub-checks go through the Builder base (reliable from any connection).
  ateam_verify: async ({ solution_id }, sid) => {
    if (!solution_id) throw new Error("solution_id required");
    const gaps = [];
    const out = { ok: true, solution_id };
    // A CHECK THAT COULD NOT RUN IS NOT A GAP IT FOUND. Each is still listed in
    // `gaps` (callers read them there), and ALSO named in `error` below: that is
    // what tells handleToolCall this verdict tool's CALL failed
    // (mcpFailure.isLogicalFailure). Without it a verify whose every Builder
    // read was refused — a rotated or expired key — came back as a successful
    // call that "found" two gaps, and the UNAUTHENTICATED that sends
    // ateam-proxy-mcp to sign the tenant in again was never given.
    const unavailable = [];
    const couldNotRun = (msg) => { unavailable.push(msg); gaps.push(msg); };

    // 1. Connectors — connected + tools discovered.
    try {
      const ch = await get(apiPath`/deploy/solutions/${solution_id}/connectors/health`, sid);
      const raw = ch?.connectors || ch?.results || (Array.isArray(ch) ? ch : []);
      out.connectors = (raw || []).map((c) => {
        const id = c.id || c.connector_id || c.name;
        const connected = c.status === "connected" || c.connected === true || c.ok === true || c.healthy === true;
        const tools = Array.isArray(c.tools) ? c.tools.length : (typeof c.tools === "number" ? c.tools : (c.toolCount ?? c.tool_count));
        // OPEN-30(c): a connector can be connected + list tools yet 401 on every
        // per-actor call (stale/rotated credential). Surface Core's auth marker.
        const auth_error = c.auth_error || c.authError || null;
        return { id, connected, tools, ...(auth_error ? { auth_error } : {}) };
      });
      for (const c of out.connectors) {
        if (!c.connected) gaps.push(`connector '${c.id}' not connected`);
        else if (c.tools === 0) gaps.push(`connector '${c.id}' connected but discovered 0 tools`);
        // Connected + tools > 0 but auth failing = the silent OPEN-30 failure — flag it.
        if (c.auth_error) gaps.push(`connector '${c.id}' connected but auth failing (${c.auth_error}) — per-actor calls 401; refresh its credential (ateam_upload_connector github:true force:true)`);
      }
    } catch (e) {
      out.connectors = { error: e.message };
      couldNotRun(`connectors health unavailable: ${e.message}`);
    }

    // 2. Widgets — every declared ui_plugin actually renders (reliable proxy).
    try {
      const wh = await verifyWidgetHealth(solution_id, sid);
      out.widgets = wh || { checked: 0, note: "no widgets declared" };
      // verifyWidgetHealth answers an unreadable definition or plugin catalog
      // with { ok:false, error } and no `issues` (b3205aa). Reading only
      // `issues` (95492b6) dropped that on the floor: a verify that could not
      // look at a single widget said nothing about widgets, and passed.
      if (wh?.error) couldNotRun(`widget health unavailable: ${wh.error}`);
      else if (wh && !wh.ok) for (const i of (wh.issues || [])) gaps.push(`widget: ${i}`);
    } catch (e) {
      out.widgets = { error: e.message };
      couldNotRun(`widget health unavailable: ${e.message}`);
    }

    // 3. Skills — deployed + registered (from the solution health check).
    try {
      const h = await get(apiPath`/deploy/solutions/${solution_id}/health`, sid);
      const skills = h?.skills || h?.verification?.skills || [];
      out.skills = (Array.isArray(skills) ? skills : []).map((s) => ({
        id: s.skill_id || s.id || s.skillSlug,
        deployed: s.ok !== false && s.status !== "failed",
      }));
      for (const s of out.skills) if (!s.deployed) gaps.push(`skill '${s.id}' not deployed`);
      if (h?.needs_attention && Array.isArray(h.issues)) {
        // Surface Core's own attention flags that aren't already captured.
        for (const iss of h.issues.slice(0, 10)) gaps.push(`health: ${typeof iss === "string" ? iss : JSON.stringify(iss)}`);
      }
    } catch (e) {
      out.skills = { error: e.message };
      couldNotRun(`solution health unavailable: ${e.message}`);
    }

    // 4. SMOKE CALL — actually invoke a tool the SOLUTION depends on.
    //
    // Everything above is tools/list-level: `connected`, `tools > 0`, "renders",
    // "deployed". All of it stayed green on a clinic connector that answered
    // tools/list correctly and returned 401 on EVERY storage call, because its
    // generated client put a PAT in the shared-secret header. The build shipped,
    // reported healthy, and failed the first time a user touched it. The only
    // check that could have caught it is calling something.
    //
    // Tool names come from the SKILLS, not the connector: the connector
    // endpoints expose a count and a description but no name (verified live —
    // /connectors/<id>/tools returns 7 objects that are all {description:""}),
    // and the tools a skill declares are the ones that actually have to work.
    // Testing those is a better question than testing an arbitrary one.
    out.smoke = [];
    try {
      const wanted = new Map();   // toolName -> connectorId (first skill that declares it)
      for (const sk of Array.isArray(out.skills) ? out.skills : []) {
        if (!sk?.id) continue;
        // An unreadable skill is a check that could not run, not a skill that
        // declares nothing: swallowing it (.catch(() => null)) produced "no
        // read-shaped tool declared by any skill" about a skill never read.
        const def = await get(apiPath`/deploy/solutions/${solution_id}/skills/${sk.id}`, sid).catch((e) => {
          couldNotRun(`skill '${sk.id}' definition unavailable for the smoke check: ${e.message}`);
          return null;
        });
        for (const t of (def?.skill?.tools || def?.tools || [])) {
          const name = typeof t === "string" ? t : t?.name;
          if (!name || wanted.has(name)) continue;
          const conn = (typeof t === "object" && (t?.source?.connector || t?.source?.id)) || null;
          wanted.set(name, conn);
        }
      }

      // READ-SHAPED ONLY. A smoke test must never book an appointment or delete a
      // row to prove a connector is alive, so a write-shaped name is skipped and
      // SAID to be skipped rather than quietly passed over.
      const readish = [...wanted.keys()].filter((n) => /(^|[._])(list|get|today|available|health|status|ping|info|search)([._]|$)/i.test(n));
      const perConnector = new Map();
      for (const name of readish) {
        const conn = wanted.get(name) || (Array.isArray(out.connectors) && out.connectors[0]?.id) || null;
        if (!conn || perConnector.has(conn)) continue;
        perConnector.set(conn, name);
      }

      for (const c of Array.isArray(out.connectors) ? out.connectors : []) {
        // DELIBERATELY NOT GATED ON c.connected. Connectors are LAZY — one idles
        // back to sleep between step 1 and here, and the /call endpoint wakes it
        // on demand. Skipping a sleeping connector would make this check silently
        // untestable exactly when it is most needed, and "asleep" is not an
        // answer to "do its calls work?". The call itself is the verdict.
        const pick = perConnector.get(c.id);
        if (!pick) {
          out.smoke.push({ connector: c.id, called: null, note: "no read-shaped tool declared by any skill — NOT smoke-tested" });
          gaps.push(`connector '${c.id}' was not smoke-tested (no read-shaped tool declared by a skill); tools/list working does NOT prove its calls succeed`);
          continue;
        }
        try {
          const r = await post(apiPath`/deploy/solutions/${solution_id}/connectors/${c.id}/call`, { tool: pick, args: {} }, sid);
          const failed = r?.ok === false;
          out.smoke.push({ connector: c.id, called: pick, ok: !failed, ...(failed && { error: String(r?.error || "").slice(0, 200) }) });
          if (failed) {
            gaps.push(`connector '${c.id}' lists ${c.tools} tool(s) but CALLING ${pick} failed: ${String(r?.error || "").slice(0, 160)} — tools/list works and real calls do not`);
          }
        } catch (e) {
          out.smoke.push({ connector: c.id, called: pick, ok: false, error: e.message.slice(0, 200) });
          gaps.push(`connector '${c.id}' smoke call ${pick} errored: ${e.message.slice(0, 160)}`);
        }
      }
    } catch (e) {
      out.smoke = { error: e.message };
      couldNotRun(`smoke check could not run: ${e.message}`);
    }

    out.gaps = gaps;
    out.ok = gaps.length === 0;
    if (unavailable.length) {
      out.error = `${unavailable.length} check(s) could not run, so this is not a verdict: ${unavailable.join("; ")}`;
    }
    out._status = out.ok
      ? "✅ Verified live — connectors connected AND answering real calls, widgets render, skills deployed."
      : out.error
        ? `❌ Could not verify — ${out.error}`
        : `⚠️ ${gaps.length} gap(s): ${gaps.slice(0, 5).join("; ")}${gaps.length > 5 ? " …" : ""}`;
    return out;
  },

  ateam_diff: async ({ solution_id, skill_id }, sid) => {
    const qs = skill_id ? `?skill_id=${encodeURIComponent(skill_id)}` : "";
    return get(apiPath`/deploy/solutions/${solution_id}/diff${rawQuery(qs)}`, sid);
  },

  // ─── GitHub tools ──────────────────────────────────────────────────

  ateam_github_push: async ({ solution_id, message }, sid) =>
    post(apiPath`/deploy/solutions/${solution_id}/github/push`, { push_to_github: true, message }, sid, { timeoutMs: 60_000 }),

  ateam_github_pull: async ({ solution_id, discard_builder_changes }, sid) => {
    // Dropping a Builder change that never reached GitHub is the caller's
    // decision, stated on every door (the async job and the sync fallback):
    // without it the Builder refuses a pull that would drop one.
    const discard = discard_builder_changes === true ? { discard_builder_changes: true } : {};
    // Async-first: github_pull is the #1 Cloudflare-524 culprit on large
    // solutions. Kick the job off, then poll. Falls back to sync if the
    // backend doesn't support async (older deployments).
    let kicked;
    try {
      kicked = await post(apiPath`/deploy/solutions/${solution_id}/github/pull`, { async: true, ...discard }, sid, { timeoutMs: 30_000 });
    } catch (err) {
      if (!kickFallsBackToSync(err)) throw err;
      // Sync fallback (older backend without async support)
      return await post(apiPath`/deploy/solutions/${solution_id}/github/pull`, { ...discard }, sid, { timeoutMs: 300_000 });
    }
    if (!kicked?.async || !kicked.job_id) return kicked; // backend didn't honor async — return as-is
    return await pollDeployJob(kicked.job_id, sid, { label: 'github-pull', maxMs: 15 * 60_000, intervalMs: 2000 });
  },

  ateam_github_status: async ({ solution_id }, sid) =>
    get(apiPath`/deploy/solutions/${solution_id}/github/status`, sid),

  ateam_github_read: async ({ solution_id, path: filePath, ref, branch }, sid) => {
    // `branch` is an ALIAS for `ref`. The underlying API param is literally
    // called `branch`, so an agent passing branch:"dev" is being reasonable —
    // and because the schema did not declare it, MCP STRIPPED it and the read
    // silently returned `main`. On a tenant whose main and dev had diverged by
    // 67 commits, that answered a different question than the one asked, with
    // no error. (2026-08-21, job_aehopl8z.)
    const wanted = ref || branch;
    const qs = new URLSearchParams({ path: filePath });
    if (wanted) qs.set('branch', wanted);
    const result = await get(apiPath`/deploy/solutions/${solution_id}/github/read?${rawQuery(qs.toString())}`, sid);
    // Additive only — never reshape `result`, callers depend on the raw payload.
    const rep = _representationFor(filePath, result?.content, solution_id);
    return rep && result && typeof result === "object"
      ? { ...result, _ateam_representation: rep }
      : result;
  },

  ateam_github_patch: async ({ solution_id, path: filePath, content, search, replace, message, ref, branch, delete: del }, sid) =>
    // `branch` is an alias for `ref` — see ateam_github_read. `delete` (mode 3)
    // is the Builder's to police: it removes only a stray connector file.
    post(apiPath`/deploy/solutions/${solution_id}/github/patch`, { path: filePath, content, search, replace, message, ref: ref || branch, delete: del }, sid),

  ateam_github_write: async ({ solution_id, path: filePath, content, message, ref }, sid) =>
    post(apiPath`/deploy/solutions/${solution_id}/github/patch`, { path: filePath, content, message, ref }, sid),

  ateam_github_log: async ({ solution_id, limit, ref }, sid) => {
    const qs = new URLSearchParams();
    if (limit) qs.set('limit', String(limit));
    if (ref) qs.set('branch', ref);
    const q = qs.toString();
    return get(apiPath`/deploy/solutions/${solution_id}/github/log${rawQuery(q ? '?' + q : '')}`, sid);
  },

  ateam_github_diff: async ({ solution_id, base, head }, sid) => {
    const qs = new URLSearchParams();
    if (base) qs.set('base', base);
    if (head) qs.set('head', head);
    const q = qs.toString();
    return get(apiPath`/deploy/solutions/${solution_id}/github/diff${rawQuery(q ? '?' + q : '')}`, sid);
  },

  ateam_verify_consistency: async ({ solution_id }, sid) =>
    get(apiPath`/deploy/solutions/${solution_id}/verify`, sid),

  ateam_github_promote: async ({ solution_id, label, dry_run, skip_tag }, sid) =>
    post(apiPath`/deploy/solutions/${solution_id}/promote`, { label, dry_run, skip_tag }, sid),

  ateam_github_reconcile: async ({ solution_id, dry_run }, sid) => {
    if (!solution_id) throw new Error("solution_id required");
    return await post(apiPath`/deploy/solutions/${solution_id}/reconcile`, { dry_run: dry_run === true }, sid);
  },

  ateam_github_sync_from_main: async ({ solution_id, dry_run }, sid) =>
    post(apiPath`/deploy/solutions/${solution_id}/sync-from-main`, { dry_run }, sid, { idempotent: dry_run === true }),

  ateam_github_rollback: async ({ solution_id, target, tag }, sid) =>
    // Accept both `target` (new spec) and `tag` (legacy callers)
    post(apiPath`/deploy/solutions/${solution_id}/rollback`, { target: target || tag }, sid),

  ateam_github_list_versions: async ({ solution_id }, sid) =>
    get(apiPath`/deploy/solutions/${solution_id}/versions/dev`, sid),

  // SHOW BEFORE YOU DESTROY.
  //
  // Without force:true this RETURNS THE INVENTORY — every skill and connector
  // the clear would take — and touches nothing. Only force:true clears.
  //
  // A warning in a description is a claim the caller must take on trust, and it
  // cannot mention the ORPHAN nobody knew was in the registry. The inventory is
  // evidence: the caller reads the actual names first. On 2026-09-11 the absence
  // of that step cost `walk-guide` — destroyed while clearing an unrelated test
  // fixture, present in no GitHub branch, unrecoverable.
  //
  // confirm/confirm_solution_id still guard typos and hallucinated ids. They
  // answer "did you mean THIS tenant"; force answers "have you read what is in
  // it". Both are needed, and neither substitutes for the other.
  ateam_delete_solution: async ({ solution_id, confirm, confirm_solution_id, force }, sid) => {
    // Before anything else, and before any request: see SOLUTION_ID_RX.
    if (typeof solution_id !== "string" || !SOLUTION_ID_RX.test(solution_id)) {
      return {
        ok: false,
        code: "INVALID_SOLUTION_ID",
        error:
          `⚠️ REFUSED: solution_id ${JSON.stringify(solution_id)} is not a solution id (it must match ${SOLUTION_ID_RX}). ` +
          "Nothing was sent.",
        hint: "A solution id is letters, digits, '-' and '_' only. ateam_list_solutions shows this tenant's.",
      };
    }
    const solutionPath = apiPath`/deploy/solutions/${solution_id}`;

    if (confirm_solution_id !== undefined && confirm_solution_id !== solution_id) {
      return {
        ok: false,
        error: `⚠️ REFUSED: confirm_solution_id must exactly equal solution_id. Got confirm_solution_id="${confirm_solution_id}" but solution_id="${solution_id}". This check defeats typos and hallucinated ids — you should not be able to wipe a solution whose id you can't spell correctly.`,
        expected: solution_id,
        received: confirm_solution_id,
      };
    }

    // Preview: no confirm needed to LOOK, and looking is the default.
    if (force !== true) {
      // A read (the id check keeps ?force out of the path), so a transport failure may be re-sent.
      const preview = await del(solutionPath, sid, { idempotent: true });
      return {
        ...preview,
        _next:
          "Nothing was cleared. Read will_clear above — especially orphan_skills, which belong to no solution and " +
          "are the ones most likely to be unrecoverable. The forced delete also WIPES the tenant's conversations and " +
          "history, memory facts and stored actor data, which will_clear does not list and which cannot be recovered. " +
          "To proceed: ateam_delete_solution(solution_id, " +
          `confirm:true, confirm_solution_id:"${solution_id}", force:true)`,
      };
    }

    if (confirm !== true) {
      return {
        ok: false,
        error:
          "⚠️ REFUSED: force:true also requires confirm:true. THIS CLEARS THE WHOLE TENANT — TENANT === SOLUTION. " +
          DELETE_SOLUTION_EFFECT,
        recovery: DELETE_SOLUTION_RECOVERY,
      };
    }
    if (confirm_solution_id !== solution_id) {
      return {
        ok: false,
        error: `⚠️ REFUSED: force:true requires confirm_solution_id to exactly equal solution_id.`,
        expected: solution_id,
        received: confirm_solution_id,
      };
    }
    // ONCE. retries:0 says it here; api.js mayAutoRetry refuses to re-send any
    // write as well. Before, request()'s default re-sent this DELETE on a 502
    // without reading the body, so the caller saw the answer to the last pass
    // and never the verdict of the first (B7).
    try {
      return await del(`${solutionPath}?force=true`, sid, { retries: 0, timeoutMs: FORCE_DELETE_TIMEOUT_MS });
    } catch (err) {
      return forceDeleteFailure(err, solution_id, sid);
    }
  },

  ateam_delete_skill: async ({ solution_id, skill_id, confirm }, sid) => {
    if (confirm !== true) {
      return {
        ok: false,
        error: `⚠️ REFUSED: ateam_delete_skill requires confirm:true. Kills the running MCP process, deletes the skill from Core + Builder FS, and deletes its source (skills/<id>/) from the repo on BOTH dev and main.`,
        recovery: `${GIT_RECOVERY} There is no per-skill restore path.`,
      };
    }
    return del(apiPath`/deploy/solutions/${solution_id}/skills/${skill_id}`, sid);
  },

  ateam_delete_connector: async ({ solution_id, connector_id, confirm }, sid) => {
    if (confirm !== true) {
      return {
        ok: false,
        error: `⚠️ REFUSED: ateam_delete_connector requires confirm:true. Cascading — any skill wired to this connector's tools will fail its next execution. It also deletes the source (connectors/<id>/) from the repo on BOTH dev and main: copy it out first (ateam_get_connector_source) if you want the code kept.`,
        recovery: GIT_RECOVERY,
      };
    }
    return del(apiPath`/deploy/solutions/${solution_id}/connectors/${connector_id}`, sid);
  },

  ateam_upload_connector: async ({ solution_id, connector_id, github, files, ref, replace, force }, sid) => {
    // OPEN-32: accept content_base64 per file (single-line, escape-safe) and
    // decode it to plain content here, so an agent can upload a multi-file
    // connector without hand-escaping ~90KB of HTML/JS/JSON in one tool call —
    // and via THIS registered path (not a raw curl that skips PAT provisioning).
    let normFiles = files;
    if (Array.isArray(files)) {
      normFiles = files.map((f, i) => {
        if (!f || typeof f !== "object" || !f.path) {
          throw new Error(`ateam_upload_connector: files[${i}] must be an object with a 'path'.`);
        }
        const hasContent = typeof f.content === "string";
        const hasB64 = typeof f.content_base64 === "string";
        if (hasContent && hasB64) {
          throw new Error(`ateam_upload_connector: files[${i}] ("${f.path}") has BOTH content and content_base64 — provide exactly one.`);
        }
        if (!hasContent && !hasB64) {
          throw new Error(`ateam_upload_connector: files[${i}] ("${f.path}") needs 'content' (inline string) or 'content_base64' (escape-safe base64).`);
        }
        if (hasB64) {
          const decoded = Buffer.from(f.content_base64, "base64").toString("utf8");
          if (!decoded && f.content_base64.trim()) {
            throw new Error(`ateam_upload_connector: files[${i}] ("${f.path}") content_base64 did not decode to any content — check the encoding.`);
          }
          return { path: f.path, content: decoded };
        }
        return { path: f.path, content: f.content };
      });
    }
    // Async-first: this runs npm install + build in Core (up to ~7min) and is a
    // prime Cloudflare-524 culprit. Kick async → poll /deploy/jobs; fall back to
    // sync for older backends that don't honor async. Mirrors ateam_github_pull.
    const body = {
      github,
      files: normFiles,
      ...(ref ? { ref } : {}),
      ...(replace === true ? { replace: true } : {}),
      ...(force === true ? { force: true } : {}),
    };
    const url = apiPath`/deploy/solutions/${solution_id}/connectors/${connector_id}/upload`;
    let kicked;
    try {
      kicked = await post(url, { ...body, async: true }, sid, { timeoutMs: 30_000 });
    } catch (err) {
      if (!kickFallsBackToSync(err)) throw err;
      return await post(url, body, sid, { timeoutMs: 300_000 });
    }
    if (!kicked?.async || !kicked.job_id) return kicked; // backend didn't honor async
    return await pollDeployJob(kicked.job_id, sid, { label: 'connector-upload', maxMs: 15 * 60_000, intervalMs: 2000 });
  },

  // ── Phase 9 strip: focused minimal responses ────────────────────────
  ateam_show_skill_minimal: async ({ solution_id, skill_id }, sid) => {
    if (!solution_id) throw new Error("solution_id required");
    if (!skill_id) throw new Error("skill_id required");
    const full = await get(apiPath`/deploy/solutions/${solution_id}/skills/${skill_id}`, sid);
    const skill = full?.skill || full;
    if (!skill) return { ok: false, error: "skill not found", hint: notInThisWorkspace(signInContext(sid)) };
    return {
      ok: true,
      id: skill.id,
      name: skill.name || skill.id,
      description: skill.description || "",
      role: { persona: skill.role?.persona || "" },
      connectors: skill.connectors || [],
      handoff_when: skill.handoff_when || null,
      style: skill.style || null,
      excluded_tools: skill.excluded_tools || [],
      policy_guardrails: {
        never: skill.policy?.guardrails?.never || [],
        always: skill.policy?.guardrails?.always || [],
      },
      engine: typeof skill.engine === "string" ? skill.engine : (skill.engine ? "<explicit-object>" : null),
      _hint: "This is the MINIMAL view (Phase 9 strip). Use ateam_get_solution(view:'skills', skill_id) for the full schema.",
    };
  },

  ateam_log_lesson: async ({ solution_id, tool, error, workaround, worked, kind, supersedes }, sid) => {
    if (!solution_id) throw new Error("solution_id required");
    if (!tool) throw new Error("tool required — the tool that misled you");
    if (!error) throw new Error("error required — quote it VERBATIM, do not paraphrase");
    // The Builder validates `supersedes` (a current lesson of THIS solution);
    // a refusal comes back as its 404/409, naming the current lesson.
    return await post(
      apiPath`/deploy/solutions/${solution_id}/lessons`,
      { tool, error, workaround, worked, kind, supersedes },
      sid,
    );
  },

  ateam_log_progress: async ({ solution_id, step, status, detail, verified_by }, sid) => {
    if (!solution_id) throw new Error("solution_id required");
    if (!step) throw new Error("step required — a STABLE slug a later run can match on, e.g. \"connector:clinic-data-mcp\"");
    if (!status) throw new Error("status required — built | deployed | verified");
    return await post(
      apiPath`/deploy/solutions/${solution_id}/progress`,
      { step, status, detail, verified_by },
      sid,
    );
  },

  ateam_get_progress: async ({ solution_id, limit }, sid) => {
    if (!solution_id) throw new Error("solution_id required");
    const qs = Number.isFinite(limit) ? `?limit=${limit}` : "";
    return await get(apiPath`/deploy/solutions/${solution_id}/progress${rawQuery(qs)}`, sid);
  },

  ateam_get_lessons: async ({ solution_id, limit, include_superseded }, sid) => {
    if (!solution_id) throw new Error("solution_id required");
    const qs = new URLSearchParams();
    if (Number.isFinite(limit)) qs.set("limit", String(limit));
    if (include_superseded === true) qs.set("include_superseded", "true");
    const qsStr = qs.toString() ? `?${qs}` : "";
    return await get(apiPath`/deploy/solutions/${solution_id}/lessons${rawQuery(qsStr)}`, sid);
  },

  ateam_show_solution_minimal: async ({ solution_id }, sid) => {
    if (!solution_id) throw new Error("solution_id required");
    const full = await get(apiPath`/deploy/solutions/${solution_id}/definition`, sid);
    const sol = full?.solution || full;
    if (!sol) return { ok: false, error: "solution not found", hint: notInThisWorkspace(signInContext(sid)) };
    return {
      ok: true,
      id: sol.id,
      name: sol.name || sol.id,
      description: sol.description || "",
      version: sol.version || "1.0.0",
      style: sol.style || null,
      routing_mode: sol.routing_mode || "manual",
      identity_mode: sol.identity_mode || null,
      identity: sol.identity ? {
        default_actor_type: sol.identity.default_actor_type,
        actor_types_count: (sol.identity.actor_types || []).length,
      } : null,
      skills: (sol.skills || []).map(s => ({
        id: s.id,
        name: s.name || s.id,
        role: s.role || "worker",
      })),
      connectors_count: (sol.platform_connectors || []).length,
      ui_plugins_count: (sol.ui_plugins || []).length,
      handoffs_count: (sol.handoffs || []).length,
      _hint: "This is the MINIMAL view (Phase 9 strip). Use ateam_get_solution(view:'definition') for the full schema.",
    };
  },

  // ── Phase 7 strip: scaffold helpers ─────────────────────────────────
  ateam_create_connector: async ({ solution_id, connector_id, name, ui_capable }, sid) => {
    if (!solution_id) throw new Error("solution_id required");
    if (!connector_id) throw new Error("connector_id required");
    if (!/^[a-z][a-z0-9-]*$/.test(connector_id)) {
      throw new Error("connector_id must be lowercase letters/digits/dashes only");
    }
    const files = _scaffoldConnectorFiles({
      connectorId: connector_id,
      displayName: name || connector_id,
      uiCapable: !!ui_capable,
    });
    // CREATE NEVER DESTROYS (CORE). This uploaded with replace:true (575e993,
    // "this is a NEW connector", never checked), which deletes every file the
    // scaffold lacks — from Core, from the Builder's source and from the repo's
    // working branch — so create on an existing id replaced that connector with a
    // skeleton. if_absent:true makes the Builder write the scaffold only if the
    // connector exists nowhere, in the same request that checks (createOnlyRefusal).
    // There is no replace here and no fallback to one: a refusal, a failed read,
    // or a Builder that does not answer create_only is a failure.
    const ctx = { solutionId: solution_id, connectorId: connector_id };
    let result;
    try {
      result = await post(
        apiPath`/deploy/solutions/${solution_id}/connectors/${connector_id}/upload`,
        { files, if_absent: true },
        sid,
        { timeoutMs: 120_000 },
      );
    } catch (err) {
      const refusal = createOnlyRefusal("connector", { status: err.status, body: jsonBodyOf(err.body) }, ctx);
      if (refusal) return refusal;
      throw err;
    }
    if (result?.ok === false) return uploadFailed(result);
    if (result?.create_only !== "connector") return createNotSafeYet("connector", result, ctx);
    return {
      ok: true,
      connector_id,
      files_created: files.map(f => f.path),
      ui_capable: !!ui_capable,
      upload_result: result,
      next_steps: [
        `Edit server.js to add your real tools (replace the echo stub). The caller is ctx — never declare _adas_* fields.`,
        `Before storing anything: ${STORAGE_DECISION_AT} — records go to actorStore through store() in THE template.`,
        ui_capable
          ? `Use ateam_create_plugin to scaffold your first UI plugin.`
          : null,
        `Use ateam_test_connector or ateam_build_and_run to deploy + test.`,
      ].filter(Boolean),
    };
  },

  ateam_create_plugin: async ({ solution_id, connector_id, plugin_name, kind }, sid) => {
    if (!solution_id) throw new Error("solution_id required");
    if (!connector_id) throw new Error("connector_id required");
    if (!plugin_name) throw new Error("plugin_name required");
    if (!/^[a-z][a-z0-9-]*$/.test(plugin_name)) {
      throw new Error("plugin_name must be lowercase letters/digits/dashes only");
    }
    const k = kind || "adaptive";
    if (!["iframe", "rn", "adaptive"].includes(k)) {
      throw new Error(`kind must be one of: iframe, rn, adaptive (got ${k})`);
    }
    const files = _scaffoldPluginFiles({
      connectorId: connector_id,
      pluginName: plugin_name,
      kind: k,
    });
    // Async-first upload — npm install+build can exceed Cloudflare's 100s → 524.
    // Kick async → poll /deploy/jobs; fall back to sync for older backends.
    //
    // CREATE NEVER DESTROYS: the upload carries if_absent:{plugin}, so the Builder
    // refuses (PLUGIN_EXISTS) when any file of this plugin exists in its source,
    // on the repo's working branch or in Core, in the same request that writes
    // (Builder #160). An async job reports its refusal in its result, with
    // http_status and code; createOnlyRefusal reads both the same way.
    const _uploadUrl = apiPath`/deploy/solutions/${solution_id}/connectors/${connector_id}/upload`;
    const createOnly = { files, if_absent: { plugin: plugin_name } };
    const ctx = { solutionId: solution_id, connectorId: connector_id, pluginName: plugin_name };
    const jobKey = pluginJobKey(sid, solution_id, connector_id, plugin_name);
    const earlierJobId = earlierPluginJob(jobKey);   // read BEFORE this call's own job is recorded
    const settle = (refusal) => settleAgainstEarlierJob(refusal, earlierJobId, { sid, connectorId: connector_id, pluginName: plugin_name });
    const fromError = (err) => ({ status: err?.status, body: jsonBodyOf(err?.body) });
    let result;
    try {
      const kicked = await post(_uploadUrl, { ...createOnly, async: true }, sid, { timeoutMs: 30_000 });
      if (kicked?.async && kicked.job_id) acceptedPluginJobs.set(jobKey, { job_id: kicked.job_id, at: Date.now() });
      result = (kicked?.async && kicked.job_id)
        ? await pollDeployJob(kicked.job_id, sid, { label: 'create-plugin', maxMs: 15 * 60_000, intervalMs: 2000 })
        : kicked;
    } catch (err) {
      const refusal = createOnlyRefusal("plugin", fromError(err), ctx);
      if (refusal) return settle(refusal);
      if (!kickFallsBackToSync(err)) throw err;
      // The sync retry waits for the connector's lock. If the async job was
      // accepted before this retry, it may have created the plugin, and the
      // retry then gets PLUGIN_EXISTS: say so (afterAsyncKick).
      try {
        result = await post(_uploadUrl, createOnly, sid, { timeoutMs: 120_000 });
      } catch (syncErr) {
        const syncRefusal = createOnlyRefusal("plugin", fromError(syncErr), { ...ctx, afterAsyncKick: true });
        if (syncRefusal) return settle(syncRefusal);
        throw syncErr;
      }
    }
    if (result?.ok === false || result?.status === "failed") {
      const refusal = createOnlyRefusal("plugin", { status: result.http_status, body: result }, ctx);
      return refusal ? settle(refusal) : uploadFailed(result);
    }
    if (result?.create_only !== "plugin") return createNotSafeYet("plugin", result, ctx);

    // Verify the plugin actually became RENDERABLE — poll Core's live catalog
    // (which calls the connector's ui.listPlugins) for this plugin id. The
    // connector restarts on upload, so allow a few seconds to re-scan ui-dist
    // and re-announce. Turns create_plugin into a VERIFIED result (renders:true
    // or a concrete reason) instead of a hopeful "files written".
    const pluginId = `mcp:${connector_id}:${plugin_name}`;
    let verified = { renders: false, note: "not yet discovered by Core after upload" };
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        await new Promise((r) => setTimeout(r, attempt === 0 ? 1500 : 2500));
        // Reliable catalog via the Builder proxy (not direct ADAS_CORE_URL).
        const data = await get(apiPath`/deploy/solutions/${solution_id}/ui-plugins`, sid).catch(() => null);
        if (!data || data.ok === false) continue;
        const found = (data?.plugins || []).find((p) => p?.id === pluginId);
        if (found) {
          verified = _widgetHasRender(found.render)
            ? { renders: true, render_ok: true, note: "listed by Core with a valid render block (the catalog entry is what was checked; that its buttons reach the host is not — prove the data path with ateam_verify_surface)" }
            : { renders: false, render_ok: false, note: "discovered, but its manifest has no usable render block (need render.mode + iframeUrl/reactNative)" };
          break;
        }
      }
      if (!verified.renders && !("render_ok" in verified)) {
        verified.hint = "Not in Core's live catalog yet. If the connector is lazy (stopped until first call), its plugins only appear once declared in solution ui_plugins[] — declare it, or ensure the connector is ui_capable + connected. Re-check with ateam_get_widget_catalog.";
      }
    } catch { /* advisory — never fail the create on the verify probe */ }

    return {
      ok: true,
      plugin_id: pluginId,
      kind: k,
      files_created: files.map(f => f.path),
      upload_result: result,
      verified,
      next_steps: [
        k === "rn" || k === "adaptive"
          ? `Edit rn-src/${plugin_name}.tsx — fill in the Component body, THEN rebuild + commit rn-bundle/${plugin_name}.bundle.js (esbuild command is in the .tsx header) — mobile loads that bundle, never the .tsx. A deploy runs only the build scripts package.json declares ("build", "build:*"), and this scaffold declares none; add a "build:rn" script, with esbuild in devDependencies, if you want the deploy to build it — a package with a build script is installed WITH its devDependencies (ateam_get_spec(topic:"ui-plugins")). A pre-built starter bundle ships with this scaffold, so it renders as-is until you edit it.`
          : null,
        k === "iframe" || k === "adaptive"
          ? `Edit ui-dist/${plugin_name}/index.html — replace the placeholder UI.`
          : null,
        `A manifest.json (with the render block) was written to ui-dist/${plugin_name}/manifest.json — this is the source of truth Core reads.`,
        `If this connector was scaffolded by ateam_create_connector, its ui.listPlugins / ui.getPlugin read ui-dist/*/manifest.json automatically — nothing else to register. ${PLUGIN_LISTED_LIVE} ⚠️ ONLY a connector with a HARDCODED plugin list (legacy, e.g. personal-assistant-ui-mcp: UI_PLUGINS[] + PLUGIN_MANIFESTS{} in server.js) needs this plugin added there by hand — copy the render block from manifest.json.`,
        `Verify with ateam_get_widget_catalog (or ateam_get_solution(solution_id, "connectors_health")).`,
        DISCOVERED_PLUGIN_IS_MERGED,
      ].filter(Boolean),
    };
  },

  ateam_redeploy: async ({ solution_id, skill_id }, sid) => {
    const endpoint = skill_id
      ? apiPath`/deploy/solutions/${solution_id}/skills/${skill_id}/redeploy`
      : apiPath`/deploy/solutions/${solution_id}/redeploy`;

    // Async-first: bulk redeploys used to 524 on >5-skill solutions because
    // the upstream Cloudflare timeout is ~100s. Kick the job and poll. If
    // the backend doesn't support async (older deployment), fall back to
    // the legacy sync path with longer retry. If both fail, surface a
    // useful error/hint to the agent.
    let result;
    let lastErr = null;
    try {
      const kicked = await post(endpoint, { async: true }, sid, { timeoutMs: 30_000 });
      if (kicked?.async && kicked.job_id) {
        result = await pollDeployJob(kicked.job_id, sid, {
          label: skill_id ? `redeploy-skill ${skill_id}` : 'redeploy-bulk',
          maxMs: 15 * 60_000,
          intervalMs: 2000,
        });
      } else {
        result = kicked; // backend didn't honor async — already-finished sync result
      }
    } catch (err) {
      lastErr = err;
      // Sync fallback for backends without async support
      if (kickFallsBackToSync(err)) {
        try {
          result = await post(endpoint, {}, sid, { timeoutMs: 300_000 });
          lastErr = null;
        } catch (syncErr) {
          lastErr = syncErr;
        }
      }
    }

    if (!result && lastErr) {
      const notFound = /not found|404|ENOENT/i.test(lastErr.message);
      const isTimeout = isTimeoutError(lastErr) && !jsonVerdictOf(lastErr.body);
      return {
        ok: false,
        error: lastErr.message,
        ...(notFound && {
          // It said "then use ateam_build_and_run(solution_id, github: true)",
          // which deploys `main`: without a promote it is refused
          // (MAIN_BEHIND_DEV) or ships main's copy without the edit.
          hint: "Skill not found in Builder storage. Write it to the repo with ateam_github_write(solution_id, path: 'skills/<skill-id>/skill.json', content) (or ateam_github_patch for an edit), which also puts it in the Builder, then retry this ateam_redeploy. To ship it: ateam_github_promote, then ateam_build_and_run(solution_id).",
        }),
        ...(isTimeout && {
          hint: "The redeploy timed out with no answer, so it may still be running; it was not re-sent. Check ateam_status_all before issuing it again, and for a large solution redeploy one skill at a time: ateam_redeploy(solution_id, skill_id: '<specific-skill>').",
        }),
      };
    }
    if (!result) result = { ok: false, error: 'Redeploy returned no result' };
    const verdict = redeployVerdict(result, { single: Boolean(skill_id) });
    // Pull through the underlying error/message instead of fabricating "0/0/0
    // success-shaped" output. Old wrapper hid backend errors (e.g. validator
    // failures from sentinel files in user repos) and reported `total: 0` with
    // no clue why — the agent was left thinking redeploy was a no-op when in
    // fact it was a hard failure.
    const failedCount = verdict.failed
      ? (result.failed ?? (result.skills?.length ? result.skills.filter(s => s.ok === false).length : 1))
      : (result.failed || 0);
    const deployedCount = result.deployed ?? (verdict.failed ? 0 : (skill_id ? 1 : (result.skills?.filter(s => s.ok !== false).length || 0)));
    const totalCount = result.total ?? (deployedCount + failedCount);

    const out = {
      // The verdict's, not result.ok: a crashed job has no ok at all, and
      // passing `undefined` through is what kept isError off it.
      ok: !verdict.failed,
      solution_id,
      ...(skill_id && { skill_id }),
      deployed: deployedCount,
      failed: failedCount,
      total: totalCount,
      skills: result.skills || [],
      // PASS THROUGH what the Builder decided: `status` is the deploy's OUTCOME
      // (deployed_with_errors is a real outcome, neither a clean success nor a
      // failure) — never the job lifecycle word — and `verification` carries why.
      ...(verdict.outcome && { status: verdict.outcome }),
      ...(result.verification && { verification: result.verification }),
      // Machine-readable, so a caller (the ateam-proxy connector) does not have
      // to parse the sentence below. Not isError: the Builder's ok:true stands.
      ...(verdict.degraded && { code: "DEPLOYED_WITH_ERRORS" }),
      // What this redeploy could NOT write to `dev` (a file still held, or a
      // push that failed). It is the way out an UNPUSHED_BUILDER_CHANGE
      // refusal names, so the caller must see when it did not work.
      ...(result.not_written_to_github?.length > 0 && { not_written_to_github: result.not_written_to_github }),
      // Surface the underlying error when the request failed — the most
      // common cause is a validator failure (e.g. broken connector source
      // in the GitHub repo), and hiding it makes diagnosis impossible.
      ...(verdict.failed && result.error && { error: result.error }),
      ...(verdict.failed && result.details && { details: result.details }),
      ...(verdict.failed && result.hint && { hint: result.hint }),
      // Branches on the VERDICT, not on `ok` alone — `ok` is true for a deploy
      // that landed with errors, and this sentence is what an agent reads first.
      //
      // The deploy's own words come from verdict.reason and nowhere else:
      // redeployVerdict alone decides when a job's `message` is the deploy's
      // sentence and when it is leftover progress text (see deploySentence).
      message: verdict.failed
        ? (result.error
            ? `Re-deploy failed: ${result.error}${result.hint ? ` — ${result.hint}` : ''}`
            : verdict.reason
              ? `Re-deploy of skill "${skill_id}" failed. Builder: ${asSentence(verdict.reason)}`
            // "Check skills array" was the advice given WHILE the skills array
            // was empty — the async branch never populated it. Say what is
            // actually known, and only mention the array when there is one.
            : (result.skills?.length
                ? `Re-deploy had ${failedCount} failure(s) — see skills[].`
                : `Re-deploy reported ${failedCount} failure(s) but named no skill and gave no reason. `
                  + `That is a reporting fault, not necessarily a deploy fault: check ateam_get_solution(view:"status") `
                  + `before redeploying, in case the skill actually landed.`))
        : verdict.degraded
        ? (skill_id
            ? `Re-deployed skill "${skill_id}" WITH ERRORS (status: ${verdict.outcome}) — it reached Core but did not come up clean.`
              + (verdict.reason ? ` Builder: ${asSentence(verdict.reason)}` : "")
              + " See verification."
            : `Re-deployed ${deployedCount} of ${totalCount} skill(s) WITH ERRORS (${failedCount} failed`
              + `, status: ${verdict.outcome}) — see skills[] and verification.`)
        : skill_id
          ? `Re-deployed skill "${skill_id}" successfully.`
          : `Re-deployed ${deployedCount} skill(s) successfully.`,
    };
    // If the deploy landed and the solution declares widgets, verify each one
    // actually renders (discovered by Core + has a render block). A silently
    // non-rendering widget is a common, hard-to-notice failure — surface it here.
    if (!verdict.failed) {
      try {
        const wh = await verifyWidgetHealth(solution_id, sid);
        if (wh) {
          out.widget_health = wh;
          if (!wh.ok) out.message += ` ⚠️ ${wh.issues?.length || 0} widget issue(s) — see widget_health.`;
        }
      } catch { /* health check is advisory — never fail the deploy on it */ }
    }
    return out;
  },

  // ─── Master Key Bulk Tools ───────────────────────────────────────────

  ateam_status_all: async (_args, sid) => {
    if (!isMasterMode(sid)) {
      return { ok: false, message: "Master key required. Call ateam_auth(master_key: \"<key>\", tenant: \"<any>\") first." };
    }
    const tenants = await listTenants(sid);
    const results = [];
    // Each tenant in its own scope: the session stays on its tenant (runAsTenant).
    for (const t of tenants) await runAsTenant(sid, t.id, async () => {
      try {
        const { solutions } = await get("/deploy/solutions", sid);
        for (const sol of (solutions || [])) {
          let ghStatus = null;
          try {
            ghStatus = await get(apiPath`/deploy/solutions/${sol.id}/github/status`, sid);
          } catch { /* no github config */ }
          results.push({
            tenant: t.id,
            solution: sol.id,
            name: sol.name || sol.id,
            github: ghStatus ? {
              repo: ghStatus.repo || ghStatus.repoUrl,
              lastCommit: ghStatus.lastCommit?.message?.slice(0, 60),
              lastPush: ghStatus.lastCommit?.date,
              branch: ghStatus.branch,
            } : "not configured",
          });
        }
      } catch (err) {
        results.push({ tenant: t.id, error: err.message });
      }
    });
    return { ok: true, tenants: tenants.length, solutions: results.length, results };
  },

  ateam_sync_all: async ({ push_only, pull_only }, sid) => {
    if (!isMasterMode(sid)) {
      return { ok: false, message: "Master key required. Call ateam_auth(master_key: \"<key>\", tenant: \"<any>\") first." };
    }
    const tenants = await listTenants(sid);
    const results = [];
    // Each tenant in its own scope: the session stays on its tenant (runAsTenant).
    for (const t of tenants) await runAsTenant(sid, t.id, async () => {
      try {
        const { solutions } = await get("/deploy/solutions", sid);
        for (const sol of (solutions || [])) {
          const entry = { tenant: t.id, solution: sol.id, name: sol.name || sol.id };
          // Push: Builder FS → GitHub
          if (!pull_only) {
            try {
              const pushResult = await post(apiPath`/deploy/solutions/${sol.id}/github/push`, { push_to_github: true }, sid);
              entry.push = { ok: true, commit: pushResult.commitSha?.slice(0, 8), files: pushResult.filesCommitted };
            } catch (err) {
              entry.push = { ok: false, error: err.message.slice(0, 100) };
            }
          }
          // Pull: GitHub → Core MongoDB
          if (!push_only) {
            try {
              const pullResult = await post(apiPath`/deploy/solutions/${sol.id}/github/pull`, {}, sid);
              entry.pull = { ok: true, skills: pullResult.skills?.length, connectors: pullResult.connectors?.length };
            } catch (err) {
              entry.pull = { ok: false, error: err.message.slice(0, 100) };
            }
          }
          results.push(entry);
        }
      } catch (err) {
        results.push({ tenant: t.id, error: err.message });
      }
    });
    const pushCount = results.filter(r => r.push?.ok).length;
    const pullCount = results.filter(r => r.pull?.ok).length;
    const errors = results.filter(r => r.error || r.push?.ok === false || r.pull?.ok === false).length;
    return {
      ok: errors === 0,
      summary: `Synced ${tenants.length} tenant(s), ${results.length} solution(s). Push: ${pushCount} ok. Pull: ${pullCount} ok. Errors: ${errors}.`,
      results,
    };
  },
};

// ─── Response formatting ────────────────────────────────────────────

// Max characters to send back in a single tool response.
// Larger payloads get summarized to avoid overwhelming LLM context.
const MAX_RESPONSE_CHARS = 50_000;

/**
 * Format tool results — summarize oversized payloads.
 */
// Exported for test/spec-topics.test.mjs: the truncation is asserted against
// a REAL oversized payload, not against a regex over this file.
export { formatResult as formatResultForTest };

function formatResult(result, toolName) {
  const json = JSON.stringify(result, null, 2);

  if (json.length <= MAX_RESPONSE_CHARS) {
    return json;
  }

  // For large responses, provide a summary + truncated data
  const summary = summarizeLargeResult(result, toolName);
  // A summarizer that produced COMPLETE, valid JSON — one that indexed what it
  // omitted instead of cutting mid-token — must not have an English sentence
  // stapled to the end of it. That sentence is what made the output
  // unparseable, and it says "truncated" about a document that already
  // explains its own omissions in a field.
  if (summary.startsWith("{") && summary.includes('"_truncation"')) return summary;
  return summary + `\n\n(Response truncated from ${json.length.toLocaleString()} chars. Use more specific queries to get smaller results.)`;
}

/**
 * Create a useful summary for large results.
 */
function summarizeLargeResult(result, toolName) {
  // Spec responses — drop the BIGGEST section, keep every other one WHOLE.
  //
  // This used to `.slice(0, MAX_RESPONSE_CHARS)` a pretty-printed document,
  // which fails twice: the output is truncated mid-token and is no longer
  // valid JSON, and everything after the cut is gone with no mention that it
  // existed. /spec/capabilities — the topic bootstrap names as the FIRST call
  // an agent should make — is ~50KB, of which `questions` is ~45KB. So the cut
  // landed inside `questions` and took `composing_several` and
  // `if_your_question_is_not_here` with it. The reader could not tell: a
  // truncated doc looks exactly like a short one.
  //
  // Sections are dropped largest-first, each replaced by a stub that says what
  // it was and how to fetch it, until the whole thing fits. Valid JSON, and
  // nothing vanishes silently — see summarizeSpecResult.
  if (toolName === "ateam_get_spec" && result && typeof result === "object" && !Array.isArray(result)) {
    return summarizeSpecResult(result);
  }

  // Validation results — keep errors/warnings, trim echoed input
  if ((toolName === "ateam_validate_skill" || toolName === "ateam_validate_solution") && result) {
    const slim = { ...result };
    if (slim.skill) delete slim.skill;
    if (slim.solution) delete slim.solution;
    const slimJson = JSON.stringify(slim, null, 2);
    if (slimJson.length <= MAX_RESPONSE_CHARS) return slimJson;
  }

  // Export results — summarize structure
  if (toolName === "ateam_get_solution" && result?.skills) {
    return JSON.stringify({
      _note: `Solution with ${result.skills.length} skill(s). Use ateam_get_solution with skill_id to inspect individual skills.`,
      solution_id: result.solution?.id || result.id,
      skill_ids: result.skills.map(s => s.id || s.name),
      ...result,
    }, null, 2).slice(0, MAX_RESPONSE_CHARS);
  }

  // Generic fallback — truncate
  return JSON.stringify(result, null, 2).slice(0, MAX_RESPONSE_CHARS);
}

// How many names (omitted-entry ids, stubbed-object keys, section names) an
// index may LIST. The index exists so nothing vanishes silently; it must not
// itself become what blows the cap — 200,000 omitted ids listed in full came
// to 3.3MB. Every list is capped here and paired with an EXACT count.
const MAX_INDEX_NAMES = 200;

/**
 * Fit an oversized spec document under MAX_RESPONSE_CHARS without ever cutting
 * mid-token. The CAP IS A CEILING: this returns valid JSON of at most
 * MAX_RESPONSE_CHARS characters for ANY input object.
 *
 * 360fb78 replaced the old `.slice(0, MAX_RESPONSE_CHARS)` with a budget check
 * that could not enforce it: it charged 2 chars for a _truncation sentence of
 * hundreds, ran BEFORE the partial-array wrapper replaced the raw array, never
 * considered a STRING section, and listed every omitted id. So "fits" was a
 * guess, and a 300KB string section came back whole under "nothing omitted".
 * Now every check measures the document that will actually be returned.
 */
function summarizeSpecResult(result) {
  // Through the TOOL: the reader is an MCP client and cannot GET anything, yet
  // this said "GET /spec/<topic> directly" (360fb78). The Builder (#67) serves a
  // page too big for one answer with a `_read_it_in_parts` index — small and
  // first, so it survives the cut below — and returns any part whole for
  // search:"<id>".
  const how = "Call ateam_get_spec again with the same topic (and section, if you gave one) plus search:\"<id>\" — " +
    (result._read_it_in_parts
      ? "_read_it_in_parts at the top of this page lists the id of every part, and each part comes back WHOLE."
      : "an entry id named here returns the entries that match it.") +
    " ateam_spec_search finds the entry you need when you do not know its id.";
  const sizeOf = (v) => JSON.stringify(v ?? null).length;
  // The pretty-printed length of one top-level entry. Swapping a section's
  // value changes the whole document's length by exactly the difference of
  // this, which is what lets the budget be tracked without re-rendering the
  // document for every candidate (3,000 small sections took 6s that way).
  const entryLen = (k, v) => JSON.stringify({ [k]: v }, null, 2).length;
  // Names at most MAX_SENTENCE_NAMES sections — the sentence is part of the
  // budget too, and thousands of names would blow it on their own.
  const MAX_SENTENCE_NAMES = 20;
  const sentence = (list) => list.length
    ? `${list.length} section(s) were too large to inline and are indexed rather than included: ${list.slice(0, MAX_SENTENCE_NAMES).join(", ")}`
      + (list.length > MAX_SENTENCE_NAMES ? `, and ${list.length - MAX_SENTENCE_NAMES} more, each stubbed in place` : "")
      + ". EVERY OTHER SECTION BELOW IS COMPLETE."
    : "nothing omitted";
  const out = { ...result };
  let omitted = [];
  // served_by is not a section of the doc: it says which environment sent it
  // (withServedBy), and it stays on every shape returned here, index included.
  const sectionNames = Object.keys(result).filter((k) => k !== "served_by");
  const render = () => JSON.stringify({ _truncation: sentence(omitted), sections: sectionNames, ...out }, null, 2);
  // Exact length of render(), kept current by entry differences. The final
  // render below is still measured for real before anything is returned.
  let size = render().length;
  const sentenceDelta = (list) => entryLen("_truncation", sentence(list)) - entryLen("_truncation", sentence(omitted));

  // TOTAL, not best-effort: an entry with no id/q/name is named by its
  // position. `.filter(Boolean)` used to drop it, and the document then said
  // "the rest are indexed below" over an empty array.
  const idOf = (e, i) => {
    const v = e && typeof e === "object" ? (e.id ?? e.q ?? e.name) : undefined;
    return v === undefined || v === null || v === "" ? `#${i}` : String(v);
  };
  const partial = (value, k, whole) => {
    const missing = value.length - k;
    const named = value.slice(k, k + MAX_INDEX_NAMES).map((e, i) => idOf(e, k + i));
    return {
      _partial: `${k} of ${value.length} entries included; the other ${missing} are indexed below (${whole.toLocaleString()} chars whole).`,
      _how_to_read_the_rest: how,
      not_included_count: missing,
      not_included_ids: named,
      ...(missing > named.length && { not_included_ids_note: `${missing - named.length} more not listed by id — ${how}` }),
      included: value.slice(0, k),
    };
  };
  const stub = (value, whole) => {
    if (typeof value === "string") {
      return { _omitted: `too large to inline (${whole.toLocaleString()} chars of text)`, _how_to_read_it: how, length: value.length };
    }
    const keys = Object.keys(value);
    return {
      _omitted: `too large to inline (${whole.toLocaleString()} chars)`,
      _how_to_read_it: how,
      // The index survives even when the content cannot — knowing WHAT is in
      // there is most of the value, and it is what the tail-slice ate.
      count: keys.length,
      keys: keys.slice(0, MAX_INDEX_NAMES),
      ...(keys.length > MAX_INDEX_NAMES && { keys_note: `${keys.length - MAX_INDEX_NAMES} more not listed` }),
    };
  };

  // Largest first — dropping one 45KB section beats dropping ten small ones.
  // STRINGS count: a document whose bulk is one text section used to have no
  // reduction candidate at all.
  const bySize = Object.keys(out)
    .filter((k) => (typeof out[k] === "object" && out[k] !== null) || typeof out[k] === "string")
    .sort((a, b) => sizeOf(out[b]) - sizeOf(out[a]));

  for (const key of bySize) {
    if (size <= MAX_RESPONSE_CHARS) break;
    const value = out[key];
    const whole = sizeOf(value);
    const current = entryLen(key, value);

    if (Array.isArray(value)) {
      // Fill the remaining budget with WHOLE entries rather than dropping all
      // of them — partial beats absent, as long as the reader is told which
      // entries are missing. Binary search over the kept count; every trial is
      // costed with the real wrapper AND the real _truncation sentence.
      const trial = (k) => {
        const wrapped = partial(value, k, whole);
        const list = [...omitted, `${key} (${k}/${value.length} included)`];
        return { wrapped, list, size: size - current + entryLen(key, wrapped) + sentenceDelta(list) };
      };
      let lo = 0, hi = value.length - 1, best = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const t = trial(mid);
        if (t.size <= MAX_RESPONSE_CHARS) { best = t; lo = mid + 1; } else hi = mid - 1;
      }
      const chosen = best || trial(0);
      if (chosen.size >= size) continue;   // wrapping saves nothing
      out[key] = chosen.wrapped; size = chosen.size; omitted = chosen.list;
    } else {
      const replacement = stub(value, whole);
      const list = [...omitted, key];
      const next = size - current + entryLen(key, replacement) + sentenceDelta(list);
      if (next >= size) continue;          // a stub bigger than the section saves nothing
      out[key] = replacement; size = next; omitted = list;
    }
  }

  const text = render();
  if (text.length <= MAX_RESPONSE_CHARS) return text;

  // THE BACKSTOP. Every large section is already indexed and it is STILL over
  // (thousands of small sections, say). Return the index alone — still valid
  // JSON, still naming the sections, never a mid-token cut.
  const index = {
    _truncation: `This spec document is ${sizeOf(result).toLocaleString()} chars and exceeds the ${MAX_RESPONSE_CHARS.toLocaleString()}-char response cap even with its large sections indexed, so only its index is returned. ${how}`,
    ...(typeof result.served_by === "string" && { served_by: result.served_by }),
    ...(typeof result.topic === "string" && result.topic.length <= 100 && { topic: result.topic }),
    section_count: sectionNames.length,
    sections: sectionNames.slice(0, MAX_INDEX_NAMES),
    ...(sectionNames.length > MAX_INDEX_NAMES && { sections_note: `${sectionNames.length - MAX_INDEX_NAMES} more not listed` }),
  };
  const indexText = JSON.stringify(index, null, 2);
  if (indexText.length <= MAX_RESPONSE_CHARS) return indexText;
  // Only section NAMES long enough to blow the cap on their own get here.
  delete index.sections;
  index.sections_note = `${sectionNames.length} section names, too long to list`;
  return JSON.stringify(index, null, 2);
}

// Failure classification (isError + a machine-readable code, WITHOUT parsing
// English) lives in ./mcpFailure.js — imported at the top — so the rule is
// unit-testable in isolation (mcpFailure.test.js).

// ─── Dispatcher ─────────────────────────────────────────────────────

/**
 * WHY THIS SESSION IS NOT SIGNED IN — the gate's diagnosis, for how the session
 * is connected (signInContext). One paragraph for every transport used to name
 * ADAS_API_KEY and "the MCP server restarted" to the platform and to hosted
 * sessions alike, where neither is the cause.
 *
 * "No authentication found." was TRUE and pointed at the WRONG CAUSE: a sign-in
 * made with ateam_auth lives in memory and does not survive a restart, so a
 * rebuild silently logged out every such session and the message read like a
 * first-time setup problem (2026-08-21: a Builder deploy logged out a live
 * session mid-work). So where a restart can be the cause, both are stated.
 */
export const WHY_NOT_SIGNED_IN = Object.freeze({
  // The platform signs each workspace in before its calls: a refusal here is a
  // call that arrived first, and it replays on stage auth_gate (below).
  platform: "The A-Team platform had not signed a workspace in on this session when the call arrived.",
  stdioEnvKey:
    "An ADAS_API_KEY is set in this process's environment, but it does not sign a session in and is never sent: " +
    "a key baked into a shared config could point work at the wrong workspace. This process signs in with ateam_auth (below).",
  stdioRestart:
    "No sign-in in this local process. TWO CAUSES, and the second is easy to miss:\n" +
    "  (a) it never signed in, or\n" +
    "  (b) IT RESTARTED. A sign-in made with ateam_auth lives in this process's memory, so when the client restarts\n" +
    "      the process, the sign-in is gone.\n" +
    "If your tools were working minutes ago, it is (b) — nothing is misconfigured: sign in again the same way.",
  hosted:
    "This connection carries no workspace sign-in. TWO CAUSES:\n" +
    "  (a) the client connected without completing the A-Team sign-in, or with a key the API could not resolve, or\n" +
    "  (b) the session was signed in with ateam_auth, and THE MCP SERVER RESTARTED: that sign-in lives in memory and\n" +
    "      does not survive a redeploy. A sign-in made on the A-Team page does.\n" +
    "Either way, the user signs in again (below).",
});

function whyNotSignedIn(ctx) {
  if (ctx.audience === "platform") return WHY_NOT_SIGNED_IN.platform;
  if (ctx.audience === "stdio") return envApiKeyPresent() ? WHY_NOT_SIGNED_IN.stdioEnvKey : WHY_NOT_SIGNED_IN.stdioRestart;
  return WHY_NOT_SIGNED_IN.hosted;
}

export async function handleToolCall(name, args, sessionId) {
  const handler = handlers[name];
  if (!handler) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  // Master mode: per-call tenant override (no re-auth needed). BEFORE
  // touchSession: this call's solution and actor belong to the tenant it names,
  // and touchSession writes them into the record the call acts as. Run after
  // it (94b9bc0), they went into the previous tenant's record, which a call
  // already in flight as that tenant still holds. isMasterMode implies an
  // explicit ateam_auth, so this does not get ahead of the auth gate below.
  if (!PUBLIC_TOOLS.has(name) && isMasterMode(sessionId) && args?.tenant) {
    switchTenant(sessionId, args.tenant);
  }

  // Track activity + context on every tool call (keeps session alive, records what user is working on)
  touchSession(sessionId, {
    toolName: name,
    solutionId: args?.solution_id,
    skillId: args?.skill_id,
    // Remember WHO is acting, so every later per-job read carries it. See the
    // long note in api.js touchSession: threading actor_id per tool left five of
    // six job-facing tools unable to express it at all.
    actorId: args?.actor_id,
  });

  // THE AUTH GATE — DENY BY DEFAULT. Every tool needs an EXPLICIT sign-in
  // (ateam_auth, or a bearer the user authorized: http.js seedCredentials)
  // unless publicTools.js lists it. Env vars (ADAS_API_KEY / ADAS_TENANT) are
  // NOT a sign-in: baked into an MCP config, they would silently target the
  // wrong tenant. This was an allow-list of tenant tools (TENANT_TOOLS,
  // eb5e007) that fifteen later tools never joined, so they ran on that env
  // fallback — promote, rollback and repo writes among them.
  if (!PUBLIC_TOOLS.has(name) && !isExplicitlyAuthenticated(sessionId)) {
    const ctx = signInContext(sessionId);
    return {
      content: [{
        type: "text",
        text: [
          `Authentication required — this session is not signed in to a workspace (tenant), so ${name} was refused before it ran.`,
          "",
          whyNotSignedIn(ctx),
          "",
          // The steps are signInSteps.js's, word for word, for how this
          // session is connected. c61e60b said "Get their API key at
          // …/get-api-key, then call ateam_auth(api_key)" — an agent asking for
          // the key; 0f5f4d3 (MGAP-A1) said to authorize in the browser, with
          // ateam_auth "for a local setup". The device-code sign-in is a
          // separate design.
          connectSteps(ctx),
          "",
          NO_KEY_IN_CHAT,
          "",
          // The ONE list (publicTools.js). Three hand-written lists — here,
          // in ateam_auth's description and in the opening — had drifted apart.
          NO_SIGN_IN_NEEDED,
        ].join("\n"),
      }],
      isError: true,
      // `stage: "auth_gate"` is the ONE mark of a refusal given BEFORE the tool
      // ran. The code alone is not: deriveErrorCode (below) also answers
      // UNAUTHENTICATED for a tool that already ran and then failed with text
      // that matches AUTH_SIGNAL_RX, e.g. "GitHub 401 Bad credentials" after a
      // promote had merged. ateam-proxy-mcp signs in again and REPLAYS the call
      // on this mark, and only on it, so a replay can never run a tool twice.
      // Only this line sets `stage`: handlers never build structuredContent.
      structuredContent: { ok: false, code: "UNAUTHENTICATED", stage: "auth_gate" },
    };
  }

  try {
    const result = await handler(args, sessionId);

    // An actor id comes back here: ateam_conversation/ateam_test_skill return
    // the thread as actor_id, and the docs tell callers to pass it back for
    // multi-turn. For a key with a person the thread is that person (ran_as); a
    // key with none gets a test_ thread key, which api.js drops. Learn it on the way out so the
    // follow-up ateam_get_execution_logs / ateam_get_metrics on that very job
    // is not refused for not knowing who ran it — the single most common dead
    // end when debugging a run.
    //
    // ONLY FROM TOOLS THAT ACTUALLY MINT ONE. This used to accept `actor_id` off
    // ANY tool's result, so a single unrelated payload carrying that field
    // silently repointed the whole session — observed on a clean e2e where every
    // later call 401'd with `Actor "dev" not found`, from an agent that had
    // never sent an actor at all. A session that binds to a non-existent actor
    // never recovers on its own, because nothing ever unbinds it.
    //
    // The generated-thread-key filter in api.js does not help here: it rejects
    // test_<ts>_<rand>, and a short literal like "dev" walks straight past it.
    // An allow-list of minting tools is the honest boundary — "who ran this job"
    // is knowledge only the tools that START a job possess.
    if (result && typeof result === "object" && result.actor_id && ACTOR_MINTING_TOOLS.has(name)) {
      touchSession(sessionId, { actorId: result.actor_id });
    }

    // Stamp WHERE this landed (tenant + app URL) on mutating-tool results, so
    // any client — desktop, mobile, cloud agent — can tell the user where to
    // see the change. Non-fatal + only for object results that don't already
    // carry it.
    if (STAMP_WHERE_TOOLS.has(name) && result && typeof result === "object" && !Array.isArray(result) && !result._where) {
      try { result._where = getWhere(sessionId); } catch { /* never break a tool on labeling */ }
    }

    // For ateam_bootstrap, inject session context so the LLM knows what the user was working on
    if (name === "ateam_bootstrap") {
      const ctx = getSessionContext(sessionId);
      if (ctx.activeSolutionId || ctx.lastSkillId) {
        result.session_context = {
          _note: "This user has an active session. You can reference their previous work.",
          active_solution_id: ctx.activeSolutionId || null,
          last_skill_id: ctx.lastSkillId || null,
          last_tool_used: ctx.lastToolName || null,
        };
      }
      // If signed in, attach a tenant onboarding block so the agent can
      // discover existing solutions + their repo URLs without extra round-trips.
      // This is what lets a fresh agent clone the right repo on first greet.
      // SIGNED IN means the gate's own test. It read getCredentials, which
      // falls back to ADAS_API_KEY, so a signed-out session listed the env
      // key's workspace here while the gate refused the same read.
      try {
        const creds = getCredentials(sessionId);
        if (isExplicitlyAuthenticated(sessionId)) {
          const listed = await handlers.ateam_list_solutions({}, sessionId);
          const solutions = Array.isArray(listed?.solutions) ? listed.solutions : [];
          if (solutions.length > 0) {
            result.tenant_onboarding = {
              _note: "The authed key can see these solutions. For LOCAL development: clone the repo_url and open any Claude-Code-compatible agent in that directory — it will auto-load CLAUDE.md on session start. For REMOTE-only work: call ateam_github_read(solution_id, 'CLAUDE.md') to fetch the onboarding doc. If `git clone` returns 403, ask the solution owner to add your GitHub account as a collaborator on the repo (GitHub access is separate from the A-Team API key).",
              tenant: creds.tenant || null,
              solutions: solutions.map((s) => ({
                id: s.id,
                name: s.name,
                repo_url: s.repo_url || null,
                default_branch: s.default_branch || "main",
                has_claude_md: s.has_claude_md ?? null,
                clone_command: s.repo_url ? `git clone ${s.repo_url}` : null,
              })),
            };
          }
        }
      } catch { /* non-fatal — unauthed sessions or API blips shouldn't break bootstrap */ }
    }

    const text = formatResult(result, name);
    if (isLogicalFailure(result, { verdict: VERDICT_TOOLS.has(name) })) {
      // Logical failure RETURNED (not thrown) — e.g. { ok:false, message:"…
      // Authentication required" } or an upstream 200-with-auth-text. Flag it
      // so a caller detects it from isError/code, not by reading the prose.
      // The sentence stays in content[].text for the reasoning loop.
      //
      // The code is read from the fields that CARRY the failure, never from
      // the whole payload. With neither message nor error this fell back to
      // `text` — every byte of the result — so a path, a quoted log line or any
      // number 401 in the data came back UNAUTHENTICATED, the one code that
      // sends ateam-proxy-mcp to sign the tenant in again.
      const code = deriveErrorCode(result.message || result.error || "", result.code);
      return {
        content: [{ type: "text", text }],
        isError: true,
        structuredContent: { ok: false, code },
      };
    }
    return {
      content: [{ type: "text", text }],
    };
  } catch (err) {
    const code = deriveErrorCode(err.message, err.code);
    return {
      content: [{ type: "text", text: err.message }],
      isError: true,
      structuredContent: { ok: false, code },
    };
  }
}

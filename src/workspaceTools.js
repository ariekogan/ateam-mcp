/**
 * The session workspace tools (Phase C, Docs/WIP/PHASE_C_DESIGN.md section 2,
 * branch C3c): the pure parts. tools.js holds the definitions' handlers and the
 * dispatcher; this leaf holds what must be testable alone — which tools are
 * withheld while a workspace is open, the refusal sentence, and how an answer
 * from Core is shaped for the model.
 *
 * WHO THESE ARE FOR. A chat agent (ChatGPT, Claude.ai) with NO shell of its
 * own, working for a business user. It gets one container for the length of the
 * conversation (files in /workspace) through ateam_workspace_exec, and the work
 * goes live only through ateam_workspace_save. The text below teaches exactly
 * that, and never lets a git word reach the user.
 */

export const WORKSPACE_TOOL_NAMES = Object.freeze([
  "ateam_workspace_open",
  "ateam_workspace_exec",
  "ateam_workspace_status",
  "ateam_workspace_save",
  "ateam_workspace_close",
]);

/**
 * The tools that write `dev` (or the Builder's copy that is pushed to it) by the old route. While this MCP session has
 * a workspace open they are not listed and a call is refused: otherwise a file tool and `save` land on `dev` from
 * different clones (the two-writers failure, design section 2). ateam_github_promote, the reads, the tests and the
 * deploys that read `dev` stay: they are how the saved work is checked and shipped.
 */
export const WORKSPACE_WITHHELD = Object.freeze(new Set([
  "ateam_github_patch", "ateam_github_write", "ateam_github_push", "ateam_github_pull",
  "ateam_github_reconcile", "ateam_github_sync_from_main", "ateam_github_rollback",
  "ateam_build_and_run", "ateam_write_agent_doc", "ateam_patch",
  "ateam_upload_connector", "ateam_upload_connector_files", "ateam_create_connector", "ateam_create_plugin",
  "ateam_recover_connector_source", "ateam_sync_all",
  "ateam_delete_solution", "ateam_delete_skill", "ateam_delete_connector",
]));

/** The one plain sentence a refused old writer returns. No git word: this reaches a chat agent that may repeat it. */
export function withheldSentence(toolName) {
  return `${toolName} is switched off while your workspace is open, so two sets of edits cannot collide. `
    + "Make the change in the workspace (ateam_workspace_exec), then call ateam_workspace_save to make it live; "
    + "or call ateam_workspace_close first to use this tool again.";
}

/** Tool arguments that would name WHO or WHERE. Never accepted: the key says it. */
export const WORKSPACE_FORBIDDEN_ARGS = Object.freeze(["tenant", "tenant_id", "actor_id", "actorId", "actor", "chain_id", "chainId", "user", "user_id"]);

export function forbiddenArgIn(args) {
  if (!args || typeof args !== "object") return null;
  return WORKSPACE_FORBIDDEN_ARGS.find((k) => Object.hasOwn(args, k)) || null;
}

// Codes that mean "this id no longer names a workspace you can use": forget it, so the next open starts clean
// and the old writers come back. A transient refusal (a save running, bad arguments) does NOT forget it.
const GONE_CODES = new Set([
  "WORKSPACE_CLOSED", "WORKSPACE_EXPIRED", "WORKSPACE_NOT_FOUND",
  "DEV_WORKSPACE_NOT_AVAILABLE", "WORKSPACES_SWITCHED_OFF",
]);

/**
 * What the session should remember after `method` answered `result`.
 * @returns {{set?: string}|{clear: true}|{}} nothing to change, a workspace_id to remember, or clear
 */
export function workspaceMemoryAfter(method, result) {
  if (!result || typeof result !== "object") return {};
  if (method === "open") {
    // A refused open clears: the work continues with the single-file tools, which come back.
    if (result.ok === false) return { clear: true };
    return result.workspace_id ? { set: String(result.workspace_id) } : {};
  }
  if (result.ok === false) return GONE_CODES.has(result.code) ? { clear: true } : {};
  if (method === "close") return result.state === "closed" || result.state === "expired" ? { clear: true } : {};
  return result.workspace_id ? { set: String(result.workspace_id) } : {};
}

const KEYS_FIRST = ["ok", "summary", "next_step", "use_instead"];

/**
 * Shape Core's answer for the model: `summary` FIRST, then what to do next, then the rest, `details` LAST.
 * The model is told to show the user the summary only; putting it first makes that the easy thing to do.
 * Adds nothing the answer does not say, except a plain `next_step` for the three states that need one.
 */
export function shapeWorkspaceResult(method, result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const { details, fallback, error, ...rest } = result;
  const summary = typeof rest.summary === "string" && rest.summary ? rest.summary : (typeof error === "string" ? error : undefined);
  delete rest.summary;

  const out = {};
  if (typeof rest.ok === "boolean") out.ok = rest.ok;
  if (summary) out.summary = summary;

  const step = nextStep(method, result);
  if (step) out.next_step = step;

  // A refusal carries the tools that work without a workspace. The agent uses them; it does not give up.
  if (Array.isArray(fallback) && fallback.length) {
    out.use_instead = {
      tools: fallback,
      how: `That was not done in a workspace. Carry on with ${fallback.join(" / ")} instead (one file per call); do not stop and do not ask the user to do it.`,
    };
  }

  for (const [k, v] of Object.entries(rest)) if (!KEYS_FIRST.includes(k)) out[k] = v;
  if (details !== undefined) out.details = details;
  return out;
}

function nextStep(method, r) {
  // A save that outlived Core's wait is still running: it is not an error and not done.
  if (r.state === "saving" || r.save?.state === "running") {
    return method === "close"
      ? "The save is still going. Wait a minute, then call ateam_workspace_close again (or ateam_workspace_status to see how the save ended)."
      : "The save is still going and nothing is lost. Wait a minute, then call ateam_workspace_status (or ateam_workspace_save again) to see how it ended. Do not tell the user it is live until a call says so.";
  }
  if (method === "exec" && r.ok && r.details?.task_id) {
    return "The command is running in the background. Follow it by reading its output file with ateam_workspace_exec (for example tail -n 50 on details.output_file), and poll ateam_workspace_status until it is done.";
  }
  if (method === "exec" && r.code === "DEV_TIMEOUT") {
    return "The command ran past the 100 second limit and was stopped. Run it again with run_in_background: true and poll.";
  }
  return null;
}

// ─── Teaching text ─────────────────────────────────────────────────────────

const USER_RULE = "The user is a business user: show them only the result's `summary`, in your own plain words, and never any branch, commit, merge or other git word (`details` is for you).";

export const WORKSPACE_DESCRIPTIONS = Object.freeze({
  open:
    "Open your workspace for this solution: a private folder with a real command line, so you can read, edit and run code. " +
    "Use it for anything bigger than a one-line change (ateam_github_patch/write do one file per call). " +
    "Your files are in /workspace (the solution is already there). Run commands with ateam_workspace_exec. " +
    "The other ateam_* tools cannot see your edits until you call ateam_workspace_save; only saving makes them live. " +
    "Safe to call again: you get the workspace you already have, with any earlier unsaved work brought back. " +
    "While it is open the single-file write tools (ateam_github_patch, ateam_github_write, ateam_build_and_run and the like) are switched off; ateam_workspace_close brings them back. " +
    "Takes no arguments: never pass a workspace, tenant or person. " + USER_RULE + " A refusal lists `use_instead` tools: use them.",
  exec:
    "Run ONE shell command in your workspace (you have no shell of your own; this is it). Files live in /workspace: read with cat/ls/grep, edit with sed, heredocs or git apply, run npm test, node, python. " +
    "Network reaches only npm, PyPI and the A-Team gateway. workspace_id is optional once you have opened one. " +
    "A foreground command is stopped after 100 seconds: for a long build or test pass run_in_background:true, then read its output file with another exec and poll ateam_workspace_status. " +
    "What you change is NOT live and the other ateam_* tools cannot see it until ateam_workspace_save. " +
    "The answer has `summary` first, then exit_code, stdout, stderr. " + USER_RULE + " A refusal lists `use_instead` tools: use them.",
  status:
    "Check your workspace: whether it is open, whether it holds changes that are not saved yet, and how a long save or background command is going. " +
    "Call it after run_in_background, or when ateam_workspace_save said the save is still going, until it says it is done. " +
    "workspace_id is optional once you have opened one. Changes nothing. " + USER_RULE,
  save:
    "Make the work in your workspace live. This is the only way the other ateam_* tools (ateam_status_all, ateam_test_skill, ateam_verify...) see your edits. " +
    "Optional `message`: a short sentence about what changed, in plain words. " +
    "It can take minutes: if the answer says the save is still going, wait a minute and call ateam_workspace_status (or this tool again); do not tell the user it is live until it says so. " +
    "If someone else changed the same files you get the file names: combine the two versions in the workspace and save again. " +
    "workspace_id is optional once you have opened one. " + USER_RULE + " A refusal lists `use_instead` tools: use them.",
  close:
    "Finish with your workspace. save:true saves it first (like ateam_workspace_save), then closes; without it, unsaved work is kept as a draft that comes back the next time you open a workspace. " +
    "Closing brings back the single-file write tools (ateam_github_patch, ateam_build_and_run...). " +
    "If the answer says the save is still going, the workspace stays open: wait a minute and close again. " +
    "workspace_id is optional once you have opened one. " + USER_RULE,
});

export const WORKSPACE_ID_PROP = Object.freeze({
  type: "string",
  description: "The workspace id from ateam_workspace_open. Leave it out: this session remembers it.",
});

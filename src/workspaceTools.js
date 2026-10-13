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
  "ateam_github_sync_from_main", "ateam_github_rollback",
  "ateam_build_and_run", "ateam_write_agent_doc", "ateam_patch",
  "ateam_upload_connector_files", "ateam_create_connector", "ateam_create_plugin",
  "ateam_recover_connector_source", "ateam_sync_all",
  "ateam_delete_solution", "ateam_delete_skill", "ateam_delete_connector",
]));

/**
 * ateam_upload_connector is withheld only in the forms that WRITE (files, replace): those would land edits beside the workspace's.
 * `github:true` with no files only deploys what was saved, so it stays available: it is the way to redeploy a connector from the workspace.
 */
export function uploadConnectorWrites(args) {
  const a = args && typeof args === "object" ? args : {};
  if ((a.resume === true || a.resume === "true") && typeof a.job_id === "string" && a.job_id) return false; // waits for an upload already started; writes nothing
  const hasFiles = Array.isArray(a.files) ? a.files.length > 0 : a.files != null;
  return !(a.github === true && !hasFiles && a.replace !== true);
}

/** The one plain sentence a refused old writer returns. No git word: this reaches a chat agent that may repeat it. */
export function withheldSentence(toolName) {
  const why = `${toolName} is switched off while your workspace is open, so two sets of edits cannot collide. `;
  if (toolName === "ateam_upload_connector") {
    return why + "Edit the connector in the workspace and call ateam_workspace_save (it deploys what you saved); "
      + "to redeploy a connector from what is saved, call ateam_upload_connector again with github:true and no files.";
  }
  if (toolName === "ateam_build_and_run") {
    return why + "Saving already deploys your work: call ateam_workspace_save. To test what is deployed, ateam_test_skill and ateam_conversation work while the workspace is open. "
      + "This tool deploys the shipped version instead; call ateam_workspace_close first if that is what you want.";
  }
  return why + "Make the change in the workspace (ateam_workspace_exec), then call ateam_workspace_save to make it live; "
    + "or call ateam_workspace_close first to use this tool again.";
}

/** The sentence that refuses this call while a workspace is open, or null when the call is allowed. */
export function withheldCall(toolName, args) {
  if (WORKSPACE_WITHHELD.has(toolName)) return withheldSentence(toolName);
  if (toolName === "ateam_upload_connector" && uploadConnectorWrites(args)) return withheldSentence(toolName);
  return null;
}

/**
 * HOW LONG A CALL MAY BLOCK. A foreground command is stopped by Core at 100 s, but the chat client gives up on a tool call
 * after about 60 s (seen live, 2026-10-13: "timed out after 60s" before Core's DEV_TIMEOUT could answer), and the proxy
 * between them near 100 s. So a call that leaves the foreground choice open (no run_in_background) and does not ask for a
 * short time limit starts the command in the BACKGROUND and waits for it here, at most QUICK_WAIT_SECONDS: a quick command
 * answers at once, in the shape of a foreground one; a long one answers at that point with the output file to follow.
 * An explicit run_in_background (true or false) is never overridden, and a timeout of QUICK_WAIT_SECONDS or less stays foreground.
 */
export const QUICK_WAIT_SECONDS = 40;

/** The time limit a background start gets when the agent gave none: what a foreground command had (Core stops it at 100 s), not Core's one hour, so a hung command cannot hold one of the 8 task slots. */
export const BACKGROUND_DEFAULT_MS = 100_000;

/** Should this exec start in the background and be waited for? */
export function execWaitsInBackground(timeout, runInBackground) {
  if (typeof runInBackground === "boolean") return false;
  return !(Number(timeout) > 0 && Number(timeout) <= QUICK_WAIT_SECONDS * 1000);
}

/** The command that waits (at most `seconds`) for a background task and prints its end, or that it still runs. Null for a path it will not quote. */
export function waitCommand(outputFile, seconds = QUICK_WAIT_SECONDS) {
  if (typeof outputFile !== "string" || !/^\/[A-Za-z0-9_./-]+\/out$/.test(outputFile)) return null;
  const d = outputFile.slice(0, -4);
  return `d='${d}'; i=0; while [ ! -e "$d/exit" ] && [ $i -lt ${seconds * 4} ]; do sleep 0.25; i=$((i+1)); done; ` +
    `if [ -e "$d/exit" ]; then echo "__EXIT__ $(cat "$d/exit")"; cat "$d/out"; else echo __RUNNING__; fi`;
}

/**
 * The answer of the waiting command as a foreground answer, or null when the task is still running (or the answer is not
 * understood): the caller then returns the background handle it already has.
 */
const BACKGROUND_SENTENCE = "The command is running in the background; read its output file with another command to follow it.";

export function foregroundFromWait(waited, started) {
  const out = waited?.stdout;
  if (!waited || waited.ok !== true || typeof out !== "string") return null;
  const m = /^__EXIT__ (\d+)\n?/.exec(out);
  if (!m) return null;
  const code = Number(m[1]);
  // What the start call said about earlier unsaved work brought back (Core's withRecovery: extra summary sentences and
  // details.recovered / conflicts / failed) belongs to this answer too: it is the first exec after a workspace comes back.
  const d = started?.details || {};
  const hasRecovery = ["recovered", "conflicts", "failed"].some((k) => Array.isArray(d[k]) && d[k].length);
  const extra = hasRecovery && typeof started.summary === "string" ? started.summary.replace(BACKGROUND_SENTENCE, "").trim() : "";
  return {
    ok: true,
    workspace_id: started.workspace_id,
    summary: [code === 0 ? "The command finished." : `The command finished with exit code ${code}.`, extra].filter(Boolean).join(" "),
    exit_code: code,
    stdout: out.slice(m[0].length), // the command's output, errors included (one output file)
    ...(waited.truncated ? { truncated: true } : {}),
    ...(hasRecovery && { details: { recovered: d.recovered || [], conflicts: d.conflicts || [], failed: d.failed || [] } }),
  };
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
  "DEV_WORKSPACE_NOT_AVAILABLE",
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
export function shapeWorkspaceResult(method, result, { keepWorkspace = false } = {}) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const { details, fallback, error, ...rest } = result;
  const summary = typeof rest.summary === "string" && rest.summary ? rest.summary : (typeof error === "string" ? error : undefined);
  delete rest.summary;

  const out = {};
  if (typeof rest.ok === "boolean") out.ok = rest.ok;
  if (summary) out.summary = summary;

  const step = nextStep(method, result);
  if (step) out.next_step = step;

  // A refusal carries the tools that work without a workspace. The agent uses them; it does not give up. Not while the
  // workspace is still remembered: those tools are withheld then, and pointing at them would send the agent into a refusal.
  if (!keepWorkspace && Array.isArray(fallback) && fallback.length) {
    out.use_instead = {
      tools: fallback,
      how: `That was not done in a workspace. Carry on with ${fallback.join(" / ")} instead (one file per call); do not stop and do not ask the user to do it.`,
    };
  }

  for (const [k, v] of Object.entries(rest)) if (!KEYS_FIRST.includes(k)) out[k] = v;
  if (details !== undefined) out.details = details;
  return out;
}

/** The tools that work without a workspace (Core's fallback list), for a failure Core never answered. */
export const SINGLE_FILE_TOOLS = Object.freeze(["ateam_github_patch", "ateam_github_write"]);

/**
 * A call that failed before Core answered (the Builder was down, a 4xx/5xx, a timeout) as plain data, the same shape as a
 * refusal. No hint or error text of the transport: the agent may repeat it to a business user.
 * @param {string} method
 * @param {boolean} timedOut
 * @param {boolean} keepWorkspace the session still remembers a workspace (so the single-file tools stay withheld)
 */
export function workspaceFailure(method, timedOut, keepWorkspace) {
  const long = method === "exec" || method === "save" || method === "close";
  const summary = timedOut
    ? (long
      ? "That took longer than expected and may still be running; nothing is lost. Wait a minute, then call ateam_workspace_status to see how it ended."
      : "The workspace did not answer in time. Try again in a minute.")
    : "The workspace could not be reached just now, so nothing was changed. Try again in a minute.";
  return shapeWorkspaceResult(method, { ok: false, summary, ...(!keepWorkspace && { fallback: [...SINGLE_FILE_TOOLS] }) }, { keepWorkspace });
}

function nextStep(method, r) {
  // A save that outlived Core's wait is still running: it is not an error and not done.
  if (r.state === "saving" || r.save?.state === "running") {
    return method === "close"
      ? "The save is still going. Wait 20-30 seconds, then call ateam_workspace_close again (or ateam_workspace_status to see how the save ended)."
      : "The save is still going and nothing is lost. Wait 20-30 seconds, then call ateam_workspace_status: its save field says how it ended. Do not tell the user it is live until it does.";
  }
  if (method === "exec" && r.ok && r.details?.task_id) {
    return "The command is running in the background. Follow it with ateam_workspace_exec: `tail -n 50 details.output_file` shows the output so far, and `cat \"$(dirname details.output_file)/exit\"` holds the exit code once the command has ended (the file does not exist while it is still running, and never appears if the command was killed: if its time limit has passed and the output stopped growing, treat it as stopped). Poll that every 20 to 30 seconds; to stop it early run `kill -- -$(cat \"$(dirname details.output_file)/pid\")`; ateam_workspace_status does not report background commands.";
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
    "While it is open the single-file write tools (ateam_github_patch, ateam_github_write, ateam_build_and_run and the like) are switched off; ateam_workspace_close brings them back. Saving deploys; ateam_test_skill and ateam_conversation work meanwhile. " +
    "Takes no arguments: never pass a workspace, tenant or person. " + USER_RULE + " A refusal lists `use_instead` tools: use them.",
  exec:
    "Run ONE shell command in your workspace (you have no shell of your own; this is it). Files live in /workspace: read with cat/ls/grep, edit with sed, heredocs or git apply, run npm test, node, python. " +
    "Tools installed and network limits: the `environment` in ateam_workspace_open's answer. workspace_id is optional once you have opened one. " +
    "A quick command answers at once (exit_code, stdout; errors are in stdout). One still running after about 40 seconds is left running; the answer gives an output_file: follow it with another exec every 20-30 s (`tail -n 50 <output_file>`; `cat \"$(dirname <output_file>)/exit\"` holds the exit code once it has ended, and is missing while it runs). status does not show it. For a long command pass a timeout in ms. A command that waits counts as two calls toward the hourly limit. " +
    "What you change is NOT live and the other ateam_* tools cannot see it until ateam_workspace_save. " +
    "The answer has `summary` first, then exit_code and stdout. " + USER_RULE + " A refusal lists `use_instead` tools: use them.",
  status:
    "Check your workspace: whether it is open, whether it holds changes that are not saved yet, and how a long save is going or how the last one ended (not background commands: follow those with ateam_workspace_exec). " +
    "Call it when ateam_workspace_save said the save is still going, until it says it is done. " +
    "workspace_id is optional once you have opened one. Changes nothing. " + USER_RULE,
  save:
    "Make the work in your workspace live. This is the only way the other ateam_* tools (ateam_status_all, ateam_test_skill, ateam_verify...) see your edits. " +
    "Optional `message`: a short sentence about what changed, in plain words. " +
    "It also deploys, and can take over a minute: after about 40 s the answer may say the save is still going; then call ateam_workspace_status in 20-30 s until its save field says how it ended. Do not tell the user it is live until it does. Then test with ateam_test_skill or ateam_conversation (they work while the workspace is open). " +
    "If someone else changed the same files you get the file names: combine the two versions in the workspace and save again. " +
    "workspace_id is optional once you have opened one. " + USER_RULE + " A refusal lists `use_instead` tools: use them.",
  close:
    "Finish with your workspace. save:true saves it first (like ateam_workspace_save), then closes; without it, work that is not saved is kept as a draft that comes back the next time you open a workspace (nothing is kept when everything was saved). " +
    "Closing brings back the single-file write tools (ateam_github_patch, ateam_build_and_run...). " +
    "If the answer says the save is still going, the workspace stays open: wait a minute and close again. " +
    "workspace_id is optional once you have opened one. " + USER_RULE,
});

export const WORKSPACE_ID_PROP = Object.freeze({
  type: "string",
  description: "The workspace id from ateam_workspace_open. Leave it out: this session remembers it.",
});

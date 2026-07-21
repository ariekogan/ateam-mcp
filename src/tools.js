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
  setSessionCredentials, isAuthenticated, isExplicitlyAuthenticated,
  getCredentials, parseApiKey, touchSession, getSessionContext,
  setAuthOverride, switchTenant, isMasterMode, listTenants, getWhere,
} from "./api.js";

// Mutating / stateful tools whose result should carry a `_where` stamp
// (tenant + the app URL to view the change). ateam-mcp is a PUBLIC MCP used
// from non-desktop clients too, so the location must live IN the tool result
// — not only in a desktop plugin's SKILL.md. Read-only/global tools skip it.
const STAMP_WHERE_TOOLS = new Set([
  "ateam_build_and_run", "ateam_patch", "ateam_upload_connector", "ateam_redeploy",
  "ateam_create_skill", "ateam_create_connector", "ateam_create_plugin",
  "ateam_delete_skill", "ateam_delete_connector", "ateam_delete_solution",
  "ateam_github_patch", "ateam_github_write", "ateam_github_push",
  "ateam_github_promote", "ateam_github_rollback",
  "ateam_test_skill", "ateam_test_pipeline", "ateam_test_connector", "ateam_test_notification",
]);
import { renderAgentDocHeader, mergeAgentDoc, AGENT_DOC_SENTINEL } from "./agentDoc.js";

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
// no async API leaks out to agent prompts.
async function pollDeployJob(jobId, sid, { label = 'deploy', maxMs = 15 * 60_000, intervalMs = 2000 } = {}) {
  const start = Date.now();
  let lastStatus = null;
  // URL-encode jobId — older skill-validators returned composite job IDs
  // with literal `/` (e.g. `redeploy-skill-personal-adas/pa-orchestrator-...`)
  // which broke the Express route /deploy/jobs/:jobId. Polling silently
  // 404'd every iteration until the MCP host's stdio idle timeout fired
  // (~30s) and dropped the connection. Encoding here is defense-in-depth
  // even after the server-side fix that replaced `/` with `--`.
  const encodedJobId = encodeURIComponent(jobId);
  while (Date.now() - start < maxMs) {
    await new Promise(r => setTimeout(r, intervalMs));
    try {
      const job = await get(`/deploy/jobs/${encodedJobId}`, sid);
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
    ...(def.tools && { tools: pick(def.tools, "name") }),
    _fields: Object.keys(def),
    _note: "compact summary — pass include_definition:true to ateam_patch for the full definition.",
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

async function verifyWidgetHealth(solution_id, sid) {
  // 1. Declared plugins — solution.ui_plugins[]
  let declared = [];
  try {
    const def = await get(`/deploy/solutions/${solution_id}/definition`, sid);
    const sol = def?.solution || def?.definition || def || {};
    declared = Array.isArray(sol.ui_plugins) ? sol.ui_plugins : [];
  } catch (e) {
    return { ok: false, error: `widget health: could not read solution definition — ${e.message}` };
  }
  if (declared.length === 0) return null; // no widgets → nothing to verify

  // 2. Live catalog — what Core actually discovered/serves right now. Go through
  // the Builder proxy (reliable from any connection), NOT ADAS_CORE_URL directly
  // (unreachable from remote/desktop MCP — the old "fetch failed" flakiness).
  let live = [];
  try {
    const data = await get(`/deploy/solutions/${solution_id}/ui-plugins`, sid);
    live = Array.isArray(data?.plugins) ? data.plugins : [];
  } catch (e) {
    return { ok: false, error: `widget health: could not read live plugin catalog — ${e.message}` };
  }
  const liveById = new Map(live.map((p) => [p?.id, p]));

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
      "Authenticate with A-Team. Required before any tenant-aware operation (reading solutions, deploying, testing, etc.). The user can get their API key at https://mcp.ateam-ai.com/get-api-key. Only global endpoints (spec, examples, validate) work without auth. IMPORTANT: Even if environment variables (ADAS_API_KEY) are configured, you MUST call ateam_auth explicitly — env vars alone are not sufficient. For cross-tenant admin operations, use master_key instead of api_key.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: {
          type: "string",
          description: "Your A-Team API key (e.g., adas_xxxxx)",
        },
        master_key: {
          type: "string",
          description: "Master key for cross-tenant operations. Authenticates across ALL tenants without per-tenant API keys. Requires tenant parameter.",
        },
        tenant: {
          type: "string",
          description: "Tenant name (e.g., dev, main). Optional with api_key if format is adas_<tenant>_<hex>. REQUIRED with master_key.",
        },
        url: {
          type: "string",
          description: "Optional API URL override (e.g., https://dev-api.ateam-ai.com). Use this to target a different environment without restarting the MCP server.",
        },
      },
    },
  },
  {
    name: "ateam_get_spec",
    core: true,
    description:
      "Get the A-Team specification — schemas, validation rules, system tools, agent guides, and templates. Start here after bootstrap to understand how to build skills and solutions. Use 'section' to get just one part of the skill spec (much smaller than the full spec). Use 'search' to find specific fields or concepts across the spec.\n\nWhen designing a persona that orchestrates logic via run_python_script (the Python-as-orchestrator pattern), also fetch topic='python_helpers' — that returns the adas.* helper namespace reference. Skills designed without knowing about adas.* produce 5-10x larger / brittler scripts.\n\nWhen wiring widgets (UI plugins) into a solution, fetch topic='widgets' — that returns the widget spec (catalog model, how_to_use blocks, opener_call shape, persona phrasing rules, binding semantics) so you can declare `ui_plugins` correctly. For the live catalog of widgets actually available in a deployed tenant, use ateam_get_widget_catalog instead.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          enum: ["overview", "skill", "solution", "enums", "connector-multi-user", "python_helpers", "widgets"],
          description:
            "What to fetch: 'overview' = API overview + endpoints, 'skill' = full skill spec, 'solution' = full solution spec, 'enums' = all enum values, 'connector-multi-user' = multi-user connector guide, 'python_helpers' = adas.* helper namespace for run_python_script orchestration (read this when designing personas that read state → call tools → checkpoint → status; without it, scripts hand-roll JSON parsing and tool delegation = 5-10x larger and brittler), 'widgets' = widget (UI plugin) spec: catalog model, how_to_use block shape (solution.json snippet + opener_call + persona_phrasing + binding_notes), and rules for declaring ui_plugins. Pair with ateam_get_widget_catalog for the live per-tenant inventory.",
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
          enum: ["skill", "connector", "connector-ui", "solution", "script-cache-skill", "index"],
          description:
            "Example type: 'skill' = Order Support Agent, 'connector' = stdio MCP connector, 'connector-ui' = UI-capable connector, 'solution' = full 3-skill e-commerce solution, 'script-cache-skill' = fat-tool skill with script_cache opt-in (reference implementation of script-level JIT shortcuts — study this before building any browser-automation skill), 'index' = list all available examples",
        },
      },
      required: ["type"],
    },
  },
  {
    name: "ateam_design_advisor",
    core: true,
    description:
      "CONSULT THIS DURING DESIGN — before and while you design a skill/solution. Describe what you're building; it returns POINTERS to the platform capabilities that fit (per-actor storage, widgets, triggers, sub-agents, mobile data, run-scripts, multi-skill, GitHub, …), each with the /spec topic to read next (via ateam_get_spec) and the tool to wire it. Also returns 'missing' hints (capabilities your goal implies but the design hasn't wired) and lifecycle hints (e.g. connect GitHub when the project will iterate). ADVISORY ONLY — you decide and own the design. Stateless: pass the current design_state each call; consult it as often as you like as the design evolves.",
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
      "Semantic search over the FULL ateam platform /spec documentation — the deep fallback behind ateam_design_advisor. Ask a natural-language 'how do I…' question and get the most relevant doc chunks (with their topic + heading), then read the full topic via ateam_get_spec(topic). Use this when the advisor's pointer isn't enough, or for details/examples on anything — including topics outside the curated capability list. Read-only.",
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
    description:
      "DEPLOY THE CURRENT MAIN BRANCH TO A-TEAM CORE. ⚠️ HEAVIEST OPERATION (60-180s): validates solution+skills → deploys all connectors+skills to Core (regenerates MCP servers) → health-checks → optionally runs a warm test → auto-pushes to GitHub.\n\n" +
      "🌳 DEV/PROD WORKFLOW:\n" +
      "  1. Edit files → ateam_github_patch (writes to `dev` branch by default)\n" +
      "  2. (Optional) Preview what's about to ship → ateam_github_diff\n" +
      "  3. Ship dev → main → ateam_github_promote (merges + auto-tags `prod-YYYY-MM-DD-NNN`)\n" +
      "  4. Deploy main to Core → ateam_build_and_run\n\n" +
      "This tool ALWAYS deploys the `main` branch — there is no `ref` parameter. To deploy in-progress dev work, first promote it.\n\n" +
      "AUTO-DETECTS GitHub repo: if you omit mcp_store and a repo exists, connector code is pulled from main automatically. First deploy requires mcp_store. After that, edit via ateam_github_patch + promote, then build_and_run. For small changes prefer ateam_patch (faster, incremental). Requires authentication.",
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
      "Legacy: wait:false is equivalent to wait_for:'never' — returns job_id immediately for polling via ateam_test_status. wait:true is the same as the default wait_for:'root'.",
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
            "Optional actor ID for conversation continuity. Pass the actor_id from a previous test response to continue the conversation. Omit to auto-generate a test actor (test_<timestamp>_<random>, auto-expires in 24h).",
        },
      },
      required: ["solution_id", "skill_id", "message"],
    },
  },
  {
    name: "ateam_test_notification",
    core: true,
    description:
      "Fire a REAL notification at an existing actor in a deployed solution — for end-to-end testing of the system-initiated notification path (telegram/push/app channels).\n\n" +
      "Unlike ateam_test_skill (synthetic test actor with no channels) and ateam_conversation (user-initiated thread), this calls the /api/internal/notify-user path that PCM and other sibling services use — so the actor's real enabled channels actually receive the message.\n\n" +
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
    description:
      "Send a chat message to a deployed solution. No skill_id needed — the system auto-routes to the right skill.\n\n" +
      "ALWAYS ASYNC: returns a chain_id immediately — the assistant's reply is NOT in this response (a conversation can run for minutes across handoffs + subcalls, so a synchronous wait would hit the 100s edge timeout → 524).\n\n" +
      "POLL BY CHAIN, NEVER BY JOB: an individual job can terminate while the chain is still running, so poll ateam_chain_status(chain_id) on a loop (~2s) and stop when chain_done === true (or pending_question is set — the assistant is waiting on the user). That is the cheap chip-quick poll (Core's whole-chain computeChainStatus — the same thing the standard chat uses). Use ateam_get_chain(chain_id) only ONCE at the end if you want the full tree / per-job detail — it's too heavy to loop on.\n\n" +
      "Multi-turn: pass the actor_id from a previous response back in to continue the same thread (e.g. reply to a confirmation prompt). Each call starts a new chain; the same actor_id maintains conversation context.",
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
          description: "Optional: actor ID from a previous response to continue the conversation. Omit for a new conversation.",
        },
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
      "Simulate a voice conversation with a deployed solution. Runs the full voice pipeline (session → caller verification → prompt → skill dispatch → response) using text instead of audio. Returns each turn with bot response, verification status, tool calls, and entities. Use this to test voice-enabled solutions end-to-end without making a phone call.",
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
      "PREVIEW BEFORE WRITING: pass dry_run:true to see the diff (arrays_merged, arrays_replaced, dropped_ids, added_ids) without applying. Use this before any destructive-looking edit.",
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
            "Where the solution/skill definition lives. 'github' (DEFAULT) — read from and write to the tenant's GitHub repo (GitHub is master; the normal path). 'local' — read from and write to the Builder FS store (no GitHub repo required). Use 'local' ONLY for a repo-less bootstrap tenant (e.g. freshly onboarded from a template, before GitHub is connected). This is a DEDICATED, EXPLICIT switch — never a fallback. Redeploy is local in both modes.",
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
          enum: ["definition", "skills", "health", "status", "export", "validate", "connectors_health"],
          description:
            "What to read: 'definition' = full solution def, 'skills' = list skills, 'health' = live health check, 'status' = deploy status, 'export' = exportable bundle, 'validate' = re-validate from stored state, 'connectors_health' = connector status",
        },
        skill_id: {
          type: "string",
          description: "Optional: read a specific skill by ID (original or internal)",
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
      "⚠️ IRREVERSIBLE — kills Mongo state, running MCP processes, and Builder FS for the whole solution and every skill. " +
      "REQUIRES `confirm:true` AND `confirm_solution_id` echoing the solution id you're destroying (defeats typos and hallucinated ids). " +
      "RECOVERY: the GitHub repo is untouched; `ateam_github_pull` rebuilds the solution from `main`. Prefer that over re-deploying from memory.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID to delete",
        },
        confirm: {
          type: "boolean",
          description: "REQUIRED. Must be exactly true. A missing/false value refuses the call with a recovery hint.",
        },
        confirm_solution_id: {
          type: "string",
          description: "REQUIRED. Must exactly equal `solution_id`. This defeats typos and hallucinated ids — you can't wipe a solution you couldn't spell.",
        },
      },
      required: ["solution_id", "confirm", "confirm_solution_id"],
    },
  },
  {
    name: "ateam_delete_skill",
    core: true,
    description:
      "⚠️ IRREVERSIBLE in Core + Builder FS — kills the running MCP process, unregisters from skill registry, deletes the Mongo record, drops from solution.skills[] and solution.linked_skills, and removes the skill's files from Builder FS. " +
      "REQUIRES `confirm:true`. RECOVERY: the skill still lives in GitHub — `ateam_github_pull` rebuilds the whole solution (no per-skill restore path).",
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
      "GitHub source is preserved — a follow-up `ateam_build_and_run(github:true)` can resurrect. " +
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
    name: "ateam_create_connector",
    core: true,
    description:
      "Scaffold a new MCP connector with server.js + package.json + README. " +
      "Eliminates ~50% of identical boilerplate (MCP server setup, tool registration, " +
      "stdio transport). You then fill in the tool implementations. " +
      "Set ui_capable=true to include ui.listPlugins / ui.getPlugin stubs " +
      "(plugin source files added separately via ateam_create_plugin). " +
      "After scaffolding, the files are uploaded to Core via the same path " +
      "as ateam_upload_connector.",
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
    description:
      "Scaffold a UI plugin (iframe HTML, React Native TSX, or both) inside an existing connector. " +
      "Eliminates ~50% of identical plugin boilerplate (imports, theme/bridge hooks, " +
      "postMessage protocol, default export shape). You then fill in the component body. " +
      "Use kind='iframe' for web-only, 'rn' for mobile-only, 'adaptive' for both. " +
      "Also writes ui-dist/<plugin>/manifest.json with the required render block.\n\n" +
      "⚠️ RENDERING IS NOT AUTOMATIC. At deploy, Phase 5 discovers plugins by calling each connector's " +
      "ui.listPlugins + ui.getPlugin — a plugin only appears (and renders) if the connector ADVERTISES it there " +
      "with a render.{mode, iframeUrl?, reactNative?} block. Dropping the scaffold files alone does NOT register it. " +
      "If the connector generates its plugin list from ui-dist/<plugin>/manifest.json, the emitted manifest is picked up automatically; " +
      "if the connector has a HARDCODED list (e.g. personal-assistant-ui-mcp: UI_PLUGINS[] + PLUGIN_MANIFESTS{} in server.js), you MUST add this plugin there (copy the render block from the manifest.json). " +
      "Verify after deploy with ateam_get_solution(solution_id, 'connectors_health') or ateam_get_widget_catalog. Then declare it at solution ui_plugins[] so a skill can open it via sys.focusUiPlugin (see ateam_get_spec topic:'widgets').\n\n" +
      "The scaffold MERGES into the existing connector (server.js + other files preserved) — works on GitHub-backed AND repo-less tenants; merge base is the GitHub repo when connected, else the deployed connector source.",
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
    description:
      "Upload connector code to Core and restart — WITHOUT redeploying skills.\n\n" +
      "MERGES with the GitHub state at `ref` by default (default ref: 'dev'). Sending a partial file set ONLY overlays those files — the rest of the connector is preserved from GitHub. To fully replace the connector dir (historical behavior), pass replace:true.\n\n" +
      "Modes:\n" +
      "  • github:true (no files)        — deploy the GitHub state at `ref` as-is.\n" +
      "  • github:true + files:[]        — GitHub state at `ref` as BASE, your files overlay on top (incoming wins).\n" +
      "  • files:[] (no github)          — default MERGE with GitHub state at `ref`. Refuses if no GitHub base exists (no silent nuke).\n" +
      "  • files:[] + replace:true       — full replace. Wipes connector dir + writes only the provided files. Use deliberately.\n\n" +
      "Common traps this design prevents:\n" +
      "  • Pre-fix bug (2026-06-06): sending just ui-dist HTML wiped server.js + node_modules — connector broke until a full re-upload. Now: those files merge with the GitHub base.\n" +
      "  • Pre-fix bug: github:true silently read from `main` even when patches were on `dev`. Now: defaults to dev; pass ref:'main' to opt into the legacy path.",
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
              content: { type: "string", description: "File content" },
            },
            required: ["path", "content"],
          },
          description: "Files to upload. By default merges with the GitHub state at `ref`. Set replace:true to wipe the connector dir and write only these files.",
        },
        replace: {
          type: "boolean",
          description: "Opt into FULL REPLACE: wipe the connector dir and write only the provided `files`. Default: false (= merge with GitHub state at `ref`). Use with intent — sending an incomplete file set with replace:true will break the connector.",
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
    core: false,
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
    description:
      "Poll the progress of an async skill test. Returns iteration count, tool call steps, status (running/completed/failed), and result when done.\n\n" +
      "Set include_chain:true to ALSO include the full chain tree (every job in the chain, rooted at this job_id, with parent/child linkage). Use when this job dispatched askAnySkill subcalls and you want a single snapshot of the whole multi-skill state instead of polling each child job_id separately.",
    inputSchema: {
      type: "object",
      properties: {
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
          description: "The job ID returned by ateam_test_skill",
        },
        include_chain: {
          type: "boolean",
          description:
            "If true, includes response.chain — the full chain tree rooted at this job_id (chainJobs[] with parentJobId/relation/depth, executionSteps[] with tool-nesting). Costs one extra Core call. Default false (back-compat).",
        },
      },
      required: ["solution_id", "skill_id", "job_id"],
    },
  },
  {
    name: "ateam_get_chain",
    core: true,
    description:
      "Inspect the full chain tree for any job — rooted at the given job_id, walking down through every handoff and askAnySkill subcall.\n\n" +
      "Use when a chain has already run and you want to analyze the structure: which skill called which, how deep the call tree went, which tool inside which job invoked which sub-tool. The two main shapes:\n" +
      "  • response.chain.chainJobs[] — one entry per job in the chain. Fields: jobId, skill, status, iteration, depth (0 = root, +1 per askAnySkill subcall hop), relation ('root' | 'subcall' | 'handoff'), parentJobId, parentSkill, goal.\n" +
      "  • response.chain.executionSteps[] — every tool call across all chain jobs, tagged with _skill, _jobId, _depth (= job depth), _relation, _parentSkill, _parentJobId, _toolDepth (tool-in-tool nesting via opId/parentOpId).\n\n" +
      "Differs from ateam_test_status by purpose: status is for live polling of a job you just kicked off; get_chain is for post-hoc tree analysis (debugging multi-skill flows, regression testing, comparing two runs).\n\n" +
      "Auth: forwards your authed api_key. Tenant scoped by the key itself. Actor scoping: you can only inspect chains rooted at jobs your actor has access to.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "The root job ID of the chain to inspect (or any job inside the chain — Core walks up to the root).",
        },
        skill_slug: {
          type: "string",
          description: "Optional. The skill slug for the job — speeds up the lookup when the job isn't in memory and must be loaded from storage. Omit if you don't have it; lookup still works but does an extra round-trip.",
        },
      },
      required: ["job_id"],
    },
  },
  {
    name: "ateam_chain_status",
    core: true,
    description:
      "SLIM chain status — the chip-quick poll. Given a chain_id (from ateam_conversation), returns the WHOLE-CHAIN aggregate status cheaply: chain_status + chain_done (true only when the ENTIRE chain — root job + every handoff + askAnySkill subcall — is terminal), plus pending_question, result, and a short progress line.\n\n" +
      "This is what you poll on a loop after ateam_conversation — NOT ateam_get_chain (that returns the full tree; too heavy for periodic polling). A single job can finish while the chain is still running, so poll chain_done, not a job's status.\n\n" +
      "Loop: call every ~2s until chain_done === true (or pending_question is set — the assistant is waiting on the user). Then read `result` / fetch the full tree once via ateam_get_chain if you need per-job detail.",
    inputSchema: {
      type: "object",
      properties: {
        chain_id: {
          type: "string",
          description: "The chain id returned by ateam_conversation (the conversation's identity). Any job id in the chain also works — Core resolves the chain aggregate.",
        },
      },
      required: ["chain_id"],
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
    description:
      "Abort a running skill test. Stops the job execution at the next iteration boundary. (Advanced.)",
    inputSchema: {
      type: "object",
      properties: {
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
          description: "The job ID to abort",
        },
      },
      required: ["solution_id", "skill_id", "job_id"],
    },
  },
  {
    name: "ateam_test_connector",
    core: true,
    description:
      "Call a tool on a running connector and get the result. Use this to test individual connector tools (e.g., triggers.list, entities.list, google.command) without deploying to a client. The connector must be connected and running.",
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
      `Read the source code files of a deployed MCP connector. Returns all files (server.js, package.json, etc.) stored in the mcp_store for this connector. Use this BEFORE patching or rewriting a connector — always read the current code first so you can make surgical fixes instead of blind full rewrites.`,
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
    name: "ateam_get_metrics",
    core: false,
    description:
      "Get execution metrics — timing, tool stats, bottlenecks, signals, and recommendations. (Advanced.)",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
        job_id: {
          type: "string",
          description: "Optional: deep analysis for a specific job",
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
    description:
      "ONE call that returns the REAL runtime end-state of a solution — connectors connected + tools discovered, every declared widget actually rendering, skills deployed — with the EXACT failing gaps. Use this instead of guess-and-check after a deploy/patch: it tells you the truth (what's actually live) and names precisely what's broken, not a generic warning. Reliable from any connection (routes through the Builder, not a direct Core call).",
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
  {
    name: "ateam_verify_consistency",
    core: false,
    description:
      "Read-only: do Builder FS and the GitHub repo agree for this solution? Returns { consistent: bool, drifts: [{path, kind}] } where kind ∈ fs_missing | content_differs | gh_missing | gh_read_error | repo_unreachable. Comparison strips ephemeral fields (timestamps, runtime/deploy-state, resolved-on-load flags) so only REAL content drift surfaces. Use this any time you're unsure whether a recent change landed on GitHub or whether your local view of the solution matches what's deployed — much faster than scrolling ateam_github_log manually. No deploy is triggered.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: { type: "string", description: "The solution ID" },
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
    description:
      "Push the current deployed solution to GitHub. Auto-creates the repo on first use. Commits the full bundle (solution + skills + connector source) atomically. Use after ateam_build_and_run to version your solution, or anytime you want to snapshot the current state.",
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
      "Deploy a solution FROM its GitHub repo. Reads .ateam/export.json + connector source from the repo and feeds it into the deploy pipeline. Use this to restore a previous version or deploy from GitHub as the source of truth.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID to pull and deploy from GitHub",
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
      "Default reads from `main` (deployed/prod state). Pass `ref: 'dev'` to read in-progress work.",
    inputSchema: {
      type: "object",
      properties: {
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
          description: "Branch, tag, or commit SHA to read from. Default: 'main' (prod). Use 'dev' to read in-progress work.",
          default: "main",
        },
      },
      required: ["solution_id", "path"],
    },
  },
  {
    name: "ateam_github_patch",
    core: true,
    description:
      "Edit a file in the solution's GitHub repo and commit. Two modes:\n" +
      "1. FULL FILE: provide `content` — replaces entire file (good for new files or small files)\n" +
      "2. SEARCH/REPLACE: provide `search` + `replace` — surgical edit without sending full file (preferred for large files like server.js)\n" +
      "Always use search/replace for large files (>5KB). Always read the file first with ateam_github_read to get the exact text to search for.\n\n" +
      "DEFAULTS TO `dev` BRANCH — writes don't touch prod. Use ateam_github_promote to ship dev→main when ready. Pass ref:'main' only for emergency hotfixes.",
    inputSchema: {
      type: "object",
      properties: {
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
          description: "Optional commit message (default: 'Update <path>')",
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
      "Write each file individually (server.js, package.json, UI assets), then call ateam_github_promote() to ship to prod (dev→main), then ateam_build_and_run() to deploy.\n\n" +
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
          description: "Optional commit message (default: 'Write <path>')",
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
      "Default reads from `main` (prod). Pass `ref: 'dev'` to see in-progress work.",
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
          description: "Branch to read commits from. Default: 'main'.",
          default: "main",
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
      "  • Inspect arbitrary branch/tag/commit comparisons (override base/head)",
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
    description:
      "Check that the Builder filesystem state and GitHub state are in sync for a solution. Read-only probe — does NOT trigger a deploy.\n\n" +
      "Returns:\n" +
      "  • ok: true + drifts: [] if everything matches\n" +
      "  • ok: false + drifts: [{path, kind}] listing files that differ (kinds: fs_missing, gh_missing, content_differs)\n\n" +
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
  // RELEASE MANAGEMENT — checkpoint, rollback, version listing
  // ═══════════════════════════════════════════════════════════════════

  {
    name: "ateam_github_promote",
    core: true,
    description:
      "SHIP DEV TO PROD. Merges the `dev` branch into `main` and auto-tags the new main HEAD as safe-YYYY-MM-DD-NNN. " +
      "Use after testing your dev work, when you're ready to deploy changes to production.\n\n" +
      "Workflow: 1) ateam_github_patch (writes to dev) → 2) ateam_github_promote (merges dev→main) → 3) ateam_build_and_run (deploys main).\n\n" +
      "Pass dry_run:true to see what's about to ship without merging. On merge conflict the call returns 409 — resolve manually on GitHub (open a PR or use the web UI), then retry.",
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
    name: "ateam_github_rollback",
    core: true,
    description:
      "Roll prod (`main` branch) back to a previous state.\n\n" +
      "ADDITIVE — does NOT destroy history. Creates a new commit on top of main whose tree matches the target's tree. The history of everything between target and current main is preserved (you can roll back the rollback).\n\n" +
      "Workflow: 1) ateam_github_list_versions (find a safe-* tag) → 2) ateam_github_rollback(target: 'safe-...') → 3) ateam_build_and_run (deploys the reverted state).",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
        target: {
          type: "string",
          description: "Tag (e.g., 'safe-2026-05-19-001') or commit SHA to revert main to. Use ateam_github_list_versions to find safe-* tags.",
        },
      },
      required: ["solution_id", "target"],
    },
  },
  {
    name: "ateam_github_list_versions",
    core: true,
    description:
      "List all available checkpoints (safe-* tags) for a solution. Shows tag name, date, counter, and commit SHA. Use before rollback to see available safe points.",
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
      "Sync ALL tenants: push Builder FS → GitHub, then pull GitHub → Core MongoDB. Requires master key authentication. Returns a summary table with results for each tenant/solution.",
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

/**
 * Core tools — shown in MCP tools/list.
 * Advanced tools are still callable but not advertised.
 */
export const coreTools = tools.filter(t => t.core !== false);

// ─── Tool handlers ──────────────────────────────────────────────────

const SPEC_PATHS = {
  overview: "/spec",
  skill: "/spec/skill",
  solution: "/spec/solution",
  enums: "/spec/enums",
  "connector-multi-user": "/spec/multi-user-connector",
  python_helpers: "/spec/python_helpers",
  widgets: "/spec/widgets",
};

const EXAMPLE_PATHS = {
  index: "/spec/examples",
  skill: "/spec/examples/skill",
  connector: "/spec/examples/connector",
  "connector-ui": "/spec/examples/connector-ui",
  solution: "/spec/examples/solution",
  "script-cache-skill": "/spec/examples/script-cache-skill",
};

// Tools that are tenant-aware — require EXPLICIT ateam_auth (env vars alone not enough).
// This prevents accidental reads/writes to the wrong tenant when env vars are
// baked into MCP config (e.g., ADAS_TENANT + ADAS_API_KEY in ~/.claude.json).
// Any tool that touches tenant-specific data (solutions, skills, logs, tests) is here.
const TENANT_TOOLS = new Set([
  // Write operations
  "ateam_build_and_run",
  "ateam_patch",
  "ateam_deploy_solution",
  "ateam_deploy_skill",
  "ateam_deploy_connector",
  "ateam_upload_connector_files",
  "ateam_update",
  "ateam_redeploy",
  "ateam_delete_solution",
  "ateam_delete_skill",
  "ateam_delete_connector",
  "ateam_upload_connector",
  "ateam_solution_chat",
  // Read operations (tenant-specific data)
  "ateam_list_solutions",
  "ateam_get_solution",
  "ateam_get_execution_logs",
  "ateam_conversation",
  "ateam_test_skill",
  "ateam_test_notification",
  "ateam_test_pipeline",
  "ateam_test_voice",
  "ateam_test_status",
  "ateam_test_abort",
  "ateam_get_chain",
  "ateam_chain_status",
  "ateam_get_widget_catalog",
  "ateam_get_connector_source",
  "ateam_get_metrics",
  "ateam_diff",
  "ateam_verify_consistency",
  // GitHub operations
  "ateam_github_push",
  "ateam_github_pull",
  "ateam_github_status",
  "ateam_github_read",
  "ateam_github_patch",
  "ateam_github_log",
  // Master key bulk operations
  "ateam_status_all",
  "ateam_sync_all",
]);

/** Small delay helper */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════
// Phase 7 strip: connector + plugin scaffolds
// ───────────────────────────────────────────────────────────────────
// Pure client-side templates. ateam_create_connector / ateam_create_plugin
// produce file contents + push them via the existing /deploy/.../upload
// endpoint. The author writes only the unique tool implementations and
// component bodies; the ~50% of boilerplate per connector/plugin (MCP
// server setup, theme/bridge hooks, postMessage protocol, package.json)
// is template-generated.
// ═══════════════════════════════════════════════════════════════════

function _scaffoldConnectorFiles({ connectorId, displayName, uiCapable }) {
  const safeName = displayName || connectorId;
  const files = [];

  // server.js — raw-stdio JSON-RPC 2.0 MCP server. This mirrors the PROVEN
  // pattern deployed connectors use (e.g. nutrition-mcp): tools declared in
  // tools/list, dispatched in tools/call, no MCP SDK. UI plugins are exposed
  // as the `ui.listPlugins` / `ui.getPlugin` TOOLS, which is how Core detects a
  // UI-capable connector (it checks the tools/list output) and fetches each
  // manifest. Those two tools read the connector's OWN ui-dist/<plugin>/
  // manifest.json at call time — drop a plugin's files and it renders, with no
  // server.js edit needed.
  const serverJs = `#!/usr/bin/env node
// ${connectorId} — stdio JSON-RPC 2.0 MCP server. Generated by ateam_create_connector.
//
// Fill in your real tools below (see TOOLS + the tools/call dispatch). The
// JSON-RPC framing, actor isolation, stdio loop${uiCapable ? ", and ui-dist plugin discovery" : ""} are template-provided.
${uiCapable ? `
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
` : ""}
const PROTOCOL_VERSION = "2024-11-05";

// ── JSON-RPC helpers ──
function ok(id, result) { return { jsonrpc: "2.0", id, result }; }
function err(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }
function toText(data) { return { content: [{ type: "text", text: JSON.stringify(data) }] }; }

// ── Actor isolation ── every data tool is per-actor. Core injects _adas_actor
// into the call args; refuse to operate without it (prevents cross-actor leaks).
function getActorId(args) {
  const id = args?._adas_actor;
  if (!id) throw new Error("${connectorId}: no actor context — _adas_actor missing.");
  return id;
}
${uiCapable ? `
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
}
` : ""}
// ── Tool definitions ── Core reads this list. A tool named "ui.listPlugins"
// is how Core knows this connector is UI-capable.
function toolSchemas() {
  const actor = { _adas_actor: { type: "string" }, _adas_tenant: { type: "string" } };
  return [
    {
      name: "${connectorId}.echo",
      description: "Echo back the input. Replace with your real tools.",
      inputSchema: { type: "object", properties: { message: { type: "string" }, ...actor }, required: ["message"] },
    },${uiCapable ? `
    { name: "ui.listPlugins", description: "List available UI plugins.", inputSchema: { type: "object", properties: {} } },
    { name: "ui.getPlugin", description: "Get a UI plugin manifest by id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },` : ""}
  ];
}

// ── Request handler ──
async function handle(req) {
  const { id, method, params } = req || {};

  if (method === "initialize") {
    return ok(id, { protocolVersion: PROTOCOL_VERSION, serverInfo: { name: "${connectorId}", version: "1.0.0" }, capabilities: { tools: {} } });
  }
  if (method === "tools/list") return ok(id, { tools: toolSchemas() });

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
${uiCapable ? `      // ── UI registry plumbing (no actor required) ──
      if (name === "ui.listPlugins") {
        const plugins = discoverPlugins().map((p) => ({
          id: p.id, name: p.name || p.id, version: p.version || "1.0.0",
          description: p.description || "",
          ...(p.uiActions ? { uiActions: p.uiActions } : {}),
          ...(p.surface ? { surface: p.surface } : {}),
        }));
        return ok(id, toText({ plugins }));
      }
      if (name === "ui.getPlugin") {
        const p = discoverPlugins().find((pl) => pl.id === args.id);
        if (!p) return ok(id, toText({ error: \`Plugin \${args.id} not found\` }));
        return ok(id, toText(p)); // manifest already carries the render block
      }
` : ""}      // ── Your tools (actor-scoped) ──
      const actorId = getActorId(args);
      if (name === "${connectorId}.echo") {
        return ok(id, toText({ ok: true, echo: args.message, actor: actorId }));
      }
      return err(id, -32601, \`Unknown tool: \${name}\`);
    } catch (e) {
      return err(id, -32000, String(e?.message || e));
    }
  }

  if (typeof method === "string" && method.startsWith("notifications/")) return null;
  return err(id, -32601, \`Unknown method: \${method}\`);
}

// ── stdio loop ──
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  const lines = buf.split("\\n");
  buf = lines.pop() || "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { continue; }
    const resp = await handle(msg);
    if (resp) process.stdout.write(JSON.stringify(resp) + "\\n");
  }
});
process.stdin.on("end", () => process.exit(0));

console.error("[${connectorId}] Server started (stdio)");
`;
  files.push({ path: "server.js", content: serverJs });

  // package.json — raw stdio needs ZERO npm deps (node built-ins only), so
  // deploys skip npm install entirely.
  const pkg = {
    name: connectorId,
    version: "1.0.0",
    type: "module",
    description: `${safeName} — A-Team MCP connector`,
    main: "server.js",
    dependencies: {},
  };
  files.push({ path: "package.json", content: JSON.stringify(pkg, null, 2) + "\n" });

  // README.md
  const readme = `# ${safeName}

Connector ID: \`${connectorId}\`
${uiCapable ? "UI-capable: yes" : ""}

## Adding tools

Edit \`server.js\`: add an entry to \`toolSchemas()\` and a matching branch in
the \`tools/call\` dispatch. Data tools are per-actor — call \`getActorId(args)\`.

## Adding UI plugins (ui_capable connectors)

Use \`ateam_create_plugin\` (or drop the files yourself): iframe plugins go under
\`ui-dist/<plugin-name>/index.html\` with a \`ui-dist/<plugin-name>/manifest.json\`
(RN under \`plugins/<plugin-name>/index.tsx\`). This connector's
\`ui.listPlugins\` / \`ui.getPlugin\` read those manifests at call time, so a new
plugin renders with NO server.js edit.

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
  // ── Plugin postMessage protocol scaffold ────────────────────────
  // 'adas-host' messages come FROM the host shell (web app / mobile).
  // 'adas-plugin' messages go TO the host.
  // Use mcpCall(tool, args) to invoke any tool the skill has access to.

  function mcpCall(tool, args = {}, connectorId) {
    return new Promise((resolve, reject) => {
      const id = "call_" + Math.random().toString(36).slice(2);
      const listener = (e) => {
        if (e?.data?.type !== "adas-host") return;
        if (e?.data?.requestId !== id) return;
        window.removeEventListener("message", listener);
        if (e.data.error) reject(new Error(e.data.error));
        else resolve(e.data.result);
      };
      window.addEventListener("message", listener);
      window.parent?.postMessage({
        type: "adas-plugin",
        action: "mcpCall",
        requestId: id,
        tool, args, connectorId,
      }, "*");
    });
  }

  document.getElementById("callTool").addEventListener("click", async () => {
    try {
      const result = await mcpCall("${connectorId}.echo", { message: "hello" });
      document.getElementById("output").textContent = JSON.stringify(result, null, 2);
    } catch (err) {
      document.getElementById("output").textContent = "Error: " + err.message;
    }
  });

  // Tell host we're ready
  window.parent?.postMessage({ type: "adas-plugin", action: "ready" }, "*");
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
    const tsx = `// ${pluginName} — React Native plugin. Generated by ateam_create_plugin.
//
// Fill in the Component body. Imports, hooks, default export shape are
// template-provided — Phase 7 of the strip eliminates this boilerplate.

import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useApi } from '../../plugin-sdk';
import type { PluginProps } from '../../plugin-sdk/types';

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
        native?.haptics?.error?.();
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
      path: `plugins/${pluginName}/index.tsx`,
      content: tsx,
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

const handlers = {
  ateam_bootstrap: async () => ({
    platform_positioning: {
      name: "A-Team",
      category: "AI Team Solution Platform",
      summary: "A-Team is a platform for building governed AI Teams as complete operational solutions.",
    },
    design_advisor: {
      _important: "BEFORE and WHILE you design any skill/solution you MUST consult ateam_design_advisor. You do NOT know which platform capabilities exist or when to use them — the advisor does. Describe your goal to it and it returns pointers to the right capabilities (per-actor storage, widgets, triggers, sub-agents, mobile data, run-scripts, multi-skill handoff, GitHub, …) with the /spec topic to read next and the tool to wire each. It's advisory — you decide and own the design — but skipping it means you'll miss capabilities the platform already provides.",
      how: "ateam_design_advisor({ goal: '<what you are building, in your words>', design_state: {} }). Re-call it as the design evolves (pass the current design_state) to get 'what's still missing' hints. Then ateam_get_spec(topic) for any capability it points you to. For anything deeper — details, examples, or topics outside the capability list — ateam_spec_search({ query: '<how do I…>' }) does a semantic search over the FULL spec docs.",
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
        "solution.ui_plugins[] — Phase 5: MCP introspection (ui.listPlugins + ui.getPlugin)",
        "Style block prepended to every skill persona — Phase 1",
      ],
      replace_rule: "REPLACE wins per-field. Any field you write explicitly overrides the platform-generated equivalent. Delete it to opt back into automation.",
      read_first: "GET /spec/skill → auto_expand block has the full list and a typical_minimal_skill example. GET /spec/solution → same.",
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
        { step: 3, action: "Version", description: "Every deploy auto-pushes to main on GitHub. The repo (tenant--solution-id) is the source of truth for connector code.", tools: ["ateam_github_status", "ateam_github_log"] },
        { step: 4, action: "Iterate", description: "Edit connector code ONE FILE AT A TIME via ateam_github_patch, then redeploy with ateam_build_and_run (auto-pulls from GitHub). NEVER re-pass all connector code inline after first deploy. For skill definitions, use ateam_patch.", tools: ["ateam_github_patch", "ateam_build_and_run", "ateam_patch"] },
        { step: 5, action: "Test & Debug", description: "Chat with the solution via ateam_conversation (auto-routes; multi-turn via actor_id). It is ASYNC — see conversation_flow below: kick off → get chain_id → poll ateam_chain_status until chain_done → read the reply. Use ateam_test_pipeline for intent debugging, ateam_test_voice for voice. Diagnose with logs and metrics.", tools: ["ateam_conversation", "ateam_chain_status", "ateam_get_chain", "ateam_test_pipeline", "ateam_test_skill", "ateam_test_voice", "ateam_get_execution_logs", "ateam_get_metrics"] },
        { step: 6, action: "Checkpoint", description: "When solution is in a good state, create a checkpoint (safe point). You can rollback to any checkpoint if something breaks.", tools: ["ateam_github_promote", "ateam_github_list_versions"] },
      ],
    },
    conversation_flow: {
      _important: "ateam_conversation is ASYNC and CHAIN-based. A conversation runs across handoffs + askAnySkill subcalls for possibly minutes — a synchronous wait would hit the 100s edge timeout (524). ALWAYS poll by CHAIN, NEVER by a single job (a job can terminate while the chain is still active).",
      steps: [
        "1. KICK OFF — ateam_conversation(solution_id, message[, actor_id]) → returns { chain_id, actor_id } immediately. The reply is NOT here.",
        "2. POLL (chip-quick, cheap) — loop ateam_chain_status(chain_id) every ~2s. It returns the whole-chain aggregate { chain_status, chain_done, pending_question, result }. Stop when chain_done === true, OR when pending_question is set (the assistant is asking the user something — answer via step 4).",
        "3. READ THE REPLY — when chain_done, use result. For full per-job detail / the routed worker's output, call ateam_get_chain(chain_id) ONCE (it returns the entire chain tree: every job + every tool step). Do NOT poll get_chain in a loop — it's heavy.",
        "4. CONTINUE THE THREAD — reply / next turn: ateam_conversation(solution_id, message, actor_id: <same actor_id>). New chain, same conversation context. Repeat from step 2.",
      ],
      example: {
        kickoff: 'ateam_conversation(solution_id: "ada", message: "log 3 glasses of water") → { chain_id: "job_ab12", actor_id: "test_x" }',
        poll: 'ateam_chain_status(chain_id: "job_ab12") → { chain_status: "running", chain_done: false } … repeat … → { chain_status: "completed", chain_done: true, result: "…" }',
        full_tree: 'ateam_get_chain(chain_id: "job_ab12") → { chainJobs: [ {jobId, skill, status, relation, depth} … ], executionSteps: [ … ] }',
        continue: 'ateam_conversation(solution_id: "ada", message: "yes", actor_id: "test_x")',
      },
    },
    branching: {
      _important: "Single-branch model: ALL changes go directly to 'main'. Use checkpoints (safe-* tags) as safe rollback points.",
      main: "The only branch. All deploys, patches, and github_patches commit here automatically. This IS the live running system.",
      checkpoints: "ateam_github_promote(solution_id) — creates a safe-YYYY-MM-DD-NNN tag on current main HEAD. Use before risky changes.",
      rollback: "ateam_github_rollback(solution_id, tag) — reverts main to a previous checkpoint tag.",
      workflow: "Build → iterate on main → test → checkpoint when stable → continue iterating.",
    },
    first_questions: [
      { id: "goal", question: "What do you want your Team to accomplish?", type: "text" },
      { id: "domain", question: "Which domain fits best?", type: "enum", options: ["ecommerce", "logistics", "enterprise_ops", "other"] },
      { id: "systems", question: "Which systems should the Team connect to?", type: "multi_select", options: ["slack", "email", "zendesk", "shopify", "jira", "postgres", "custom_api", "none"] },
      { id: "security", question: "What environment constraints?", type: "enum", options: ["sandbox", "controlled", "regulated"] },
    ],
    github_tools: {
      _note: "Version control for solutions. Single-branch model — everything on 'main'. Use checkpoints as safe rollback points.",
      tools: ["ateam_github_push", "ateam_github_pull", "ateam_github_status", "ateam_github_read", "ateam_github_patch", "ateam_github_log", "ateam_github_promote", "ateam_github_rollback", "ateam_github_list_versions"],
      repo_structure: {
        "solution.json": "Full solution definition",
        "skills/{skill-id}/skill.json": "Individual skill definitions",
        "connectors/{connector-id}/server.js": "Connector MCP server code",
        "connectors/{connector-id}/package.json": "Connector dependencies",
      },
      branch: "main — the only branch. All changes land here directly.",
      checkpoints: "safe-YYYY-MM-DD-NNN tags mark safe rollback points. Create with ateam_github_promote().",
      iteration_workflow: {
        code_changes: "ateam_github_patch (one file at a time, commits to main) → ateam_build_and_run() (auto-pulls from GitHub, redeploys)",
        definition_changes: "ateam_patch (updates + redeploys + auto-pushes to main)",
        first_deploy: "Must include mcp_store — this creates the GitHub repo",
        after_first_deploy: "NEVER pass mcp_store again. Write files via ateam_github_patch, then ateam_build_and_run() auto-detects the repo.",
        checkpoint: "ateam_github_promote(solution_id) — tag current state as a safe rollback point",
      },
      when_to_use_what: {
        ateam_github_write: "Write/create connector files on main — ONE FILE PER CALL (server.js, package.json, UI assets). Use this after first deploy.",
        ateam_github_patch: "Edit existing files with search/replace (surgical edits to large files)",
        ateam_patch: "Edit skill definitions (intents, tools, policy) — auto-pushes to main",
        "ateam_build_and_run()": "Redeploy — auto-pulls from GitHub if repo exists. No need to pass mcp_store or github flag.",
        "ateam_build_and_run(mcp_store)": "FIRST DEPLOY ONLY — creates the GitHub repo. Never use mcp_store again after first deploy.",
        ateam_github_promote: "Create a checkpoint (safe-* tag) — use before risky changes",
        ateam_github_rollback: "Revert main to a previous checkpoint",
      },
    },
    advanced_tools: {
      _note: "These tools are available but hidden from the default tool list. Call them by name when you need fine-grained control.",
      debugging: ["ateam_get_execution_logs", "ateam_get_metrics", "ateam_diff", "ateam_get_connector_source"],
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
    platform_connectors: {
      _note: "Shared infrastructure MCPs available to all solutions. Reference by id in your solution's `platform_connectors` array; tools are automatically merged into every skill's tool catalog (no bridge needed). Do NOT bundle their source in mcp_store — they run as fixed Docker services on ADAS Core.",
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
        step_2: "Tools become available in the skill's tool catalog automatically — no code to write, no bridge needed",
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
      environment_transparency: {
        on_connect: "State it explicitly: 'Connected to <tenant> on <environment> — changes you make deploy here.' Derive environment from the authed api url (dev-api → DEV, api → PROD); show a human label, not a raw host. Never silently operate on an env the user didn't expect.",
        after_deploy: "Confirm WHERE it landed with a link: '✅ Added <thing> to <solution> (tenant <t>, <env>) — view it: <app url>.'",
      },
      // ── Delivering a build. (Backlog findings #2,#7,#8.)
      build_flow: {
        follow_the_stages: "Drive builds through thinking_order + minimal_authoring (below) — do NOT improvise. A skill is mainly its role.persona + connectors; the platform generates intents/tools/scenarios.",
        ui_is_in_scope: "If the user asks for a UI / app screen / dashboard, the WIDGET is part of the build — deliver it, don't silently defer it. If you must stage it, say so up front and get agreement.",
        pick_build_path_by_tenant_state: "Choose the write path by the tenant's GitHub state: repo connected → normal github flow; NO repo (Core-only / freshly onboarded) → use source:'local' for definition edits and ateam_create_plugin/ateam_upload_connector for widgets (they fall back to deployed source). If a github write returns github_not_connected / SOLUTION_NOT_FOUND, guide the user to connect GitHub (mcp.ateam-ai.com/connect-github) — do not surface the raw error.",
      },
      always: [
        "Open with a grounded welcome built from the user's real solution + skill names (business-friendly).",
        "State tenant + environment on connect, and where things land after each deploy (with a link).",
        "Explain Skill vs Solution vs Connector in plain words before building",
        "Use ateam_build_and_run for the full lifecycle (validates automatically)",
        "Use ateam_patch for skill/solution definition changes (updates + redeploys automatically)",
        "Use ateam_github_patch + ateam_build_and_run(github:true) for connector code changes after first deploy",
        "Study the connector example (ateam_get_examples type='connector') before writing connector code",
        "Ask discovery questions if goal unclear — one at a time, with choices",
        "Deliver the FULL ask, including any requested UI/widget; stage only with the user's agreement",
        "ALL changes go directly to main — suggest ateam_github_promote() to create a checkpoint before risky changes",
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
    // Master key mode: cross-tenant auth using shared secret
    if (master_key) {
      if (!tenant) {
        return { ok: false, message: "Master key requires a tenant parameter. Specify which tenant to operate on." };
      }
      const apiUrl = url ? url.replace(/\/+$/, "") : undefined;
      setSessionCredentials(sessionId, { tenant, apiKey: null, apiUrl, explicit: true, masterKey: master_key });
      // Verify by listing solutions
      try {
        const result = await get("/deploy/solutions", sessionId);
        const urlNote = apiUrl ? ` (via ${apiUrl})` : "";
        return {
          ok: true,
          tenant,
          masterMode: true,
          message: `Master key authenticated to tenant "${tenant}"${urlNote}. ${result.solutions?.length || 0} solution(s) found. Use tenant parameter on any tool to switch tenants without re-auth.`,
        };
      } catch (err) {
        return { ok: false, tenant, message: `Master key auth failed: ${err.message}` };
      }
    }

    // Normal API key mode
    if (!api_key) {
      return { ok: false, message: "Provide either api_key or master_key." };
    }
    // Auto-extract tenant from key if not provided.
    // Fail loudly if neither the explicit tenant arg nor a parseable apiKey
    // yields a tenant — previously fell back to "main" silently.
    let resolvedTenant = tenant;
    if (!resolvedTenant) {
      const parsed = parseApiKey(api_key);
      resolvedTenant = parsed.tenant;
    }
    if (!resolvedTenant) {
      return {
        ok: false,
        message: `Could not resolve tenant from api_key (expected format: adas_<tenant>_<32hex>). Pass the "tenant" arg explicitly, or check that your API key is well-formed.`,
      };
    }
    // Normalize URL: strip trailing slash
    const apiUrl = url ? url.replace(/\/+$/, "") : undefined;
    setSessionCredentials(sessionId, { tenant: resolvedTenant, apiKey: api_key, apiUrl, explicit: true });
    // Persist override per bearer (survives session changes)
    setAuthOverride(sessionId, { tenant: resolvedTenant, apiKey: api_key, apiUrl });
    // Verify the key works by listing solutions
    try {
      const result = await get("/deploy/solutions", sessionId);
      const urlNote = apiUrl ? ` (via ${apiUrl})` : "";
      return {
        ok: true,
        tenant: resolvedTenant,
        message: `Authenticated to tenant "${resolvedTenant}"${urlNote}. ${result.solutions?.length || 0} solution(s) found.`,
      };
    } catch (err) {
      return {
        ok: false,
        tenant: resolvedTenant,
        message: `Authentication failed: ${err.message}. The user can get a valid API key at https://mcp.ateam-ai.com/get-api-key`,
      };
    }
  },

  ateam_get_spec: async ({ topic, section, search }, sid) => {
    let path = SPEC_PATHS[topic];
    const params = new URLSearchParams();
    if (section) params.set('section', section);
    if (search) params.set('search', search);
    const qs = params.toString();
    if (qs) path += `?${qs}`;
    return get(path, sid);
  },

  ateam_get_workflows: async (_args, sid) => get("/spec/workflows", sid),

  ateam_get_examples: async ({ type }, sid) => get(EXAMPLE_PATHS[type], sid),

  // Design-time capability advisor. Proxies to the Builder's /spec/advisor
  // (LLM over the curated capability catalog). Public endpoint (auth-exempt),
  // but we forward the session so a base override is honored.
  ateam_design_advisor: async ({ goal, design_state, solution_id }, sid) => {
    if (!goal || typeof goal !== "string") throw new Error("goal required (a string describing what you're building)");
    // Reach the advisor through the sysSpecSearch-mcp platform connector via the
    // proven connector-call path (same as ateam_spec_search) — works on prod with
    // no bespoke /spec route. The connector's advise tool proxies the Builder's
    // LLM+catalog internally.
    const sol = solution_id || "_";
    const r = await post(
      `/deploy/solutions/${encodeURIComponent(sol)}/connectors/sysSpecSearch-mcp/call`,
      { tool: "sysSpecSearch.advise", args: { goal, design_state: design_state || {} } },
      sid,
      { timeoutMs: 90_000, retries: 1 },
    );
    const text = r?.result?.content?.[0]?.text;
    if (text) { try { return JSON.parse(text); } catch { return { ok: true, raw: text }; } }
    return r?.result ?? r;
  },

  // Semantic search over the full /spec corpus. Reaches the sysSpecSearch-mcp
  // PLATFORM connector through the proven connector-call path (the same route
  // ateam_test_connector uses) — so it works wherever the existing tools do, with
  // no bespoke /spec route to route on prod. Auth: the agent's api-key gates the
  // Builder route; the Builder calls Core with the internal secret; tenant is
  // forwarded from the session. solution_id is only for the route path (any).
  ateam_spec_search: async ({ query, top_k, solution_id }, sid) => {
    if (!query || typeof query !== "string") throw new Error("query required (a string question)");
    const sol = solution_id || "_";
    const r = await post(
      `/deploy/solutions/${encodeURIComponent(sol)}/connectors/sysSpecSearch-mcp/call`,
      { tool: "sysSpecSearch.search", args: { query, ...(top_k ? { top_k } : {}) } },
      sid,
      { timeoutMs: 30_000, retries: 1 },
    );
    // Unwrap the MCP tool result: { result: { content: [{ type:"text", text }] } }.
    const text = r?.result?.content?.[0]?.text;
    if (text) { try { return JSON.parse(text); } catch { return { ok: true, raw: text }; } }
    return r?.result ?? r;
  },

  // ─── Composite: Build & Run ────────────────────────────────────────
  // Validates → Deploys → Health-checks → Optionally tests
  // One call replaces: validate_solution + deploy_solution + get_solution(health)

  ateam_build_and_run: async ({ solution_id: solIdArg, solution: solutionArg, skills, connectors, mcp_store, github, test_message, test_skill_id }, sid) => {
    let solution = solutionArg;
    // If only solution_id passed (no full solution), we'll pull from GitHub
    const solutionId = solution?.id || solIdArg;
    if (!solutionId) {
      return { ok: false, phase: "pre_check", error: "Provide either solution (object) or solution_id (string)." };
    }
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
    if (!mcp_store) {
      try {
        const ghStatus = await get(`/deploy/solutions/${solutionId}/github/status`, sid);
        if (ghStatus?.repo_url) {
          github = true;
        }
      } catch { /* no repo — first deploy, mcp_store expected */ }
    }
    if (github && !mcp_store) {
      try {
        const pullResult = await post(
          `/deploy/solutions/${solutionId}/github/pull-bundle`,
          {},
          sid,
          { timeoutMs: 60_000 },
        );
        if (!pullResult.ok) {
          return {
            ok: false,
            phase: "github_pull",
            error: pullResult.error || "Failed to pull bundle from GitHub",
            hint: pullResult.hint || "Deploy the solution first (with mcp_store) to auto-create the GitHub repo.",
            message: "Cannot pull from GitHub. The repo may not exist yet — deploy with mcp_store first.",
          };
        }
        effectiveMcpStore = pullResult.mcp_store || {};
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
        if (!connectors?.length && Object.keys(effectiveMcpStore).length > 0) {
          connectors = Object.keys(effectiveMcpStore).map((id) => ({
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
        });
      } catch (err) {
        return {
          ok: false,
          phase: "github_pull",
          error: err.message,
          message: "Failed to pull from GitHub. The repo may not exist yet — deploy with mcp_store first.",
        };
      }
    }

    // Guard: solution required (either inline or from GitHub)
    if (!solution) {
      return {
        ok: false,
        phase: "pre_check",
        error: "No solution provided and none found in GitHub repo.",
        message: "Pass solution inline or ensure solution.json exists in the GitHub repo.",
      };
    }

    // Guard: skills required (either inline or from GitHub)
    if (!effectiveSkills?.length) {
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
      validation = await post("/validate/solution", { solution, skills: effectiveSkills, connectors, mcp_store: effectiveMcpStore }, sid, { timeoutMs: 120_000 });
      phases.push({ phase: "validate", status: "done" });
    } catch (err) {
      return {
        ok: false,
        phase: "validation",
        error: err.message,
        message: "Validation call failed. Check your solution/skill format against the spec (ateam_get_spec topic='solution').",
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
    let deploy;
    try {
      // Try sync first (fast for small solutions)
      deploy = await post("/deploy/solution", {
        solution, skills: effectiveSkills, connectors, mcp_store: effectiveMcpStore,
        ...(github && { skip_github_push: true }),
      }, sid, { timeoutMs: 120_000 });
      phases.push({ phase: "deploy", status: deploy.ok ? "done" : "failed" });
    } catch (err) {
      const isTimeout = /524|502|503|timeout|ETIMEDOUT/i.test(err.message);
      if (!isTimeout) {
        return { ok: false, phase: "deployment", phases, error: err.message, validation_warnings: validation.warnings || [] };
      }

      // Timeout → retry with async mode + polling
      phases.push({ phase: "deploy", status: "async_retry" });
      try {
        const asyncResult = await post("/deploy/solution", {
          solution, skills: effectiveSkills, connectors, mcp_store: effectiveMcpStore,
          ...(github && { skip_github_push: true }),
          async: true,
        }, sid, { timeoutMs: 15_000 });

        if (asyncResult.job_id) {
          // Poll for completion (up to 10 min)
          const jobId = asyncResult.job_id;
          const maxWait = 600_000;
          const pollInterval = 5_000;
          const start = Date.now();
          while (Date.now() - start < maxWait) {
            await new Promise(r => setTimeout(r, pollInterval));
            try {
              const job = await get(`/deploy/jobs/${jobId}`, sid);
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
    if (effectiveMcpStore && Object.keys(effectiveMcpStore).length > 0) {
      const connectorResults = [];
      for (const [connId, files] of Object.entries(effectiveMcpStore)) {
        if (!Array.isArray(files) || files.length === 0) continue;
        try {
          const uploadResult = await post(
            `/deploy/solutions/${solutionId}/connectors/${connId}/upload`,
            { files },
            sid,
            { timeoutMs: 120_000 },
          );
          connectorResults.push({ id: connId, ok: true, tools: uploadResult.tools || 0 });
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
      health = await get(`/deploy/solutions/${solutionId}/health`, sid);
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
            `/deploy/solutions/${solutionId}/skills/${skillId}/test`,
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
      github_result = { skipped: true, reason: 'Deployed from GitHub — push-back skipped.' };
      phases.push({ phase: "github", status: "skipped", reason: "pulled_from_github" });
    } else {
      try {
        github_result = await post(
          `/deploy/solutions/${solutionId}/github/push`,
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

    return {
      ok: true,
      solution_id: solutionId,
      branch: 'main',
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
      ...(github_result && !github_result.error && !github_result.skipped && { github: github_result }),
      ...(agent_doc_result && !agent_doc_result.error && { agent_doc: agent_doc_result }),
      ...(validation.warnings?.length > 0 && { validation_warnings: validation.warnings }),
      _status: widget_health && !widget_health.ok
        ? `✅ Deployed to Core + pushed to main. ⚠️ ${widget_health.issues?.length || 0} widget(s) not rendering — see widget_health.`
        : '✅ Deployed to Core + pushed to main.',
      _next: 'Create a checkpoint before making more changes: ateam_github_promote(solution_id)',
    };
  },

  // ─── Composite: Patch ──────────────────────────────────────────────
  // Updates → Redeploys → Optionally tests
  // One call replaces: ateam_update + ateam_redeploy

  ateam_patch: async ({ solution_id, target, skill_id, updates, test_message, dry_run, source, include_definition }, sid) => {
    const phases = [];
    let isNewSkill = false;
    const _diff = { arrays_merged: [], arrays_replaced: [], scalars_changed: [], sections_replaced: [] };

    // Two backing stores, chosen EXPLICITLY by `source` (never inferred):
    //   'github' (default) — GitHub-first: read from GitHub → apply patch → write
    //     back → redeploy. GitHub stays the single source of truth.
    //   'local' — Builder-FS-first: read from and write to the Builder store for a
    //     repo-less bootstrap tenant (freshly onboarded from a template, GitHub not
    //     yet connected). GitHub is still master overall; local is a temporary
    //     bootstrap until the tenant connects a repo (then local is pushed → GitHub).
    // Redeploy (Phase 4) is local (Builder FS → Core) in BOTH modes.
    const isLocal = source === "local";

    // Phase 1: Read current state (or create scaffold if new skill)
    let current;
    const filePath = target === "skill" && skill_id
      ? `skills/${skill_id}/skill.json`
      : `solution.json`;
    try {
      if (isLocal) {
        // Read the raw definition from the Builder store — no GitHub repo needed.
        if (target === "skill" && skill_id) {
          const r = await get(`/deploy/solutions/${solution_id}/skills/${encodeURIComponent(skill_id)}`, sid);
          current = r.skill || r.definition || r;
        } else {
          // ?raw=1 → the agent-api returns the UNSTRIPPED solution (keeps
          // linked_skills/conversation) so _delete/_push operate on the real arrays.
          const r = await get(`/deploy/solutions/${solution_id}/definition?raw=1`, sid);
          current = r.solution || r;
        }
        if (!current || typeof current !== "object") {
          throw new Error(`Local ${filePath} not found (empty definition)`);
        }
      } else {
        const readResult = await get(`/deploy/solutions/${solution_id}/github/read?path=${encodeURIComponent(filePath)}`, sid);
        current = JSON.parse(readResult.content);
      }
    } catch (err) {
      // If it's a skill that doesn't exist yet, create a default scaffold.
      // This lets agents use ateam_patch to both CREATE and UPDATE skills —
      // no separate "create" step needed.
      if (target === "skill" && skill_id) {
        console.log(`[ateam_patch] Skill "${skill_id}" not found on GitHub — creating new skill scaffold`);
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
            ? { method: "POST", endpoint: `/deploy/solutions/${solution_id}/skills`, body_key: "skill", creates: true }
            : target === "skill" && skill_id
              ? { method: "PATCH", endpoint: `/deploy/solutions/${solution_id}/skills/${encodeURIComponent(skill_id)}`, body_key: "updates" }
              : { method: "PATCH", endpoint: `/deploy/solutions/${solution_id}`, body_key: "state_update" })
        : { method: "POST", endpoint: `/deploy/solutions/${solution_id}/github/patch`, body_key: "content" };
      return {
        ok: true,
        dry_run: true,
        target,
        solution_id,
        skill_id,
        phases,
        _diff,
        after_state: patched,
        would_write,
        would_write_bytes: JSON.stringify(patched, null, 2).length,
        hint: "No changes applied. Remove dry_run:true to commit + redeploy.",
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
          await post(`/deploy/solutions/${solution_id}/skills`, { skill: patched }, sid, { timeoutMs: 30_000 });
          phases.push({ phase: "local_write", status: "done", created: true });
        } else if (target === "skill" && skill_id) {
          await patch(`/deploy/solutions/${solution_id}/skills/${encodeURIComponent(skill_id)}`, { updates: patched }, sid, { timeoutMs: 30_000 });
          phases.push({ phase: "local_write", status: "done" });
        } else {
          await patch(`/deploy/solutions/${solution_id}`, { state_update: patched }, sid, { timeoutMs: 30_000 });
          phases.push({ phase: "local_write", status: "done" });
        }
      } else {
        await post(`/deploy/solutions/${solution_id}/github/patch`, {
          path: filePath,
          content: JSON.stringify(patched, null, 2),
          message,
        }, sid, { timeoutMs: 30_000 });
        phases.push({ phase: "github_write", status: "done" });
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
          await patch(`/deploy/solutions/${solution_id}`, {
            state_update: { skills_push: [skillEntry], linked_skills_push: [skill_id] },
          }, sid, { timeoutMs: 30_000 });
          phases.push({ phase: "solution_topology", status: "done", added: skill_id });
        } else {
          const solRead = await get(`/deploy/solutions/${solution_id}/github/read?path=solution.json`, sid);
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
          await post(`/deploy/solutions/${solution_id}/github/patch`, {
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

    // Phase 4: Redeploy from GitHub (extended timeout — deploys can take 60-120s)
    // IMPORTANT: if redeploy times out or fails, we return ok:true with a warning
    // because the patch IS saved to GitHub — it's not lost. The agent can retry
    // the redeploy with ateam_redeploy(solution_id, skill_id).
    let redeployResult;
    try {
      if (target === "skill" && skill_id) {
        redeployResult = await post(`/deploy/solutions/${solution_id}/skills/${skill_id}/redeploy`, {}, sid, { timeoutMs: 180_000 });
      } else {
        redeployResult = await post(`/deploy/solutions/${solution_id}/redeploy`, {}, sid, { timeoutMs: 180_000 });
      }
      phases.push({ phase: "redeploy", status: "done" });
    } catch (err) {
      // Partial success: patch is saved to GitHub, only redeploy failed.
      // Return ok:true so the agent doesn't think the patch was lost.
      phases.push({ phase: "redeploy", status: "timeout_or_error", error: err.message });
      console.warn(`[ateam_patch] Redeploy failed after successful patch: ${err.message}`);
    }

    // Phase 3: Optional re-test
    let test_result;
    if (test_message && skill_id) {
      try {
        await sleep(1000);
        test_result = await post(
          `/deploy/solutions/${solution_id}/skills/${skill_id}/test`,
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
    const store = isLocal ? "Builder store (local)" : "GitHub";

    // Widget health — if the redeploy landed and the solution declares UI
    // plugins, verify each renders (Core discovered it + has a render block).
    let widget_health = null;
    if (redeployOk) {
      try {
        widget_health = await verifyWidgetHealth(solution_id, sid);
        if (widget_health) phases.push({ phase: "widget_health", status: widget_health.ok ? "done" : "warn", checked: widget_health.checked });
      } catch { /* advisory — never downgrade a successful patch on the health check */ }
    }

    return {
      ok: true,
      solution_id,
      source: isLocal ? "local" : "github",
      ...(isLocal ? {} : { branch: 'main' }),
      phases,
      // The full patched definition can be 10s of KB and pushes the rest of the
      // result (redeploy status, widget_health) past the ~50KB output ceiling,
      // truncating it. Return a compact summary by default; pass
      // include_definition:true for the whole thing.
      ...(include_definition
        ? { patched }
        : { patched_summary: _summarizeDef(patched) }),
      ...(isNewSkill && { created_skill: skill_id }),
      ...(redeployResult && { redeploy: redeployResult }),
      ...(widget_health && { widget_health }),
      ...(test_result && { test_result }),
      _status: redeployOk
        ? (widget_health && !widget_health.ok
            ? `✅ Patched on ${store} + redeployed. ⚠️ ${widget_health.issues?.length || 0} widget(s) not rendering — see widget_health.`
            : `✅ Patched on ${store} + redeployed.`)
        : `⚠️ Patched on ${store} ✅ but redeploy timed out. Run: ateam_redeploy(solution_id` + (skill_id ? `, skill_id: "${skill_id}"` : '') + ')',
      _next: isLocal
        ? 'Local edit saved + redeployed. When the tenant connects a GitHub repo, the local state is pushed → GitHub (which then becomes master).'
        : 'Create a checkpoint before making more changes: ateam_github_promote(solution_id)',
    };
  },

  // ─── Original handlers (unchanged) ────────────────────────────────

  ateam_validate_skill: async ({ skill }, sid) => post("/validate/skill", { skill }, sid),

  ateam_validate_solution: async ({ solution, skills, connectors, mcp_store }, sid) =>
    post("/validate/solution", { solution, skills, connectors, mcp_store }, sid),

  ateam_deploy_solution: async ({ solution, skills, connectors, mcp_store }, sid) =>
    post("/deploy/solution", { solution, skills, connectors, mcp_store }, sid),

  ateam_deploy_skill: async ({ solution_id, skill }, sid) =>
    post(`/deploy/solutions/${solution_id}/skills`, { skill }, sid),

  ateam_deploy_connector: async ({ connector }, sid) =>
    post("/deploy/connector", { connector }, sid),

  ateam_upload_connector_files: async ({ connector_id, files }, sid) => {
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
    return post(`/deploy/mcp-store/${connector_id}`, { files: resolved }, sid);
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
        const gh = await get(`/deploy/solutions/${s.id}/github/status`, sid);
        if (gh?.exists && gh.repo_url) {
          out.repo_url = gh.repo_url;
          out.github_full_name = gh.full_name || null;
          out.default_branch = gh.default_branch || "main";
          out.latest_commit_sha = gh.latest_commit?.sha || null;
          // Probe for agent-onboarding doc; swallow 404 etc.
          try {
            const probe = await get(`/deploy/solutions/${s.id}/github/read?path=CLAUDE.md`, sid);
            out.has_claude_md = Boolean(probe?.content);
          } catch { out.has_claude_md = false; }
          out.local_dev_quickstart = {
            _note: "Share these 3 lines with a developer (or their agent). They will clone the repo and, if CLAUDE.md is present, their agent sees the full onboarding on session start.",
            clone: `git clone ${gh.repo_url}`,
            cd: `cd ${(gh.full_name || "").split("/").pop() || s.id}`,
            auth_in_new_session: `ateam_auth(api_key: "adas_<tenant>_<hex>")`,
            needs_github_collaborator_access: !gh.repo_url.includes("public") ? true : false,
          };
        }
      } catch { /* non-fatal — leave the row as-is */ }
      return out;
    }));
    return { ...raw, solutions: enriched };
  },

  ateam_get_solution: async ({ solution_id, view, skill_id }, sid) => {
    const base = `/deploy/solutions/${solution_id}`;
    if (skill_id) return get(`${base}/skills/${skill_id}`, sid);
    const paths = {
      definition: `${base}/definition`,
      skills: `${base}/skills`,
      health: `${base}/health`,
      status: `/deploy/status/${solution_id}`,
      export: `${base}/export`,
      validate: `${base}/validate`,
      connectors_health: `${base}/connectors/health`,
    };
    return get(paths[view], sid);
  },

  ateam_update: async ({ solution_id, target, skill_id, updates }, sid) => {
    if (target === "skill") {
      return patch(`/deploy/solutions/${solution_id}/skills/${skill_id}`, { updates }, sid);
    }
    return patch(`/deploy/solutions/${solution_id}`, { state_update: updates }, sid);
  },


  ateam_solution_chat: async ({ solution_id, message }, sid) =>
    post(`/deploy/solutions/${solution_id}/chat`, { message }, sid),

  ateam_test_connector: async ({ solution_id, connector_id, tool, args }, sid) =>
    post(`/deploy/solutions/${solution_id}/connectors/${connector_id}/call`, { tool, args }, sid, { timeoutMs: 30_000 }),

  // ─── Developer Tools ────────────────────────────────────────────

  ateam_get_execution_logs: async ({ solution_id, skill_id, job_id, limit }, sid) => {
    const qs = new URLSearchParams();
    if (skill_id) qs.set("skill_id", skill_id);
    if (job_id) qs.set("job_id", job_id);
    if (limit) qs.set("limit", String(limit));
    const qsStr = qs.toString() ? `?${qs}` : "";
    return get(`/deploy/solutions/${solution_id}/logs${qsStr}`, sid);
  },

  ateam_conversation: async ({ solution_id, message, actor_id, wait, timeout_ms }, sid) => {
    // ALWAYS async on the wire. A conversation can run for minutes (auto-route
    // → worker → sub-skills), and a synchronous hold would blow past the 100s
    // Cloudflare edge limit → 524. So we kick off, return the chain id (job_id)
    // immediately, and the caller polls a SLIM status. `wait`/`timeout_ms` are
    // accepted for back-compat but no longer hold the HTTP request open.
    const body = { message, async: true, ...(actor_id ? { actor_id } : {}) };
    const kickoff = await post(`/deploy/solutions/${solution_id}/test`, body, sid, { timeoutMs: 15_000 });
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
            full: `ateam_get_chain(job_id: "${chainId}")  → full tree + per-job detail (heavier; use once, not in a poll loop)`,
            continue: kickoff?.actor_id ? `ateam_conversation(actor_id: "${kickoff.actor_id}", ...) to continue the thread` : undefined,
          }
        : undefined,
    };
  },

  ateam_test_skill: async ({ solution_id, skill_id, message, wait, wait_for, chain_timeout_ms, actor_id }, sid) => {
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
    const body = { message, ...(isWireAsync ? { async: true } : {}), ...(actor_id ? { actor_id } : {}) };
    const kickoffTimeoutMs = isWireAsync ? 15_000 : 90_000;
    const kickoff = await post(`/deploy/solutions/${solution_id}/skills/${skill_id}/test`, body, sid, { timeoutMs: kickoffTimeoutMs });

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
      const res = await fetch(`${coreUrl}/api/job/${encodeURIComponent(rootJobId)}/chain?${qs}`, {
        method: "GET",
        headers: { "x-api-key": apiKey, "X-ADAS-SERVICE": "ateam-mcp.test_skill_chain" },
        signal: AbortSignal.timeout(15_000),
      }).catch(err => ({ ok: false, _err: err.message }));
      const data = res.ok === false && res._err ? { ok: false, error: res._err } : await res.json().catch(() => ({ ok: false, error: "non-json chain response" }));
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
      throw new Error("No api_key in session — call ateam_auth(api_key: \"adas_<tenant>_<hex>\") first. ateam_test_notification requires a tenant API key (master_key auth is not supported for this tool).");
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

  ateam_test_pipeline: async ({ solution_id, skill_id, message }, sid) =>
    post(`/deploy/solutions/${solution_id}/skills/${skill_id}/test-pipeline`, { message }, sid, { timeoutMs: 30_000 }),

  ateam_test_voice: async ({ solution_id, messages, phone_number, skill_slug, timeout_ms }, sid) => {
    const body = { messages };
    if (phone_number) body.phone_number = phone_number;
    if (skill_slug) body.skill_slug = skill_slug;
    if (timeout_ms) body.timeout_ms = timeout_ms;
    // Timeout scales with message count — each turn may invoke skills
    const perTurnMs = timeout_ms || 60_000;
    const timeoutTotal = Math.min(perTurnMs * messages.length + 30_000, 600_000);
    return post(`/deploy/voice-test`, body, sid, { timeoutMs: timeoutTotal });
  },

  ateam_test_status: async ({ solution_id, skill_id, job_id, include_chain }, sid) => {
    // Existing single-job snapshot via Builder (unchanged shape for back-compat).
    const single = await get(`/deploy/solutions/${solution_id}/skills/${skill_id}/test/${job_id}`, sid);
    if (!include_chain) return single;

    // Caller asked for the chain tree too. Fetch via Core's /api/job/:id/chain
    // and merge under response.chain. Single-job fields stay at the top level.
    const creds = getCredentials(sid);
    const apiKey = creds?.apiKey;
    if (!apiKey) return { ...single, chain: { ok: false, error: "include_chain requires api-key auth (call ateam_auth)" } };
    const coreUrl = process.env.ADAS_CORE_URL || "http://adas-backend:4000";
    const qs = new URLSearchParams();
    if (skill_id) qs.set("skillSlug", skill_id);
    const res = await fetch(`${coreUrl}/api/job/${encodeURIComponent(job_id)}/chain?${qs}`, {
      method: "GET",
      headers: { "x-api-key": apiKey, "X-ADAS-SERVICE": "ateam-mcp.test_status_chain" },
      signal: AbortSignal.timeout(15_000),
    }).catch(err => ({ ok: false, _err: err.message }));
    const chain = res.ok === false && res._err ? { ok: false, error: res._err } : await res.json().catch(() => ({ ok: false, error: "non-json chain response" }));
    return { ...single, chain };
  },

  ateam_get_chain: async ({ job_id, skill_slug }, sid) => {
    if (!job_id) throw new Error("job_id required");
    const creds = getCredentials(sid);
    const apiKey = creds?.apiKey;
    if (!apiKey) throw new Error("No api_key in session — call ateam_auth(api_key) first.");
    const coreUrl = process.env.ADAS_CORE_URL || "http://adas-backend:4000";
    const qs = new URLSearchParams();
    if (skill_slug) qs.set("skillSlug", skill_slug);
    const res = await fetch(`${coreUrl}/api/job/${encodeURIComponent(job_id)}/chain?${qs}`, {
      method: "GET",
      headers: { "x-api-key": apiKey, "X-ADAS-SERVICE": "ateam-mcp.get_chain" },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { ok: false, error: text.slice(0, 400) }; }
    if (!res.ok) {
      throw new Error(`Core /api/job/${job_id}/chain returned ${res.status}: ${data.error || JSON.stringify(data).slice(0, 200)}`);
    }
    return data;
  },

  // SLIM chain status — the chip-quick poll. Hits Core /api/job/:id/status
  // (slimJob), which returns the WHOLE-CHAIN aggregate `chainStatus`/`chainDone`
  // (computeChainStatus over chainId) alongside the single-job status. This is
  // the right thing to poll on a loop after ateam_conversation: a single job
  // can terminate while the chain is still active — chainDone only flips when
  // the CHAIN is done. Cheap enough for periodic polling (no full tree).
  ateam_chain_status: async ({ chain_id, job_id }, sid) => {
    const id = chain_id || job_id;
    if (!id) throw new Error("chain_id required");
    const creds = getCredentials(sid);
    const apiKey = creds?.apiKey;
    if (!apiKey) throw new Error("No api_key in session — call ateam_auth(api_key) first.");
    const coreUrl = process.env.ADAS_CORE_URL || "http://adas-backend:4000";
    const res = await fetch(`${coreUrl}/api/job/${encodeURIComponent(id)}/status`, {
      method: "GET",
      headers: { "x-api-key": apiKey, "X-ADAS-SERVICE": "ateam-mcp.chain_status" },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { ok: false, error: text.slice(0, 400) }; }
    if (!res.ok) {
      throw new Error(`Core /api/job/${id}/status returned ${res.status}: ${data.error || JSON.stringify(data).slice(0, 200)}`);
    }
    // Surface the chain-aggregate truth as the primary fields; keep the raw
    // slim job under `job` for callers that want per-job detail.
    return {
      chain_id: data.chainId || id,
      chain_status: data.chainStatus ?? data.status ?? null,
      chain_done: data.chainDone ?? data.done ?? null,
      pending_question: data.pendingQuestion || null,
      result: data.result ?? null,
      progress: data.progress || null,
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
    if (!solution_id) throw new Error("solution_id required (used to route the catalog request through the Builder).");
    const data = await get(`/deploy/solutions/${solution_id}/ui-plugins`, sid);
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

  ateam_test_abort: async ({ solution_id, skill_id, job_id }, sid) =>
    del(`/deploy/solutions/${solution_id}/skills/${skill_id}/test/${job_id}`, sid),

  ateam_get_connector_source: async ({ solution_id, connector_id, path }, sid) => {
    const data = await get(`/deploy/solutions/${solution_id}/connectors/${connector_id}/source`, sid);
    const files = Array.isArray(data?.files) ? data.files : [];
    // A whole connector's source easily exceeds the ~50KB tool-output ceiling and
    // truncates (you couldn't read the file you needed). So: no `path` → return a
    // FILE MANIFEST (paths + sizes, no content — small); with `path` → return just
    // that ONE file's content. Targeted, never truncated.
    if (!path) {
      return {
        ok: true,
        connector_id,
        files: files.map((f) => ({ path: f.path, bytes: (f.content || "").length, encoding: f.encoding || "utf8" })),
        total_bytes: files.reduce((n, f) => n + (f.content || "").length, 0),
        hint: "Large source is not returned inline. Call again with path:'<file>' to read one file (e.g. path:'server.js').",
      };
    }
    const norm = String(path).replace(/^\.?\//, "");
    const file = files.find((f) => f.path === path || f.path === norm || f.path.replace(/^\.?\//, "") === norm);
    if (!file) {
      return { ok: false, connector_id, error: `file '${path}' not found`, available: files.map((f) => f.path) };
    }
    return { ok: true, connector_id, path: file.path, encoding: file.encoding || "utf8", content: file.content };
  },

  // Render + write CLAUDE.md into the solution's GitHub repo.
  // Preserves content below the sentinel unless overwrite=true.
  // Swallows errors internally when invoked non-interactively (see _writeAgentDocSafe).
  ateam_write_agent_doc: async ({ solution_id, overwrite = false }, sid) => {
    if (!solution_id) throw new Error("solution_id required");
    // Gather source material: the deployed solution definition + skills list.
    // These come straight from Core, so the doc always reflects what's running.
    const def = await get(`/deploy/solutions/${solution_id}/definition`, sid);
    const solution = def?.solution || def;
    let skills = [];
    try {
      const skillsRes = await get(`/deploy/solutions/${solution_id}/skills`, sid);
      skills = Array.isArray(skillsRes?.skills) ? skillsRes.skills : Array.isArray(skillsRes) ? skillsRes : [];
    } catch { /* no skills yet — render anyway */ }
    const connectors = Array.isArray(solution?.connectors) ? solution.connectors : [];

    const freshHeader = renderAgentDocHeader({ solution, skills, connectors });
    let existing = null;
    try {
      const r = await get(
        `/deploy/solutions/${solution_id}/github/read?path=${encodeURIComponent("CLAUDE.md")}`,
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
      `/deploy/solutions/${solution_id}/github/patch`,
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

  ateam_get_metrics: async ({ solution_id, job_id, skill_id }, sid) => {
    const qs = new URLSearchParams();
    if (job_id) qs.set("job_id", job_id);
    if (skill_id) qs.set("skill_id", skill_id);
    const qsStr = qs.toString() ? `?${qs}` : "";
    return get(`/deploy/solutions/${solution_id}/metrics${qsStr}`, sid);
  },

  ateam_verify_consistency: async ({ solution_id }, sid) =>
    get(`/deploy/solutions/${solution_id}/verify`, sid),

  // OPEN-7: one call that returns the REAL runtime end-state — connectors
  // connected + tools discovered, declared widgets actually rendering, skills
  // deployed — with the exact failing gaps, so you never guess-and-check.
  // All sub-checks go through the Builder base (reliable from any connection).
  ateam_verify: async ({ solution_id }, sid) => {
    if (!solution_id) throw new Error("solution_id required");
    const gaps = [];
    const out = { ok: true, solution_id };

    // 1. Connectors — connected + tools discovered.
    try {
      const ch = await get(`/deploy/solutions/${solution_id}/connectors/health`, sid);
      const raw = ch?.connectors || ch?.results || (Array.isArray(ch) ? ch : []);
      out.connectors = (raw || []).map((c) => {
        const id = c.id || c.connector_id || c.name;
        const connected = c.status === "connected" || c.connected === true || c.ok === true || c.healthy === true;
        const tools = Array.isArray(c.tools) ? c.tools.length : (typeof c.tools === "number" ? c.tools : (c.toolCount ?? c.tool_count));
        return { id, connected, tools };
      });
      for (const c of out.connectors) {
        if (!c.connected) gaps.push(`connector '${c.id}' not connected`);
        else if (c.tools === 0) gaps.push(`connector '${c.id}' connected but discovered 0 tools`);
      }
    } catch (e) {
      out.connectors = { error: e.message };
      gaps.push(`connectors health unavailable: ${e.message}`);
    }

    // 2. Widgets — every declared ui_plugin actually renders (reliable proxy).
    try {
      const wh = await verifyWidgetHealth(solution_id, sid);
      out.widgets = wh || { checked: 0, note: "no widgets declared" };
      if (wh && !wh.ok) for (const i of (wh.issues || [])) gaps.push(`widget: ${i}`);
    } catch (e) {
      out.widgets = { error: e.message };
      gaps.push(`widget health unavailable: ${e.message}`);
    }

    // 3. Skills — deployed + registered (from the solution health check).
    try {
      const h = await get(`/deploy/solutions/${solution_id}/health`, sid);
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
      gaps.push(`solution health unavailable: ${e.message}`);
    }

    out.gaps = gaps;
    out.ok = gaps.length === 0;
    out._status = out.ok
      ? "✅ Verified live — connectors connected, widgets render, skills deployed."
      : `⚠️ ${gaps.length} gap(s): ${gaps.slice(0, 5).join("; ")}${gaps.length > 5 ? " …" : ""}`;
    return out;
  },

  ateam_diff: async ({ solution_id, skill_id }, sid) => {
    const qs = skill_id ? `?skill_id=${encodeURIComponent(skill_id)}` : "";
    return get(`/deploy/solutions/${solution_id}/diff${qs}`, sid);
  },

  // ─── GitHub tools ──────────────────────────────────────────────────

  ateam_github_push: async ({ solution_id, message }, sid) =>
    post(`/deploy/solutions/${solution_id}/github/push`, { push_to_github: true, message }, sid, { timeoutMs: 60_000 }),

  ateam_github_pull: async ({ solution_id }, sid) => {
    // Async-first: github_pull is the #1 Cloudflare-524 culprit on large
    // solutions. Kick the job off, then poll. Falls back to sync if the
    // backend doesn't support async (older deployments).
    let kicked;
    try {
      kicked = await post(`/deploy/solutions/${solution_id}/github/pull`, { async: true }, sid, { timeoutMs: 30_000 });
    } catch (err) {
      // Sync fallback (older backend without async support)
      return await post(`/deploy/solutions/${solution_id}/github/pull`, {}, sid, { timeoutMs: 300_000, retries: 2 });
    }
    if (!kicked?.async || !kicked.job_id) return kicked; // backend didn't honor async — return as-is
    return await pollDeployJob(kicked.job_id, sid, { label: 'github-pull', maxMs: 15 * 60_000, intervalMs: 2000 });
  },

  ateam_github_status: async ({ solution_id }, sid) =>
    get(`/deploy/solutions/${solution_id}/github/status`, sid),

  ateam_github_read: async ({ solution_id, path: filePath, ref }, sid) => {
    const qs = new URLSearchParams({ path: filePath });
    if (ref) qs.set('branch', ref);
    return get(`/deploy/solutions/${solution_id}/github/read?${qs.toString()}`, sid);
  },

  ateam_github_patch: async ({ solution_id, path: filePath, content, search, replace, message, ref }, sid) =>
    post(`/deploy/solutions/${solution_id}/github/patch`, { path: filePath, content, search, replace, message, ref }, sid),

  ateam_github_write: async ({ solution_id, path: filePath, content, message, ref }, sid) =>
    post(`/deploy/solutions/${solution_id}/github/patch`, { path: filePath, content, message, ref }, sid),

  ateam_github_log: async ({ solution_id, limit, ref }, sid) => {
    const qs = new URLSearchParams();
    if (limit) qs.set('limit', String(limit));
    if (ref) qs.set('branch', ref);
    const q = qs.toString();
    return get(`/deploy/solutions/${solution_id}/github/log${q ? '?' + q : ''}`, sid);
  },

  ateam_github_diff: async ({ solution_id, base, head }, sid) => {
    const qs = new URLSearchParams();
    if (base) qs.set('base', base);
    if (head) qs.set('head', head);
    const q = qs.toString();
    return get(`/deploy/solutions/${solution_id}/github/diff${q ? '?' + q : ''}`, sid);
  },

  ateam_verify_consistency: async ({ solution_id }, sid) =>
    get(`/deploy/solutions/${solution_id}/verify`, sid),

  ateam_github_promote: async ({ solution_id, label, dry_run, skip_tag }, sid) =>
    post(`/deploy/solutions/${solution_id}/promote`, { label, dry_run, skip_tag }, sid),

  ateam_github_rollback: async ({ solution_id, target, tag }, sid) =>
    // Accept both `target` (new spec) and `tag` (legacy callers)
    post(`/deploy/solutions/${solution_id}/rollback`, { target: target || tag }, sid),

  ateam_github_list_versions: async ({ solution_id }, sid) =>
    get(`/deploy/solutions/${solution_id}/versions/dev`, sid),

  ateam_delete_solution: async ({ solution_id, confirm, confirm_solution_id }, sid) => {
    if (confirm !== true) {
      return {
        ok: false,
        error: "⚠️ REFUSED: ateam_delete_solution requires confirm:true. This is irreversible in Core + Builder FS. GitHub source is preserved — ateam_github_pull rebuilds from `main` if you already deleted by mistake.",
        recovery: "ateam_github_pull(solution_id, ref:'main')",
      };
    }
    if (confirm_solution_id !== solution_id) {
      return {
        ok: false,
        error: `⚠️ REFUSED: confirm_solution_id must exactly equal solution_id. Got confirm_solution_id="${confirm_solution_id}" but solution_id="${solution_id}". This check defeats typos and hallucinated ids — you should not be able to wipe a solution whose id you can't spell correctly.`,
        expected: solution_id,
        received: confirm_solution_id,
      };
    }
    return del(`/deploy/solutions/${solution_id}`, sid);
  },

  ateam_delete_skill: async ({ solution_id, skill_id, confirm }, sid) => {
    if (confirm !== true) {
      return {
        ok: false,
        error: `⚠️ REFUSED: ateam_delete_skill requires confirm:true. Kills the running MCP process and deletes the skill from Core + Builder FS. GitHub source is preserved — ateam_github_pull rebuilds the whole solution.`,
        recovery: "ateam_github_pull(solution_id, ref:'main') — no per-skill restore path",
      };
    }
    return del(`/deploy/solutions/${solution_id}/skills/${skill_id}`, sid);
  },

  ateam_delete_connector: async ({ solution_id, connector_id, confirm }, sid) => {
    if (confirm !== true) {
      return {
        ok: false,
        error: `⚠️ REFUSED: ateam_delete_connector requires confirm:true. Cascading — any skill wired to this connector's tools will fail its next execution. GitHub source is preserved.`,
        recovery: "ateam_build_and_run(solution_id, github:true) can resurrect from GitHub",
      };
    }
    return del(`/deploy/solutions/${solution_id}/connectors/${connector_id}`, sid);
  },

  ateam_upload_connector: async ({ solution_id, connector_id, github, files, ref, replace }, sid) => {
    // Async-first: this runs npm install + build in Core (up to ~7min) and is a
    // prime Cloudflare-524 culprit. Kick async → poll /deploy/jobs; fall back to
    // sync for older backends that don't honor async. Mirrors ateam_github_pull.
    const body = {
      github,
      files,
      ...(ref ? { ref } : {}),
      ...(replace === true ? { replace: true } : {}),
    };
    const url = `/deploy/solutions/${solution_id}/connectors/${connector_id}/upload`;
    let kicked;
    try {
      kicked = await post(url, { ...body, async: true }, sid, { timeoutMs: 30_000 });
    } catch (err) {
      return await post(url, body, sid, { timeoutMs: 300_000, retries: 1 });
    }
    if (!kicked?.async || !kicked.job_id) return kicked; // backend didn't honor async
    return await pollDeployJob(kicked.job_id, sid, { label: 'connector-upload', maxMs: 15 * 60_000, intervalMs: 2000 });
  },

  // ── Phase 9 strip: focused minimal responses ────────────────────────
  ateam_show_skill_minimal: async ({ solution_id, skill_id }, sid) => {
    if (!solution_id) throw new Error("solution_id required");
    if (!skill_id) throw new Error("skill_id required");
    const full = await get(`/deploy/solutions/${solution_id}/skills/${skill_id}`, sid);
    const skill = full?.skill || full;
    if (!skill) return { ok: false, error: "skill not found" };
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

  ateam_show_solution_minimal: async ({ solution_id }, sid) => {
    if (!solution_id) throw new Error("solution_id required");
    const full = await get(`/deploy/solutions/${solution_id}/definition`, sid);
    const sol = full?.solution || full;
    if (!sol) return { ok: false, error: "solution not found" };
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
    // replace:true — this is a NEW connector: the scaffold IS the complete file
    // set, and there's nothing to merge against (no GitHub base, nothing
    // deployed yet). Without it the upload route's merge-protection 409s a
    // brand-new connector on a repo-less tenant ("no existing base to merge").
    // Partial uploads (ateam_create_plugin) still merge; a full create replaces.
    const result = await post(
      `/deploy/solutions/${solution_id}/connectors/${connector_id}/upload`,
      { files, replace: true },
      sid,
      { timeoutMs: 120_000, retries: 1 },
    );
    return {
      ok: true,
      connector_id,
      files_created: files.map(f => f.path),
      ui_capable: !!ui_capable,
      upload_result: result,
      next_steps: [
        `Edit server.js to add your real tools (replace the echo stub).`,
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
    const _uploadUrl = `/deploy/solutions/${solution_id}/connectors/${connector_id}/upload`;
    let result;
    try {
      const kicked = await post(_uploadUrl, { files, async: true }, sid, { timeoutMs: 30_000 });
      result = (kicked?.async && kicked.job_id)
        ? await pollDeployJob(kicked.job_id, sid, { label: 'create-plugin', maxMs: 15 * 60_000, intervalMs: 2000 })
        : kicked;
    } catch (err) {
      result = await post(_uploadUrl, { files }, sid, { timeoutMs: 120_000, retries: 1 });
    }

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
        const data = await get(`/deploy/solutions/${solution_id}/ui-plugins`, sid).catch(() => null);
        if (!data || data.ok === false) continue;
        const found = (data?.plugins || []).find((p) => p?.id === pluginId);
        if (found) {
          verified = _widgetHasRender(found.render)
            ? { renders: true, render_ok: true, note: "discovered by Core with a valid render block — it will render" }
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
          ? `Edit plugins/${plugin_name}/index.tsx — fill in the Component body.`
          : null,
        k === "iframe" || k === "adaptive"
          ? `Edit ui-dist/${plugin_name}/index.html — replace the placeholder UI.`
          : null,
        `A manifest.json (with the render block) was written to ui-dist/${plugin_name}/manifest.json — this is the source of truth Core reads.`,
        `If this connector was scaffolded by ateam_create_connector, its ui.listPlugins / ui.getPlugin read ui-dist/*/manifest.json automatically — nothing else to register, it renders on the next deploy. ⚠️ ONLY a connector with a HARDCODED plugin list (legacy, e.g. personal-assistant-ui-mcp: UI_PLUGINS[] + PLUGIN_MANIFESTS{} in server.js) needs this plugin added there by hand — copy the render block from manifest.json.`,
        `Verify with ateam_get_widget_catalog (or ateam_get_solution(solution_id, "connectors_health")) after deploy.`,
        `Then declare it at solution level (ui_plugins[]) so a skill can open it via sys.focusUiPlugin — see ateam_get_spec(topic:"widgets").`,
      ].filter(Boolean),
    };
  },

  ateam_redeploy: async ({ solution_id, skill_id }, sid) => {
    const endpoint = skill_id
      ? `/deploy/solutions/${solution_id}/skills/${skill_id}/redeploy`
      : `/deploy/solutions/${solution_id}/redeploy`;

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
      try {
        result = await post(endpoint, {}, sid, { timeoutMs: 300_000, retries: 2 });
        lastErr = null;
      } catch (syncErr) {
        lastErr = syncErr;
      }
    }

    if (!result && lastErr) {
      const notFound = /not found|404|ENOENT/i.test(lastErr.message);
      const isTimeout = /524|502|503|timeout|ETIMEDOUT/i.test(lastErr.message);
      return {
        ok: false,
        error: lastErr.message,
        ...(notFound && {
          hint: "Skill not found in Builder storage. Edit the skill on GitHub with ateam_github_patch(solution_id, path: 'skills/<skill-id>/skill.json', search: '...', replace: '...'), then use ateam_build_and_run(solution_id, github: true) or ask the platform operator to deploy the single skill.",
        }),
        ...(isTimeout && {
          hint: "Redeploy timed out even after async polling (15min). Use ateam_redeploy(solution_id, skill_id: '<specific-skill>') to redeploy one skill at a time.",
        }),
      };
    }
    if (!result) result = { ok: false, error: 'Redeploy returned no result' };
    // Pull through the underlying error/message instead of fabricating "0/0/0
    // success-shaped" output. Old wrapper hid backend errors (e.g. validator
    // failures from sentinel files in user repos) and reported `total: 0` with
    // no clue why — the agent was left thinking redeploy was a no-op when in
    // fact it was a hard failure.
    const failedCount = !result.ok
      ? (result.failed ?? (result.skills?.length ? result.skills.filter(s => s.ok === false).length : 1))
      : (result.failed || 0);
    const deployedCount = result.deployed ?? (result.ok ? (skill_id ? 1 : (result.skills?.filter(s => s.ok !== false).length || 0)) : 0);
    const totalCount = result.total ?? (deployedCount + failedCount);

    const out = {
      ok: result.ok,
      solution_id,
      ...(skill_id && { skill_id }),
      deployed: deployedCount,
      failed: failedCount,
      total: totalCount,
      skills: result.skills || [],
      // Surface the underlying error when the request failed — the most
      // common cause is a validator failure (e.g. broken connector source
      // in the GitHub repo), and hiding it makes diagnosis impossible.
      ...(!result.ok && result.error && { error: result.error }),
      ...(!result.ok && result.details && { details: result.details }),
      ...(!result.ok && result.hint && { hint: result.hint }),
      message: result.ok
        ? skill_id
          ? `Re-deployed skill "${skill_id}" successfully.`
          : `Re-deployed ${deployedCount} skill(s) successfully.`
        : (result.error
            ? `Re-deploy failed: ${result.error}${result.hint ? ` — ${result.hint}` : ''}`
            : `Re-deploy had ${failedCount} failure(s). Check skills array or call the underlying endpoint with verbose:true.`),
    };
    // If the deploy landed and the solution declares widgets, verify each one
    // actually renders (discovered by Core + has a render block). A silently
    // non-rendering widget is a common, hard-to-notice failure — surface it here.
    if (result.ok) {
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
    for (const t of tenants) {
      switchTenant(sid, t.id);
      try {
        const { solutions } = await get("/deploy/solutions", sid);
        for (const sol of (solutions || [])) {
          let ghStatus = null;
          try {
            ghStatus = await get(`/deploy/solutions/${sol.id}/github/status`, sid);
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
    }
    return { ok: true, tenants: tenants.length, solutions: results.length, results };
  },

  ateam_sync_all: async ({ push_only, pull_only }, sid) => {
    if (!isMasterMode(sid)) {
      return { ok: false, message: "Master key required. Call ateam_auth(master_key: \"<key>\", tenant: \"<any>\") first." };
    }
    const tenants = await listTenants(sid);
    const results = [];
    for (const t of tenants) {
      switchTenant(sid, t.id);
      try {
        const { solutions } = await get("/deploy/solutions", sid);
        for (const sol of (solutions || [])) {
          const entry = { tenant: t.id, solution: sol.id, name: sol.name || sol.id };
          // Push: Builder FS → GitHub
          if (!pull_only) {
            try {
              const pushResult = await post(`/deploy/solutions/${sol.id}/github/push`, { push_to_github: true }, sid);
              entry.push = { ok: true, commit: pushResult.commitSha?.slice(0, 8), files: pushResult.filesCommitted };
            } catch (err) {
              entry.push = { ok: false, error: err.message.slice(0, 100) };
            }
          }
          // Pull: GitHub → Core MongoDB
          if (!push_only) {
            try {
              const pullResult = await post(`/deploy/solutions/${sol.id}/github/pull`, {}, sid);
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
    }
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
function formatResult(result, toolName) {
  const json = JSON.stringify(result, null, 2);

  if (json.length <= MAX_RESPONSE_CHARS) {
    return json;
  }

  // For large responses, provide a summary + truncated data
  const summary = summarizeLargeResult(result, toolName);
  return summary + `\n\n(Response truncated from ${json.length.toLocaleString()} chars. Use more specific queries to get smaller results.)`;
}

/**
 * Create a useful summary for large results.
 */
function summarizeLargeResult(result, toolName) {
  // Spec responses — keep content but cap size
  if (toolName === "ateam_get_spec" && result && typeof result === "object") {
    const keys = Object.keys(result);
    return JSON.stringify({
      _note: `A-Team spec with ${keys.length} sections. Content truncated — ask about specific sections for detail.`,
      sections: keys,
      ...result,
    }, null, 2).slice(0, MAX_RESPONSE_CHARS);
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

// ─── Dispatcher ─────────────────────────────────────────────────────

export async function handleToolCall(name, args, sessionId) {
  const handler = handlers[name];
  if (!handler) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  // Track activity + context on every tool call (keeps session alive, records what user is working on)
  touchSession(sessionId, {
    toolName: name,
    solutionId: args?.solution_id,
    skillId: args?.skill_id,
  });

  // Check auth for tenant-aware operations — requires explicit ateam_auth call.
  // Env vars (ADAS_API_KEY / ADAS_TENANT) are NOT sufficient — they may be
  // baked into MCP config and silently target the wrong tenant.
  // Only global/public tools (bootstrap, spec, examples, validate) bypass this.
  if (TENANT_TOOLS.has(name) && !isExplicitlyAuthenticated(sessionId)) {
    const hasEnvVars = isAuthenticated(sessionId);
    return {
      content: [{
        type: "text",
        text: [
          "Authentication required — call ateam_auth first.",
          "",
          hasEnvVars
            ? "Environment variables (ADAS_API_KEY) were detected, but they are not sufficient for tenant-aware operations. You must call ateam_auth explicitly to confirm which tenant you intend to use."
            : "No authentication found.",
          "",
          "Please ask the user to:",
          "1. Get their API key at: https://mcp.ateam-ai.com/get-api-key",
          "2. Then call: ateam_auth(api_key: \"<their key>\")",
          "",
          "The key format is: adas_<tenant>_<32hex> — the tenant is auto-extracted.",
          "This prevents accidental operations on the wrong tenant from pre-configured env vars.",
        ].join("\n"),
      }],
      isError: true,
    };
  }

  // Master mode: per-call tenant override (no re-auth needed)
  if (TENANT_TOOLS.has(name) && isMasterMode(sessionId) && args?.tenant) {
    switchTenant(sessionId, args.tenant);
  }

  try {
    const result = await handler(args, sessionId);

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
      // If authenticated, attach a tenant onboarding block so the agent can
      // discover existing solutions + their repo URLs without extra round-trips.
      // This is what lets a fresh agent clone the right repo on first greet.
      try {
        const creds = getCredentials(sessionId);
        if (creds?.apiKey || creds?.masterKey) {
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

    return {
      content: [{ type: "text", text: formatResult(result, name) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: err.message }],
      isError: true,
    };
  }
}

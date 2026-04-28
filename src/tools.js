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
  setAuthOverride, switchTenant, isMasterMode, listTenants,
} from "./api.js";
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
      "Get the A-Team specification — schemas, validation rules, system tools, agent guides, and templates. Start here after bootstrap to understand how to build skills and solutions. Use 'section' to get just one part of the skill spec (much smaller than the full spec). Use 'search' to find specific fields or concepts across the spec.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          enum: ["overview", "skill", "solution", "enums", "connector-multi-user"],
          description:
            "What to fetch: 'overview' = API overview + endpoints, 'skill' = full skill spec, 'solution' = full solution spec, 'enums' = all enum values, 'connector-multi-user' = multi-user connector guide",
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
    name: "ateam_build_and_run",
    core: true,
    description:
      "Build and deploy a governed AI Team solution in one step. ⚠️ HEAVIEST OPERATION (60-180s): validates solution+skills → deploys all connectors+skills to A-Team Core (regenerates MCP servers) → health-checks → optionally runs a warm test → auto-pushes to GitHub. AUTO-DETECTS GitHub repo: if you omit mcp_store and a repo exists, connector code is pulled from GitHub automatically. First deploy requires mcp_store. After that, write files via ateam_github_write, then just call build_and_run without mcp_store. For small changes to an already-deployed solution, prefer ateam_patch (faster, incremental). Requires authentication.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID. Use this INSTEAD of passing the full solution object — the solution definition is auto-pulled from GitHub. Required if solution object is omitted.",
        },
        solution: {
          type: "object",
          description: "Full solution definition. Required on first deploy. After first deploy, just pass solution_id instead — everything is auto-pulled from GitHub.",
        },
        skills: {
          type: "array",
          items: { type: "object" },
          description: "Optional after first deploy: skill definitions. If omitted, auto-pulled from GitHub repo (skills/{id}/skill.json).",
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
          description: "Optional: if true, pull connector source code from the solution's GitHub repo. AUTO-DETECTED: if you omit both mcp_store and github, the system checks if a repo exists and pulls from it automatically. You rarely need to set this explicitly.",
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
      "Send a test message to a deployed skill and get the full execution result. By default waits for completion (up to 60s). Set wait=false for async mode — returns job_id immediately, then poll with ateam_test_status.",
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
            "If true (default), wait for completion. If false, return job_id immediately for polling via ateam_test_status.",
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
    name: "ateam_conversation",
    core: true,
    description:
      "Send a message to a deployed solution and get the result. No skill_id needed — the system auto-routes to the right skill. Supports multi-turn conversations: pass the actor_id from a previous response to continue the thread (e.g., reply to a confirmation prompt). Each call creates a new job but the same actor_id maintains conversation context.",
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
        wait: {
          type: "boolean",
          description: "If true (default), wait for completion. If false, return job_id immediately for polling.",
        },
        timeout_ms: {
          type: "number",
          description: "Optional: max wait time in ms (default: 60000, max: 300000).",
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
      "SUPPORTED OPERATIONS:\n" +
      "1. Scalar (dot notation): { \"problem.statement\": \"new value\", \"role.persona\": \"You are...\" }\n" +
      "2. Deep nested: { \"intents.thresholds.accept\": 0.9, \"policy.escalation.enabled\": true }\n" +
      "3. Array push: { \"tools_push\": [{ name: \"new_tool\", description: \"...\" }] }\n" +
      "4. Array delete: { \"tools_delete\": [\"tool_name\"] }\n" +
      "5. Array update: { \"tools_update\": [{ name: \"existing_tool\", description: \"updated\" }] }\n" +
      "6. Replace whole section: { \"role\": { persona: \"...\", goals: [...] } }\n\n" +
      "EXAMPLES:\n" +
      "- Change persona (full replace): updates: { \"role.persona\": \"You are a friendly assistant\" }\n" +
      "- Append to persona (don't replace): updates: { \"persona_append\": \"\\n\\nALWAYS respond in 2 sentences.\" }\n" +
      "- Add a guardrail: updates: { \"policy.guardrails.never_push\": [\"Never share passwords\"] }\n" +
      "- Update problem: updates: { \"problem.statement\": \"...\", \"problem.goals\": [\"goal1\"] }\n" +
      "- Add a tool: updates: { \"tools_push\": [{ name: \"conn.tool\", description: \"...\", inputs: [...], output: {...} }] }\n" +
      "- Change intent: updates: { \"intents.supported_update\": [{ id: \"i1\", description: \"new desc\" }] }\n" +
      "- Force redeploy: updates: { \"_force_redeploy\": true }\n" +
      "- CREATE a new skill: target='skill', skill_id='my-new-skill', updates: { \"problem.statement\": \"...\", \"role.persona\": \"...\" }\n" +
      "  If the skill doesn't exist yet, a default scaffold is created and the updates are applied on top. The skill is automatically added to the solution topology.\n\n" +
      "Use target='skill' + skill_id for skill fields. Use target='solution' for solution-level fields (linked_skills, platform_connectors, ui_plugins).",
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
      "Delete a deployed solution and all its skills from A-Team. Use with caution — this removes the solution from both the Skill Builder and A-Team Core. Useful for cleaning up test solutions or starting fresh.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID to delete",
        },
      },
      required: ["solution_id"],
    },
  },
  {
    name: "ateam_delete_skill",
    core: true,
    description:
      "Delete a single skill from a deployed solution. Removes the skill from A-Team Core (kills the running MCP process, unregisters from skill registry, deletes from Mongo), removes the skill from solution.skills[] and solution.linked_skills, and deletes the skill's files from Builder FS. Use this to drop a skill without tearing down the whole solution.",
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
      },
      required: ["solution_id", "skill_id"],
    },
  },
  {
    name: "ateam_delete_connector",
    core: true,
    description:
      "Remove a connector from a deployed solution. Stops and deletes it from A-Team Core, removes references from the solution definition (grants, platform_connectors) and skill definitions (connectors array), and cleans up mcp-store files.",
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
      },
      required: ["solution_id", "connector_id"],
    },
  },

  {
    name: "ateam_upload_connector",
    core: true,
    description:
      "Upload connector code to Core and restart — WITHOUT redeploying skills. " +
      "Use this to update connector source code (server.js, UI assets, plugins) quickly. " +
      "Set github=true to pull files from the solution's GitHub repo, or pass files directly. " +
      "Much faster than ateam_build_and_run for connector-only changes.",
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
          description: "If true, pull connector files from GitHub repo. Default: false.",
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
          description: "Files to upload. Alternative to github=true.",
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
      "Poll the progress of an async skill test. Returns iteration count, tool call steps, status (running/completed/failed), and result when done. (Advanced — use ateam_test_skill with wait=true for synchronous testing.)",
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
      },
      required: ["solution_id", "skill_id", "job_id"],
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
      "Read any file from a solution's GitHub repo. Returns the file content. Use this to read connector source code, skill definitions, or any versioned file. Great for reviewing previous versions or understanding what's in the repo.",
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
      "Always use search/replace for large files (>5KB). Always read the file first with ateam_github_read to get the exact text to search for.",
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
      "Write each file individually (server.js, package.json, UI assets), then call ateam_build_and_run() to deploy.",
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
      },
      required: ["solution_id", "path", "content"],
    },
  },
  {
    name: "ateam_github_log",
    core: true,
    description:
      "View commit history for a solution's GitHub repo. Shows recent commits with messages, SHAs, timestamps, and links. Use this to see what changes have been made and when.",
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
      "Create a checkpoint (safe point) on the current main branch. Tags the current state with safe-YYYY-MM-DD-NNN so you can rollback to it later. Use this before risky changes or when the solution is in a known-good state.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
        label: {
          type: "string",
          description: "Optional: human-readable label for this checkpoint (e.g., 'before refactor', 'v2 stable')",
        },
      },
      required: ["solution_id"],
    },
  },
  {
    name: "ateam_github_rollback",
    core: true,
    description:
      "Rollback main branch to a previous checkpoint (safe-* tag). Resets main to the specified checkpoint commit. ⚠️ DESTRUCTIVE — use with caution. Use ateam_github_list_versions to find available checkpoints first.",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
        tag: {
          type: "string",
          description: "Required: checkpoint tag to rollback to (e.g., 'safe-2026-03-11-001')",
        },
      },
      required: ["solution_id", "tag"],
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
  "ateam_test_pipeline",
  "ateam_test_voice",
  "ateam_test_status",
  "ateam_test_abort",
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

const handlers = {
  ateam_bootstrap: async () => ({
    platform_positioning: {
      name: "A-Team",
      category: "AI Team Solution Platform",
      summary: "A-Team is a platform for building governed AI Teams as complete operational solutions.",
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
        { step: 5, action: "Test & Debug", description: "Test with ateam_conversation (auto-routes, supports multi-turn with actor_id for confirmations). Use ateam_test_pipeline for intent debugging, ateam_test_voice for voice. Diagnose with logs and metrics.", tools: ["ateam_conversation", "ateam_test_pipeline", "ateam_test_skill", "ateam_test_voice", "ateam_get_execution_logs", "ateam_get_metrics"] },
        { step: 6, action: "Checkpoint", description: "When solution is in a good state, create a checkpoint (safe point). You can rollback to any checkpoint if something breaks.", tools: ["ateam_github_promote", "ateam_github_list_versions"] },
      ],
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
          id: "handoff-controller-mcp",
          name: "Handoff Controller",
          purpose: "Live conversation handoffs between skills in a multi-skill solution",
          tool_prefixes: ["handoff."],
          typical_use: "Pass a live conversation from one skill to another (e.g. identity-assurance → order-support), carrying grants",
        },
        {
          id: "internal-comm-mcp",
          name: "Internal Communication",
          purpose: "Skill-to-skill messaging and voice replies",
          tool_prefixes: ["comm."],
          typical_use: "Async message between skills, or send a voice reply back through the Twilio channel",
        },
        {
          id: "browser-mcp",
          name: "Browser",
          purpose: "Headless Chromium automation (Playwright)",
          tool_prefixes: ["web."],
          typical_use: "Navigate, read, click, type, screenshot any public web page; scrape data for enrichment",
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
      tone: "Architectural, enterprise-grade, serious",
      always: [
        "Explain Skill vs Solution vs Connector before building",
        "Use ateam_build_and_run for the full lifecycle (validates automatically)",
        "Use ateam_patch for skill/solution definition changes (updates + redeploys automatically)",
        "Use ateam_github_patch + ateam_build_and_run(github:true) for connector code changes after first deploy",
        "Study the connector example (ateam_get_examples type='connector') before writing connector code",
        "Ask discovery questions if goal unclear",
        "ALL changes go directly to main — suggest ateam_github_promote() to create a checkpoint before risky changes",
        "After every build/patch, tell the user: 'Deployed to Core ✅ | Pushed to main | Create checkpoint: ateam_github_promote(solution_id)'",
      ],
      never: [
        "Call validate + deploy + health separately when ateam_build_and_run does it in one step",
        "Call update + redeploy separately when ateam_patch does it in one step",
        "Dump raw spec unless requested",
        "Write connector code that starts a web server — connectors MUST use stdio transport",
        "Mention dev branch — there is no dev branch, everything is on main",
        "Pass large connector code via mcp_store after the first deploy — use ateam_github_write/ateam_github_patch one file at a time instead",
        "Try to pass ALL connector files at once in a single tool call — write them individually to GitHub",
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
      ...(test_result && { test_result }),
      ...(github_result && !github_result.error && !github_result.skipped && { github: github_result }),
      ...(agent_doc_result && !agent_doc_result.error && { agent_doc: agent_doc_result }),
      ...(validation.warnings?.length > 0 && { validation_warnings: validation.warnings }),
      _status: '✅ Deployed to Core + pushed to main.',
      _next: 'Create a checkpoint before making more changes: ateam_github_promote(solution_id)',
    };
  },

  // ─── Composite: Patch ──────────────────────────────────────────────
  // Updates → Redeploys → Optionally tests
  // One call replaces: ateam_update + ateam_redeploy

  ateam_patch: async ({ solution_id, target, skill_id, updates, test_message }, sid) => {
    const phases = [];
    let isNewSkill = false;

    // GitHub-first patch: read from GitHub → apply patch → write back → redeploy
    // This ensures GitHub stays the single source of truth.

    // Phase 1: Read current state from GitHub (or create scaffold if new skill)
    let current;
    const filePath = target === "skill" && skill_id
      ? `skills/${skill_id}/skill.json`
      : `solution.json`;
    try {
      const readResult = await get(`/deploy/solutions/${solution_id}/github/read?path=${encodeURIComponent(filePath)}`, sid);
      current = JSON.parse(readResult.content);
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
          policy: { guardrails: { never: [], always: [] }, approvals: [], workflows: [], escalation: { enabled: false, conditions: [], target: "" } },
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
        return { ok: false, phase: "read", error: `Failed to read ${filePath} from GitHub: ${err.message}` };
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
        } else if (key.includes(".")) {
          // Dot notation: "role.persona", "intents.thresholds.accept"
          const parts = key.split(".");
          let obj = patched;
          for (let i = 0; i < parts.length - 1; i++) {
            if (!obj[parts[i]] || typeof obj[parts[i]] !== "object") obj[parts[i]] = {};
            obj = obj[parts[i]];
          }
          obj[parts[parts.length - 1]] = value;
        } else {
          // Direct field replacement
          patched[key] = value;
        }
      }
      phases.push({ phase: "patch", status: "done" });
    } catch (err) {
      return { ok: false, phase: "patch", error: `Failed to apply patch: ${err.message}` };
    }

    // Phase 3: Write patched version back to GitHub
    try {
      const patchKeys = Object.keys(updates || {});
      const message = `Patch: ${target}${skill_id ? ` ${skill_id}` : ""} — ${patchKeys.join(", ")}`;
      await post(`/deploy/solutions/${solution_id}/github/patch`, {
        path: filePath,
        content: JSON.stringify(patched, null, 2),
        message,
      }, sid, { timeoutMs: 30_000 });
      phases.push({ phase: "github_write", status: "done" });
    } catch (err) {
      return { ok: false, phase: "github_write", error: `Patch applied but failed to write to GitHub: ${err.message}`, phases };
    }

    // Phase 3b: If new skill, add it to solution.json topology (skills[], linked_skills)
    if (isNewSkill && skill_id) {
      try {
        const solRead = await get(`/deploy/solutions/${solution_id}/github/read?path=solution.json`, sid);
        const sol = JSON.parse(solRead.content);
        const skillEntry = { id: skill_id, name: patched.name || skill_id, role: "worker", description: patched.description || "", connectors: patched.connectors || [] };
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
    return {
      ok: true,
      solution_id,
      branch: 'main',
      phases,
      patched: patched,
      ...(isNewSkill && { created_skill: skill_id }),
      ...(redeployResult && { redeploy: redeployResult }),
      ...(test_result && { test_result }),
      _status: redeployOk
        ? '✅ Patched on GitHub + redeployed.'
        : '⚠️ Patched on GitHub ✅ but redeploy timed out. Run: ateam_redeploy(solution_id' + (skill_id ? `, skill_id: "${skill_id}"` : '') + ')',
      _next: 'Create a checkpoint before making more changes: ateam_github_promote(solution_id)',
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
    const asyncMode = wait === false;
    const body = {
      message,
      ...(actor_id ? { actor_id } : {}),
      ...(asyncMode ? { async: true } : {}),
      ...(timeout_ms ? { timeout_ms } : {}),
    };
    const timeoutMs = asyncMode ? 15_000 : Math.min((timeout_ms || 60_000) + 30_000, 330_000);
    return post(`/deploy/solutions/${solution_id}/test`, body, sid, { timeoutMs });
  },

  ateam_test_skill: async ({ solution_id, skill_id, message, wait, actor_id }, sid) => {
    const asyncMode = wait === false;
    const body = { message, ...(asyncMode ? { async: true } : {}), ...(actor_id ? { actor_id } : {}) };
    const timeoutMs = asyncMode ? 15_000 : 90_000;
    return post(`/deploy/solutions/${solution_id}/skills/${skill_id}/test`, body, sid, { timeoutMs });
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

  ateam_test_status: async ({ solution_id, skill_id, job_id }, sid) =>
    get(`/deploy/solutions/${solution_id}/skills/${skill_id}/test/${job_id}`, sid),

  ateam_test_abort: async ({ solution_id, skill_id, job_id }, sid) =>
    del(`/deploy/solutions/${solution_id}/skills/${skill_id}/test/${job_id}`, sid),

  ateam_get_connector_source: async ({ solution_id, connector_id }, sid) =>
    get(`/deploy/solutions/${solution_id}/connectors/${connector_id}/source`, sid),

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

  ateam_github_read: async ({ solution_id, path: filePath }, sid) =>
    get(`/deploy/solutions/${solution_id}/github/read?path=${encodeURIComponent(filePath)}`, sid),

  ateam_github_patch: async ({ solution_id, path: filePath, content, search, replace, message }, sid) =>
    post(`/deploy/solutions/${solution_id}/github/patch`, { path: filePath, content, search, replace, message }, sid),

  ateam_github_write: async ({ solution_id, path: filePath, content, message }, sid) =>
    post(`/deploy/solutions/${solution_id}/github/patch`, { path: filePath, content, message }, sid),

  ateam_github_log: async ({ solution_id, limit }, sid) => {
    const qs = limit ? `?limit=${limit}` : "";
    return get(`/deploy/solutions/${solution_id}/github/log${qs}`, sid);
  },

  ateam_github_promote: async ({ solution_id, label }, sid) =>
    post(`/deploy/solutions/${solution_id}/promote`, label ? { label } : {}, sid),

  ateam_github_rollback: async ({ solution_id, tag }, sid) =>
    post(`/deploy/solutions/${solution_id}/rollback`, { tag }, sid),

  ateam_github_list_versions: async ({ solution_id }, sid) =>
    get(`/deploy/solutions/${solution_id}/versions/dev`, sid),

  ateam_delete_solution: async ({ solution_id }, sid) =>
    del(`/deploy/solutions/${solution_id}`, sid),

  ateam_delete_skill: async ({ solution_id, skill_id }, sid) =>
    del(`/deploy/solutions/${solution_id}/skills/${skill_id}`, sid),

  ateam_delete_connector: async ({ solution_id, connector_id }, sid) =>
    del(`/deploy/solutions/${solution_id}/connectors/${connector_id}`, sid),

  ateam_upload_connector: async ({ solution_id, connector_id, github, files }, sid) =>
    post(
      `/deploy/solutions/${solution_id}/connectors/${connector_id}/upload`,
      { github, files },
      sid,
      { timeoutMs: 300_000, retries: 1 },
    ),

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

    return {
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

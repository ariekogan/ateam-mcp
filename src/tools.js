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
      "Get the A-Team specification — schemas, validation rules, system tools, agent guides, and templates. Start here after bootstrap to understand how to build skills and solutions.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          enum: ["overview", "skill", "solution", "enums", "connector-multi-user"],
          description:
            "What to fetch: 'overview' = API overview + endpoints, 'skill' = full skill spec, 'solution' = full solution spec, 'enums' = all enum values, 'connector-multi-user' = multi-user connector guide (actor isolation, zod gotcha, complete examples)",
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
          enum: ["skill", "connector", "connector-ui", "solution", "index"],
          description:
            "Example type: 'skill' = Order Support Agent, 'connector' = stdio MCP connector, 'connector-ui' = UI-capable connector, 'solution' = full 3-skill e-commerce solution, 'index' = list all available examples",
        },
      },
      required: ["type"],
    },
  },
  {
    name: "ateam_build_and_run",
    core: true,
    description:
      "Build and deploy a governed AI Team solution in one step. Validates, deploys, health-checks, and optionally runs a warm test — all in one call. Use this instead of calling validate, deploy, and health separately. Requires authentication.",
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
          description: "Optional: connector metadata (id, name, transport). Entry points auto-detected from mcp_store.",
        },
        mcp_store: {
          type: "object",
          description: "Optional: connector source code files. Key = connector id, value = array of {path, content}.",
        },
        github: {
          type: "boolean",
          description: "Optional: if true, pull connector source code from the solution's GitHub repo instead of requiring mcp_store. Use this after the first deploy (which creates the repo). Cannot be used on first deploy.",
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
      required: ["solution", "skills"],
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
      },
      required: ["solution_id", "skill_id", "message"],
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
      "Update a deployed skill or solution, redeploy, and optionally re-test — all in one step. Use this instead of calling update + redeploy separately. Requires authentication.",
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
    name: "ateam_redeploy",
    core: false,
    description:
      "Re-deploy after making updates. (Advanced — prefer ateam_patch which updates + redeploys in one step.)",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
        skill_id: {
          type: "string",
          description: "Optional: redeploy a single skill. Omit to redeploy all skills.",
        },
      },
      required: ["solution_id"],
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
    core: false,
    description:
      "Poll the progress of an async skill test. Returns iteration count, tool call steps, status, pending questions, and result when done. (Advanced — use ateam_test_skill with wait=true for synchronous testing.)",
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
    core: false,
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
      "Edit a specific file in the solution's GitHub repo and commit. Creates the file if it doesn't exist. Use this to make surgical fixes to connector source code, update skill definitions, or add new files directly in the repo.",
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
          description: "The full file content to write",
        },
        message: {
          type: "string",
          description: "Optional commit message (default: 'Update <path>')",
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
  // MASTER KEY TOOLS — cross-tenant bulk operations (master key only)
  // ═══════════════════════════════════════════════════════════════════

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
  "ateam_delete_connector",
  "ateam_solution_chat",
  // Read operations (tenant-specific data)
  "ateam_list_solutions",
  "ateam_get_solution",
  "ateam_get_execution_logs",
  "ateam_test_skill",
  "ateam_test_pipeline",
  "ateam_test_voice",
  "ateam_test_status",
  "ateam_test_abort",
  "ateam_get_connector_source",
  "ateam_get_metrics",
  "ateam_diff",
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
      _note: "This is the recommended build loop. 5 steps from definition to running skill with GitHub version control.",
      steps: [
        { step: 1, action: "Learn", description: "Get the spec and study examples", tools: ["ateam_get_spec", "ateam_get_examples"] },
        { step: 2, action: "Build & Run", description: "Define your solution + skills + connector code, then validate, deploy, and health-check in one call. Include mcp_store with connector source code on the first deploy.", tools: ["ateam_build_and_run"] },
        { step: 3, action: "Version", description: "Every deploy auto-pushes to GitHub. The repo (tenant--solution-id) is the source of truth for connector code.", tools: ["ateam_github_status", "ateam_github_log"] },
        { step: 4, action: "Iterate", description: "Edit connector code via ateam_github_patch, then redeploy with ateam_build_and_run(github:true). For skill definition changes (intents, tools, policy), use ateam_patch.", tools: ["ateam_github_patch", "ateam_build_and_run", "ateam_patch"] },
        { step: 5, action: "Test & Debug", description: "Test the decision pipeline or full execution, then diagnose with logs and metrics. For voice-enabled solutions, use ateam_test_voice to simulate phone conversations.", tools: ["ateam_test_pipeline", "ateam_test_skill", "ateam_test_voice", "ateam_get_execution_logs", "ateam_get_metrics"] },
      ],
    },
    first_questions: [
      { id: "goal", question: "What do you want your Team to accomplish?", type: "text" },
      { id: "domain", question: "Which domain fits best?", type: "enum", options: ["ecommerce", "logistics", "enterprise_ops", "other"] },
      { id: "systems", question: "Which systems should the Team connect to?", type: "multi_select", options: ["slack", "email", "zendesk", "shopify", "jira", "postgres", "custom_api", "none"] },
      { id: "security", question: "What environment constraints?", type: "enum", options: ["sandbox", "controlled", "regulated"] },
    ],
    github_tools: {
      _note: "Version control for solutions. Every deploy auto-pushes to GitHub. The repo is the source of truth for connector code.",
      tools: ["ateam_github_push", "ateam_github_pull", "ateam_github_status", "ateam_github_read", "ateam_github_patch", "ateam_github_log"],
      repo_structure: {
        "solution.json": "Full solution definition",
        "skills/{skill-id}/skill.json": "Individual skill definitions",
        "connectors/{connector-id}/server.js": "Connector MCP server code",
        "connectors/{connector-id}/package.json": "Connector dependencies",
      },
      iteration_workflow: {
        code_changes: "ateam_github_patch (edit connector files) → ateam_build_and_run(github:true) (redeploy from repo)",
        definition_changes: "ateam_patch (edit skill/solution definitions directly in Builder)",
        first_deploy: "Must include mcp_store — this creates the GitHub repo",
      },
      when_to_use_what: {
        ateam_github_patch: "Edit connector source code (server.js, utils, package.json, UI assets)",
        ateam_patch: "Edit skill definitions (intents, tools, policy) or solution definitions (grants, handoffs, routing)",
        "ateam_build_and_run(github:true)": "Redeploy solution pulling latest connector code from GitHub",
        "ateam_build_and_run(mcp_store)": "First deploy or when you want to pass connector code inline",
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
      ],
      never: [
        "Call validate + deploy + health separately when ateam_build_and_run does it in one step",
        "Call update + redeploy separately when ateam_patch does it in one step",
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
    // Auto-extract tenant from key if not provided
    let resolvedTenant = tenant;
    if (!resolvedTenant) {
      const parsed = parseApiKey(api_key);
      resolvedTenant = parsed.tenant || "main";
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

  ateam_get_spec: async ({ topic }, sid) => get(SPEC_PATHS[topic], sid),

  ateam_get_workflows: async (_args, sid) => get("/spec/workflows", sid),

  ateam_get_examples: async ({ type }, sid) => get(EXAMPLE_PATHS[type], sid),

  // ─── Composite: Build & Run ────────────────────────────────────────
  // Validates → Deploys → Health-checks → Optionally tests
  // One call replaces: validate_solution + deploy_solution + get_solution(health)

  ateam_build_and_run: async ({ solution, skills, connectors, mcp_store, github, test_message, test_skill_id }, sid) => {
    const phases = [];

    // Phase 0: GitHub pull (if github:true — pull connector source from repo)
    let effectiveMcpStore = mcp_store;
    if (github && !mcp_store) {
      try {
        const pullResult = await post(
          `/deploy/solutions/${solution.id}/github/pull-connectors`,
          {},
          sid,
          { timeoutMs: 30_000 },
        );
        if (!pullResult.ok) {
          return {
            ok: false,
            phase: "github_pull",
            error: pullResult.error || "Failed to pull connectors from GitHub",
            hint: pullResult.hint || "Deploy the solution first (with mcp_store) to auto-create the GitHub repo.",
            message: "Cannot pull connector code from GitHub. The repo may not exist yet — deploy with mcp_store first.",
          };
        }
        effectiveMcpStore = pullResult.mcp_store;
        phases.push({
          phase: "github_pull",
          status: "done",
          connectors_found: pullResult.connectors_found || 0,
          files_loaded: pullResult.files_loaded || 0,
        });
      } catch (err) {
        return {
          ok: false,
          phase: "github_pull",
          error: err.message,
          message: "Failed to pull connector code from GitHub. The repo may not exist yet — deploy with mcp_store first.",
        };
      }
    }

    // Phase 1: Validate
    let validation;
    try {
      validation = await post("/validate/solution", { solution, skills, connectors, mcp_store: effectiveMcpStore }, sid);
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
      deploy = await post("/deploy/solution", { solution, skills, connectors, mcp_store: effectiveMcpStore }, sid);
      phases.push({ phase: "deploy", status: deploy.ok ? "done" : "failed" });
    } catch (err) {
      return {
        ok: false,
        phase: "deployment",
        phases,
        error: err.message,
        validation_warnings: validation.warnings || [],
        message: "Deployment failed. See error details above.",
      };
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

    // Phase 3: Health check (with brief wait for propagation)
    let health;
    try {
      await sleep(2000);
      health = await get(`/deploy/solutions/${solution.id}/health`, sid);
      phases.push({ phase: "health", status: "done" });
    } catch (err) {
      health = { error: err.message };
      phases.push({ phase: "health", status: "error", error: err.message });
    }

    // Phase 4: Warm test (optional)
    let test_result;
    if (test_message) {
      const skillId = test_skill_id || skills?.[0]?.id;
      if (skillId) {
        try {
          test_result = await post(
            `/deploy/solutions/${solution.id}/skills/${skillId}/test`,
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

    // Phase 5: GitHub push (auto — non-blocking, failures don't fail the deploy)
    let github_result;
    try {
      github_result = await post(
        `/deploy/solutions/${solution.id}/github/push`,
        { message: `Deploy: ${solution.name || solution.id}` },
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

    return {
      ok: true,
      solution_id: solution.id,
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
      ...(validation.warnings?.length > 0 && { validation_warnings: validation.warnings }),
    };
  },

  // ─── Composite: Patch ──────────────────────────────────────────────
  // Updates → Redeploys → Optionally tests
  // One call replaces: ateam_update + ateam_redeploy

  ateam_patch: async ({ solution_id, target, skill_id, updates, test_message }, sid) => {
    const phases = [];

    // Phase 1: Apply PATCH
    let patchResult;
    try {
      if (target === "skill") {
        patchResult = await patch(`/deploy/solutions/${solution_id}/skills/${skill_id}`, { updates }, sid);
      } else {
        patchResult = await patch(`/deploy/solutions/${solution_id}`, { state_update: updates }, sid);
      }
      phases.push({ phase: "update", status: "done" });
    } catch (err) {
      return {
        ok: false,
        phase: "update",
        error: err.message,
        message: "Patch failed. Check your updates payload format.",
      };
    }

    // Phase 2: Redeploy
    let redeployResult;
    try {
      if (target === "skill" && skill_id) {
        redeployResult = await post(`/deploy/solutions/${solution_id}/skills/${skill_id}/redeploy`, {}, sid);
      } else {
        redeployResult = await post(`/deploy/solutions/${solution_id}/redeploy`, {}, sid);
      }
      phases.push({ phase: "redeploy", status: "done" });
    } catch (err) {
      return {
        ok: false,
        phase: "redeploy",
        phases,
        patch: patchResult,
        error: err.message,
        message: "Update succeeded but redeploy failed. Try ateam_redeploy manually.",
      };
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

    return {
      ok: true,
      solution_id,
      phases,
      patch: patchResult,
      redeploy: redeployResult,
      ...(test_result && { test_result }),
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

  ateam_list_solutions: async (_args, sid) => get("/deploy/solutions", sid),

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

  ateam_redeploy: async ({ solution_id, skill_id }, sid) => {
    if (skill_id) {
      return post(`/deploy/solutions/${solution_id}/skills/${skill_id}/redeploy`, {}, sid);
    }
    return post(`/deploy/solutions/${solution_id}/redeploy`, {}, sid);
  },

  ateam_solution_chat: async ({ solution_id, message }, sid) =>
    post(`/deploy/solutions/${solution_id}/chat`, { message }, sid),

  // ─── Developer Tools ────────────────────────────────────────────

  ateam_get_execution_logs: async ({ solution_id, skill_id, job_id, limit }, sid) => {
    const qs = new URLSearchParams();
    if (skill_id) qs.set("skill_id", skill_id);
    if (job_id) qs.set("job_id", job_id);
    if (limit) qs.set("limit", String(limit));
    const qsStr = qs.toString() ? `?${qs}` : "";
    return get(`/deploy/solutions/${solution_id}/logs${qsStr}`, sid);
  },

  ateam_test_skill: async ({ solution_id, skill_id, message, wait }, sid) => {
    const asyncMode = wait === false;
    const body = { message, ...(asyncMode ? { async: true } : {}) };
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

  ateam_get_metrics: async ({ solution_id, job_id, skill_id }, sid) => {
    const qs = new URLSearchParams();
    if (job_id) qs.set("job_id", job_id);
    if (skill_id) qs.set("skill_id", skill_id);
    const qsStr = qs.toString() ? `?${qs}` : "";
    return get(`/deploy/solutions/${solution_id}/metrics${qsStr}`, sid);
  },

  ateam_diff: async ({ solution_id, skill_id }, sid) => {
    const qs = skill_id ? `?skill_id=${encodeURIComponent(skill_id)}` : "";
    return get(`/deploy/solutions/${solution_id}/diff${qs}`, sid);
  },

  // ─── GitHub tools ──────────────────────────────────────────────────

  ateam_github_push: async ({ solution_id, message }, sid) =>
    post(`/deploy/solutions/${solution_id}/github/push`, { message }, sid, { timeoutMs: 60_000 }),

  ateam_github_pull: async ({ solution_id }, sid) =>
    post(`/deploy/solutions/${solution_id}/github/pull`, {}, sid, { timeoutMs: 300_000 }),

  ateam_github_status: async ({ solution_id }, sid) =>
    get(`/deploy/solutions/${solution_id}/github/status`, sid),

  ateam_github_read: async ({ solution_id, path: filePath }, sid) =>
    get(`/deploy/solutions/${solution_id}/github/read?path=${encodeURIComponent(filePath)}`, sid),

  ateam_github_patch: async ({ solution_id, path: filePath, content, message }, sid) =>
    post(`/deploy/solutions/${solution_id}/github/patch`, { path: filePath, content, message }, sid),

  ateam_github_log: async ({ solution_id, limit }, sid) => {
    const qs = limit ? `?limit=${limit}` : "";
    return get(`/deploy/solutions/${solution_id}/github/log${qs}`, sid);
  },

  ateam_delete_solution: async ({ solution_id }, sid) =>
    del(`/deploy/solutions/${solution_id}`, sid),

  ateam_delete_connector: async ({ solution_id, connector_id }, sid) =>
    del(`/deploy/solutions/${solution_id}/connectors/${connector_id}`, sid),

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
              const pushResult = await post(`/deploy/solutions/${sol.id}/github/push`, {}, sid);
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

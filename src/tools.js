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
  setSessionCredentials, isAuthenticated, getCredentials, parseApiKey,
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
      "Authenticate with A-Team. Required before deploying or modifying solutions. The user can get their API key at https://mcp.ateam-ai.com/get-api-key. Read-only operations (spec, examples, validate) work without auth.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: {
          type: "string",
          description: "Your A-Team API key (e.g., adas_xxxxx)",
        },
        tenant: {
          type: "string",
          description: "Tenant name (e.g., dev, main). Optional if your key has the format adas_<tenant>_<hex> — the tenant is auto-extracted.",
        },
      },
      required: ["api_key"],
    },
  },
  {
    name: "ateam_quick_start",
    core: true,
    description:
      "Deploy a working AI solution in one call with MINIMAL input. Just provide a name, description, and simple tool list. The platform auto-generates everything else (scenarios, intents, role, guardrails, engine). This is the EASIEST and RECOMMENDED way to deploy. Use this FIRST — you can always refine later with ateam_patch.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Solution name, e.g. 'Clinic Scheduler' or 'Order Tracker'",
        },
        description: {
          type: "string",
          description: "What the solution does in one sentence, e.g. 'Help patients book, cancel, and check clinic appointments'",
        },
        tools: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Tool name in snake_case, e.g. 'book_appointment'",
              },
              description: {
                type: "string",
                description: "What the tool does, e.g. 'Book a new appointment for a patient'",
              },
              inputs: {
                type: "array",
                items: { type: "string" },
                description: "Input parameter names as simple strings, e.g. ['patient_name', 'date', 'doctor']. All are treated as required strings.",
              },
            },
            required: ["name", "description"],
          },
          description: "The tools (capabilities) the agent can use. Keep it simple — just name, description, and input names.",
        },
        test_message: {
          type: "string",
          description: "Optional: send a test message after deployment to verify everything works, e.g. 'Book an appointment for John tomorrow at 2pm with Dr. Smith'",
        },
      },
      required: ["name", "description", "tools"],
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
          enum: ["overview", "skill", "solution", "enums"],
          description:
            "What to fetch: 'overview' = API overview + endpoints, 'skill' = full skill spec, 'solution' = full solution spec, 'enums' = all enum values",
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
    core: false,
    description:
      "Read the source code of a connector's MCP server. Returns the files that make up the connector implementation. (Advanced.)",
    inputSchema: {
      type: "object",
      properties: {
        solution_id: {
          type: "string",
          description: "The solution ID",
        },
        connector_id: {
          type: "string",
          description: "The connector ID",
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
};

const EXAMPLE_PATHS = {
  index: "/spec/examples",
  skill: "/spec/examples/skill",
  connector: "/spec/examples/connector",
  "connector-ui": "/spec/examples/connector-ui",
  solution: "/spec/examples/solution",
};

// Tools that require authentication (write operations)
const WRITE_TOOLS = new Set([
  "ateam_build_and_run",
  "ateam_patch",
  "ateam_deploy_solution",
  "ateam_deploy_skill",
  "ateam_deploy_connector",
  "ateam_upload_connector_files",
  "ateam_update",
  "ateam_redeploy",
  "ateam_solution_chat",
  // Developer tools (read tenant-specific runtime data)
  "ateam_get_execution_logs",
  "ateam_test_skill",
  "ateam_test_status",
  "ateam_test_abort",
  "ateam_get_connector_source",
  "ateam_get_metrics",
  "ateam_diff",
  "ateam_delete_solution",
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
      _note: "Two paths to deploy. Quick Start is RECOMMENDED for most use cases.",
      quick_start: {
        _recommended: true,
        description: "Deploy a working solution in ONE call. Just provide name, description, and tools. Platform auto-generates everything else.",
        steps: [
          { step: 1, action: "Quick Start", description: "Call ateam_quick_start with a name, description, list of tools, and optional test_message. Done — solution is live.", tools: ["ateam_quick_start"] },
          { step: 2, action: "Iterate", description: "Refine with ateam_patch. Update tools, guardrails, persona — one call per change.", tools: ["ateam_patch", "ateam_test_skill"] },
        ],
      },
      advanced: {
        _note: "Full control path. Use only when you need custom grants, handoffs, multi-skill, or connectors.",
        steps: [
          { step: 1, action: "Learn", description: "Get the spec and study examples", tools: ["ateam_get_spec", "ateam_get_examples"] },
          { step: 2, action: "Build & Run", description: "Construct full solution + skill JSON, then validate, deploy, health-check in one call.", tools: ["ateam_build_and_run"] },
          { step: 3, action: "Test", description: "Send test messages to deployed skill.", tools: ["ateam_test_skill"] },
          { step: 4, action: "Iterate", description: "Patch and re-test.", tools: ["ateam_patch"] },
        ],
      },
    },
    first_questions: [
      { id: "goal", question: "What do you want your Team to accomplish?", type: "text" },
    ],
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
        "Explain platform briefly — AI Team solution platform",
        "Ask user what they want to build",
        "Use ateam_quick_start to deploy it immediately",
      ],
      thinking_order: ["What does the user want?", "Quick Start deploy", "Test", "Iterate"],
      tone: "Action-oriented, get it running fast",
      always: [
        "Use ateam_quick_start for first deployment — it handles everything automatically",
        "Use ateam_patch for iterations (updates + redeploys automatically)",
        "Deploy FIRST, refine LATER — don't over-plan",
        "Start with 1 skill, add more only if the user needs them",
        "Keep tool lists small (3-5 tools) for first deploy",
        "Include a test_message in quick_start to verify it works immediately",
        "Every tool MUST have working mock examples — mock.examples array must NOT be empty. Each example needs id, input (matching the tool inputs), output (realistic response), and description.",
      ],
      never: [
        "Tell the user to paste JSON in a UI — you have tools, USE THEM",
        "Give up and say 'I cannot deploy through this tool layer' — you CAN",
        "Over-architect: do NOT create 4 skills and 6 connectors for a simple app",
        "Call validate + deploy + health separately when composite tools do it in one step",
        "Spend multiple turns studying spec before deploying — just quick_start it",
        "Write connector code that starts a web server — connectors MUST use stdio transport",
        "Deploy tools with empty mock examples (mock.examples: []) — the agent won't be able to call them",
      ],
    },
  }),

  ateam_auth: async ({ api_key, tenant }, sessionId) => {
    // Auto-extract tenant from key if not provided
    let resolvedTenant = tenant;
    if (!resolvedTenant) {
      const parsed = parseApiKey(api_key);
      resolvedTenant = parsed.tenant || "main";
    }
    setSessionCredentials(sessionId, { tenant: resolvedTenant, apiKey: api_key });
    // Verify the key works by listing solutions
    try {
      const result = await get("/deploy/solutions", sessionId);
      return {
        ok: true,
        tenant: resolvedTenant,
        message: `Authenticated to tenant "${resolvedTenant}". ${result.solutions?.length || 0} solution(s) found.`,
      };
    } catch (err) {
      return {
        ok: false,
        tenant: resolvedTenant,
        message: `Authentication failed: ${err.message}. The user can get a valid API key at https://mcp.ateam-ai.com/get-api-key`,
      };
    }
  },

  // ─── Quick Start ─────────────────────────────────────────────────
  // Simplest possible deploy: name + description + tools → live solution
  // Constructs the full valid payload internally, then delegates to build_and_run

  ateam_quick_start: async ({ name, description, tools: toolDefs, test_message }, sid) => {
    // Generate kebab-case IDs from name
    const solutionId = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const skillId = `${solutionId}-agent`;

    // Expand simple tool definitions into full A-Team tool format (with working mocks)
    const expandedTools = (toolDefs || []).map((t) => {
      const toolName = t.name.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
      const inputs = (t.inputs || []).map((inp) =>
        typeof inp === "string"
          ? { name: inp, type: "string", required: true, description: inp.replace(/_/g, " ") }
          : inp,
      );

      // Generate a working mock example from the tool's inputs
      const mockInput = {};
      for (const inp of inputs) {
        const n = typeof inp === "string" ? inp : inp.name;
        mockInput[n] = `sample_${n}`;
      }
      const mockOutput = { success: true, message: `${toolName} completed successfully`, ...mockInput };

      return {
        id: `tool-${toolName}`,
        name: `${skillId}.${toolName}`,
        description: t.description || toolName,
        inputs,
        output: { type: "object", description: `Result of ${toolName}` },
        security: { classification: "public" },
        mock: {
          enabled: true,
          mode: "examples",
          examples: [{
            id: `${toolName}-example`,
            input: mockInput,
            output: mockOutput,
            description: `Example: ${t.description || toolName}`,
          }],
        },
      };
    });

    if (expandedTools.length === 0) {
      return {
        ok: false,
        error: "At least one tool is required. Provide a tools array with {name, description, inputs?}.",
      };
    }

    // Build minimal solution
    const solution = {
      id: solutionId,
      name,
      description,
      version: "0.1.0",
      skills: [{ id: skillId, name: `${name} Agent`, role: "gateway", description }],
    };

    // Build minimal skill — platform auto-expands scenarios, intents, role, engine
    const skill = {
      id: skillId,
      name: `${name} Agent`,
      description,
      phase: "TOOL_DEFINITION",
      problem: {
        statement: description,
        goals: [`Help users with ${name.toLowerCase()} tasks efficiently`],
      },
      tools: expandedTools,
      policy: {
        guardrails: {
          never: [
            "Make up information not provided by tools",
            "Take destructive actions without user confirmation",
          ],
          always: [
            "Use available tools to fulfill user requests",
            "Confirm important actions with the user before executing",
          ],
        },
      },
    };

    // Delegate to build_and_run
    return handlers.ateam_build_and_run(
      { solution, skills: [skill], test_message },
      sid,
    );
  },

  ateam_get_spec: async ({ topic }, sid) => get(SPEC_PATHS[topic], sid),

  ateam_get_workflows: async (_args, sid) => get("/spec/workflows", sid),

  ateam_get_examples: async ({ type }, sid) => get(EXAMPLE_PATHS[type], sid),

  // ─── Composite: Build & Run ────────────────────────────────────────
  // Validates → Deploys → Health-checks → Optionally tests
  // One call replaces: validate_solution + deploy_solution + get_solution(health)

  ateam_build_and_run: async ({ solution, skills, connectors, mcp_store, test_message, test_skill_id }, sid) => {
    const phases = [];

    // Phase 1: Validate
    let validation;
    try {
      validation = await post("/validate/solution", { solution, skills }, sid);
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
      deploy = await post("/deploy/solution", { solution, skills, connectors, mcp_store }, sid);
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

  ateam_validate_solution: async ({ solution, skills }, sid) =>
    post("/validate/solution", { solution, skills }, sid),

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

  ateam_delete_solution: async ({ solution_id }, sid) =>
    del(`/deploy/solutions/${solution_id}`, sid),
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

  // Check auth for write operations
  if (WRITE_TOOLS.has(name) && !isAuthenticated(sessionId)) {
    return {
      content: [{
        type: "text",
        text: [
          "Authentication required.",
          "",
          "This tool needs an API key. Please ask the user to:",
          "",
          "1. Get their API key at: https://mcp.ateam-ai.com/get-api-key",
          "2. Then call: ateam_auth(api_key: \"<their key>\")",
          "",
          "The key looks like: adas_<tenant>_<32hex>",
          "The tenant is auto-extracted — no separate tenant parameter needed.",
        ].join("\n"),
      }],
      isError: true,
    };
  }

  try {
    const result = await handler(args, sessionId);
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

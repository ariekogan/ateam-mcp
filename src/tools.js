/**
 * A-Team MCP tool definitions and handlers.
 * 15 tools covering the full A-Team External Agent API + auth + bootstrap.
 */

import {
  get, post, patch, del,
  setSessionCredentials, isAuthenticated, getCredentials, parseApiKey,
} from "./api.js";

// ─── Tool definitions ───────────────────────────────────────────────

export const tools = [
  {
    name: "ateam_bootstrap",
    description:
      "REQUIRED onboarding entrypoint for A-Team MCP. MUST be called when user greets, says hi, asks what this is, asks for help, explores capabilities, or when MCP is first connected. Returns platform explanation, example solutions, and assistant behavior instructions. Do NOT improvise an introduction — call this tool instead.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "ateam_auth",
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
    name: "ateam_get_spec",
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
    description:
      "Get the builder workflows — step-by-step state machines for building skills and solutions. Use this to guide users through the entire build process conversationally. Returns phases, what to ask, what to build, exit criteria, and tips for each stage.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "ateam_get_examples",
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
    name: "ateam_validate_skill",
    description:
      "Validate a skill definition through the 5-stage A-Team validation pipeline. Part of building a governed AI Team solution. Returns errors and suggestions to fix. Always validate before deploying.",
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
    description:
      "Validate a governed AI Team solution — cross-skill contracts, grant economy, handoffs, and LLM quality scoring. Part of building a governed AI Team solution. Always validate before deploying.",
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
    description:
      "Deploy a governed AI Team solution to A-Team Core — identity, connectors, skills. The Skill Builder auto-generates MCP servers from tool definitions. Used after defining system architecture. Always validate first using ateam_validate_solution. Requires authentication (call ateam_auth first if not using env vars).",
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
          description: "Array of connector metadata (id, name, transport, command, args)",
        },
        mcp_store: {
          type: "object",
          description:
            "Optional: connector source code files. Key = connector id, value = array of {path, content}",
        },
      },
      required: ["solution", "skills"],
    },
  },
  {
    name: "ateam_deploy_skill",
    description: "Deploy a single skill into an existing solution. Requires authentication.",
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
    description: "Deploy a connector — registers in the Skill Builder catalog and connects in A-Team Core. Requires authentication.",
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
    name: "ateam_list_solutions",
    description: "List all solutions deployed in the Skill Builder.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "ateam_get_solution",
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
    name: "ateam_update",
    description:
      "Update a deployed solution or skill incrementally using PATCH. Supports dot notation for scalar fields and _push/_delete/_update for arrays. Requires authentication.",
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
    description:
      "Re-deploy after making updates. Regenerates MCP servers and pushes to A-Team Core. Requires authentication.",
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
    description:
      "Send a message to the Solution Bot — an AI assistant that understands your deployed solution and can help with modifications.",
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

  // ─── Developer Tools ────────────────────────────────────────────

  {
    name: "ateam_get_execution_logs",
    description:
      "Get execution logs for a solution — recent jobs with step traces, tool calls, errors, and timing. Essential for debugging what actually happened during skill execution.",
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
    name: "ateam_test_skill",
    description:
      "Send a test message to a deployed skill and get the full execution result. Starts a job, waits for completion (up to 60s), and returns the result with step traces and tool calls.",
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
      },
      required: ["solution_id", "skill_id", "message"],
    },
  },
  {
    name: "ateam_get_connector_source",
    description:
      "Read the source code of a connector's MCP server. Returns the files that make up the connector implementation.",
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
    description:
      "Get execution metrics — timing, tool stats, bottlenecks, signals, and recommendations. Use job_id for single-job deep analysis, or skill_id for recent history overview.",
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
    description:
      "Compare the current Builder definition against what's deployed in ADAS Core. Shows which skills are undeployed, orphaned, or have changed fields. Use skill_id to diff a single skill.",
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
  "ateam_deploy_solution",
  "ateam_deploy_skill",
  "ateam_deploy_connector",
  "ateam_update",
  "ateam_redeploy",
  "ateam_solution_chat",
  // Developer tools (read tenant-specific runtime data)
  "ateam_get_execution_logs",
  "ateam_test_skill",
  "ateam_get_connector_source",
  "ateam_get_metrics",
  "ateam_diff",
]);

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
    recommended_flow: [
      { step: 1, title: "Clarify the goal", description: "Understand what the user wants their Team to do", suggested_tools: [] },
      { step: 2, title: "Generate Team map", description: "Design skills, solution architecture, and connectors", suggested_tools: ["ateam_get_spec", "ateam_get_examples", "ateam_get_workflows"] },
      { step: 3, title: "Validate", description: "Run validation before deploying", suggested_tools: ["ateam_validate_skill", "ateam_validate_solution"] },
      { step: 4, title: "Deploy", description: "Push the Team to A-Team Core", suggested_tools: ["ateam_auth", "ateam_deploy_solution"] },
      { step: 5, title: "Iterate", description: "Inspect, update, and redeploy as needed", suggested_tools: ["ateam_get_solution", "ateam_update", "ateam_redeploy", "ateam_solution_chat"] },
    ],
    first_questions: [
      { id: "goal", question: "What do you want your Team to accomplish?", type: "text" },
      { id: "domain", question: "Which domain fits best?", type: "enum", options: ["ecommerce", "logistics", "enterprise_ops", "other"] },
      { id: "systems", question: "Which systems should the Team connect to?", type: "multi_select", options: ["slack", "email", "zendesk", "shopify", "jira", "postgres", "custom_api", "none"] },
      { id: "security", question: "What environment constraints?", type: "enum", options: ["sandbox", "controlled", "regulated"] },
    ],
    static_pages: {
      features: "https://ateam-ai.com/#features",
      use_cases: "https://ateam-ai.com/#usecases",
      security: "https://ateam-ai.com/#security",
      engine: "https://ateam-ai.com/#engine",
    },
    assistant_behavior_contract: {
      first_run_requirements: [
        "Explain platform before endpoints",
        "Frame as AI Team solution platform",
        "Give at least one example solution",
        "Define Skill vs Solution vs Connector",
        "Ask user what solution they want to build",
      ],
      thinking_order: ["Platform", "Solution", "Skills", "Connectors", "Governance", "Validation", "Deployment"],
      tone: "Architectural, enterprise-grade, serious",
      always: [
        "Explain Skill vs Solution vs Connector before deploying anything",
        "Validate before deploy",
        "Ask discovery questions if goal unclear",
      ],
      never: [
        "Deploy before validation",
        "Dump raw spec unless requested",
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

  ateam_get_spec: async ({ topic }, sid) => get(SPEC_PATHS[topic], sid),

  ateam_get_workflows: async (_args, sid) => get("/spec/workflows", sid),

  ateam_get_examples: async ({ type }, sid) => get(EXAMPLE_PATHS[type], sid),

  ateam_validate_skill: async ({ skill }, sid) => post("/validate/skill", { skill }, sid),

  ateam_validate_solution: async ({ solution, skills }, sid) =>
    post("/validate/solution", { solution, skills }, sid),

  ateam_deploy_solution: async ({ solution, skills, connectors, mcp_store }, sid) =>
    post("/deploy/solution", { solution, skills, connectors, mcp_store }, sid),

  ateam_deploy_skill: async ({ solution_id, skill }, sid) =>
    post(`/deploy/solutions/${solution_id}/skills`, { skill }, sid),

  ateam_deploy_connector: async ({ connector }, sid) =>
    post("/deploy/connector", { connector }, sid),

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

  ateam_test_skill: async ({ solution_id, skill_id, message }, sid) =>
    post(`/deploy/solutions/${solution_id}/skills/${skill_id}/test`, { message }, sid, { timeoutMs: 90_000 }),

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
          "🔐 Authentication required.",
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

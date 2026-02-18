/**
 * ADAS MCP tool definitions and handlers.
 * 14 tools covering the full ADAS External Agent API + auth.
 */

import {
  get, post, patch, del,
  setSessionCredentials, isAuthenticated, getCredentials,
} from "./api.js";

// ─── Tool definitions ───────────────────────────────────────────────

export const tools = [
  {
    name: "adas_auth",
    description:
      "Authenticate with ADAS. Required before deploying or modifying solutions. Provide your API key and tenant name. Read-only operations (spec, examples, validate) work without auth.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: {
          type: "string",
          description: "Your ADAS API key (e.g., adas_xxxxx)",
        },
        tenant: {
          type: "string",
          description: "Tenant name (e.g., dev, main)",
        },
      },
      required: ["api_key", "tenant"],
    },
  },
  {
    name: "adas_get_spec",
    description:
      "Get the ADAS specification — schemas, validation rules, system tools, agent guides, and templates. Use this to understand how to build skills and solutions.",
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
    name: "adas_get_workflows",
    description:
      "Get the builder workflows — step-by-step state machines for building skills and solutions. Use this to guide users through the entire build process conversationally. Returns phases, what to ask, what to build, exit criteria, and tips for each stage.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "adas_get_examples",
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
    name: "adas_validate_skill",
    description:
      "Validate a skill definition through the 5-stage ADAS validation pipeline. Returns errors and suggestions to fix.",
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
    name: "adas_validate_solution",
    description:
      "Validate a solution definition — cross-skill contracts, grant economy, handoffs, and LLM quality scoring.",
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
    name: "adas_deploy_solution",
    description:
      "Deploy a complete solution to ADAS Core — identity, connectors, skills. The Skill Builder auto-generates MCP servers from tool definitions. This is the main deployment action. Requires authentication (call adas_auth first if not using env vars).",
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
    name: "adas_deploy_skill",
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
    name: "adas_deploy_connector",
    description: "Deploy a connector — registers in the Skill Builder catalog and connects in ADAS Core. Requires authentication.",
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
    name: "adas_list_solutions",
    description: "List all solutions deployed in the Skill Builder.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "adas_get_solution",
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
    name: "adas_update",
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
    name: "adas_redeploy",
    description:
      "Re-deploy after making updates. Regenerates MCP servers and pushes to ADAS Core. Requires authentication.",
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
    name: "adas_solution_chat",
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
  "adas_deploy_solution",
  "adas_deploy_skill",
  "adas_deploy_connector",
  "adas_update",
  "adas_redeploy",
  "adas_solution_chat",
]);

const handlers = {
  adas_auth: async ({ api_key, tenant }, sessionId) => {
    setSessionCredentials(sessionId, { tenant, apiKey: api_key });
    // Verify the key works by listing solutions
    try {
      const result = await get("/deploy/solutions", sessionId);
      return {
        ok: true,
        tenant,
        message: `Authenticated to tenant "${tenant}". ${result.solutions?.length || 0} solution(s) found.`,
      };
    } catch (err) {
      return {
        ok: false,
        tenant,
        message: `Authentication failed: ${err.message}`,
      };
    }
  },

  adas_get_spec: async ({ topic }, sid) => get(SPEC_PATHS[topic], sid),

  adas_get_workflows: async (_args, sid) => get("/spec/workflows", sid),

  adas_get_examples: async ({ type }, sid) => get(EXAMPLE_PATHS[type], sid),

  adas_validate_skill: async ({ skill }, sid) => post("/validate/skill", { skill }, sid),

  adas_validate_solution: async ({ solution, skills }, sid) =>
    post("/validate/solution", { solution, skills }, sid),

  adas_deploy_solution: async ({ solution, skills, connectors, mcp_store }, sid) =>
    post("/deploy/solution", { solution, skills, connectors, mcp_store }, sid),

  adas_deploy_skill: async ({ solution_id, skill }, sid) =>
    post(`/deploy/solutions/${solution_id}/skills`, { skill }, sid),

  adas_deploy_connector: async ({ connector }, sid) =>
    post("/deploy/connector", { connector }, sid),

  adas_list_solutions: async (_args, sid) => get("/deploy/solutions", sid),

  adas_get_solution: async ({ solution_id, view, skill_id }, sid) => {
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

  adas_update: async ({ solution_id, target, skill_id, updates }, sid) => {
    if (target === "skill") {
      return patch(`/deploy/solutions/${solution_id}/skills/${skill_id}`, { updates }, sid);
    }
    return patch(`/deploy/solutions/${solution_id}`, { state_update: updates }, sid);
  },

  adas_redeploy: async ({ solution_id, skill_id }, sid) => {
    if (skill_id) {
      return post(`/deploy/solutions/${solution_id}/skills/${skill_id}/redeploy`, {}, sid);
    }
    return post(`/deploy/solutions/${solution_id}/redeploy`, {}, sid);
  },

  adas_solution_chat: async ({ solution_id, message }, sid) =>
    post(`/deploy/solutions/${solution_id}/chat`, { message }, sid),
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
  if (toolName === "adas_get_spec" && result && typeof result === "object") {
    const keys = Object.keys(result);
    return JSON.stringify({
      _note: `ADAS spec with ${keys.length} sections. Content truncated — ask about specific sections for detail.`,
      sections: keys,
      ...result,
    }, null, 2).slice(0, MAX_RESPONSE_CHARS);
  }

  // Validation results — keep errors/warnings, trim echoed input
  if ((toolName === "adas_validate_skill" || toolName === "adas_validate_solution") && result) {
    const slim = { ...result };
    if (slim.skill) delete slim.skill;
    if (slim.solution) delete slim.solution;
    const slimJson = JSON.stringify(slim, null, 2);
    if (slimJson.length <= MAX_RESPONSE_CHARS) return slimJson;
  }

  // Export results — summarize structure
  if (toolName === "adas_get_solution" && result?.skills) {
    return JSON.stringify({
      _note: `Solution with ${result.skills.length} skill(s). Use adas_get_solution with skill_id to inspect individual skills.`,
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
        text: JSON.stringify({
          error: "Authentication required",
          message: "This operation requires authentication. Call adas_auth with your API key and tenant first.",
          hint: "Use adas_auth(api_key, tenant) to authenticate. For stdio transport (Claude Code, Cursor), you can also set ADAS_API_KEY and ADAS_TENANT environment variables.",
        }, null, 2),
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

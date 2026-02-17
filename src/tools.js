/**
 * ADAS MCP tool definitions and handlers.
 * 13 tools covering the full ADAS External Agent API.
 */

import { get, post, patch, del } from "./api.js";

// ─── Tool definitions ───────────────────────────────────────────────

export const tools = [
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
      "Deploy a complete solution to ADAS Core — identity, connectors, skills. The Skill Builder auto-generates MCP servers from tool definitions. This is the main deployment action.",
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
    description: "Deploy a single skill into an existing solution.",
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
    description: "Deploy a connector — registers in the Skill Builder catalog and connects in ADAS Core.",
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
      "Update a deployed solution or skill incrementally using PATCH. Supports dot notation for scalar fields and _push/_delete/_update for arrays.",
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
      "Re-deploy after making updates. Regenerates MCP servers and pushes to ADAS Core.",
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

const handlers = {
  adas_get_spec: async ({ topic }) => get(SPEC_PATHS[topic]),

  adas_get_workflows: async () => get("/spec/workflows"),

  adas_get_examples: async ({ type }) => get(EXAMPLE_PATHS[type]),

  adas_validate_skill: async ({ skill }) => post("/validate/skill", { skill }),

  adas_validate_solution: async ({ solution, skills }) =>
    post("/validate/solution", { solution, skills }),

  adas_deploy_solution: async ({ solution, skills, connectors, mcp_store }) =>
    post("/deploy/solution", { solution, skills, connectors, mcp_store }),

  adas_deploy_skill: async ({ solution_id, skill }) =>
    post(`/deploy/solutions/${solution_id}/skills`, { skill }),

  adas_deploy_connector: async ({ connector }) =>
    post("/deploy/connector", { connector }),

  adas_list_solutions: async () => get("/deploy/solutions"),

  adas_get_solution: async ({ solution_id, view, skill_id }) => {
    const base = `/deploy/solutions/${solution_id}`;
    if (skill_id) return get(`${base}/skills/${skill_id}`);
    const paths = {
      definition: `${base}/definition`,
      skills: `${base}/skills`,
      health: `${base}/health`,
      status: `/deploy/status/${solution_id}`,
      export: `${base}/export`,
      validate: `${base}/validate`,
      connectors_health: `${base}/connectors/health`,
    };
    return get(paths[view]);
  },

  adas_update: async ({ solution_id, target, skill_id, updates }) => {
    if (target === "skill") {
      return patch(`/deploy/solutions/${solution_id}/skills/${skill_id}`, { updates });
    }
    return patch(`/deploy/solutions/${solution_id}`, { state_update: updates });
  },

  adas_redeploy: async ({ solution_id, skill_id }) => {
    if (skill_id) {
      return post(`/deploy/solutions/${solution_id}/skills/${skill_id}/redeploy`, {});
    }
    return post(`/deploy/solutions/${solution_id}/redeploy`, {});
  },

  adas_solution_chat: async ({ solution_id, message }) =>
    post(`/deploy/solutions/${solution_id}/chat`, { message }),
};

// ─── Dispatcher ─────────────────────────────────────────────────────

export async function handleToolCall(name, args) {
  const handler = handlers[name];
  if (!handler) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }
  try {
    const result = await handler(args);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
}

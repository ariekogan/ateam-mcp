// src/exampleTypes.js
// THE ONE OWNER OF "WHICH EXAMPLES CAN AN AGENT FETCH, AND FROM WHERE".
//
// There were three lists, edited separately:
//   1. the ateam_get_examples schema enum          (tools.js)
//   2. the type → Builder route map, EXAMPLE_PATHS (tools.js)
//   3. the types named in the CLAUDE.md every tenant repo gets (agentDoc.js)
// 04c24ce made 1 and 2 agree by a test that read them out of the source; 3 was
// outside it, and still named the four types it was written with (e75feac):
// no script-cache-skill, ui-plugin-native, ui-plugin-iframe or device-tools.
// That doc is what an agent working IN the tenant's repo reads first.
//
// It lives here, not in tools.js, for the reason branchWorkflow.js does:
// tools.js imports agentDoc.js, so agentDoc.js cannot import tools.js back.
// The schema enum and the CLAUDE.md list are both derived from this map, so
// adding a type here reaches both at once.

export const EXAMPLE_PATHS = Object.freeze({
  skill: "/spec/examples/skill",
  connector: "/spec/examples/connector",
  "connector-ui": "/spec/examples/connector-ui",
  solution: "/spec/examples/solution",
  "script-cache-skill": "/spec/examples/script-cache-skill",
  "ui-plugin-native": "/spec/examples/ui-plugin-native",
  "ui-plugin-iframe": "/spec/examples/ui-plugin-iframe",
  "device-tools": "/spec/examples/device-tools",
  index: "/spec/examples",
});

/** Every type ateam_get_examples accepts, in the order it lists them. */
export const EXAMPLE_TYPES = Object.freeze(Object.keys(EXAMPLE_PATHS));

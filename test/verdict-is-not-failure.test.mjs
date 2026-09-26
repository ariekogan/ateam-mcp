// A PROBE THAT RAN AND FOUND SOMETHING HAS NOT FAILED — AND A FAILURE'S CODE
// COMES FROM THE FIELDS THAT CARRY THE FAILURE, NOT FROM THE WHOLE PAYLOAD.
//
// handleToolCall (b471cfa) flags every top-level ok:false as isError and picks
// a code with deriveErrorCode(result.message || result.error || text), where
// `text` is the ENTIRE serialized result. Two defects:
//
//   1. Verdict tools answer ok:false when the probe WORKED and found something:
//      ateam_verify (ok = "no gaps"), ateam_verify_surface (the probe's
//      negative verdict, handed back as a result on purpose by its handler),
//      ateam_connector_logs (Core: ok:false for a connector with no stdio
//      process, "Not a fault"). Each came back isError:true — a broken call.
//
//   2. With neither message nor error, AUTH_SIGNAL_RX (which matches a bare
//      "401") ran over every byte of the result: a verify gap quoting
//      "per-actor calls 401", a probe's visible_text, any number 401 in the
//      data → UNAUTHENTICATED, the one code that sends ateam-proxy-mcp to sign
//      the tenant in again (Core connectors/ateam-proxy-mcp/upstreamAuthFailure.js).
//
// And ateam_verify_consistency, which the finding named first: its drift was
// never ok:false on the wire — the Builder's /verify answers ok:true and puts
// the verdict in `consistent` (since 9e51bef). What was wrong is the contract
// this MCP ADVERTISED ("ok: false + drifts"), in the second of two definitions
// of the tool. See tool-registry.test.mjs.
//
// Behavioural: the real dispatcher, against a local server playing the Builder.
// Run: node --test test/verdict-is-not-failure.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setSessionCredentials } from "../src/api.js";
import { handleToolCall } from "../src/tools.js";

const SID = "sess-verdict-is-not-failure";
let routes = {};
let server;

before(async () => {
  server = createServer((req, res) => {
    const key = `${req.method} ${req.url.split("?")[0]}`;
    const reply = routes[key];
    res.writeHead(reply?.status || (reply ? 200 : 404), { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply ? reply.body : { error: "no route" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  setSessionCredentials(SID, {
    apiKey: "adas_tenanta_00000000000000000000000000000000",
    apiUrl: `http://127.0.0.1:${server.address().port}`,
    explicit: true,
  });
});
after(() => server.close());

async function call(tool, args, r) {
  routes = r;
  const res = await handleToolCall(tool, { solution_id: "sol", ...args }, SID);
  return { res, out: JSON.parse(res.content[0].text) };
}

// ─── 1. verdict tools ────────────────────────────────────────────────────────

// A solution whose connector is connected, lists tools, and 401s per actor —
// the OPEN-30 case ateam_verify exists to catch. The probe WORKED.
const VERIFY_FOUND_A_GAP = {
  "GET /deploy/solutions/sol/connectors/health": { body: { connectors: [{ id: "clinic-mcp", status: "connected", tools: 3, auth_error: "HTTP 401 from storage" }] } },
  "GET /deploy/solutions/sol/definition": { body: { solution: {} } },
  "GET /deploy/solutions/sol/ui-plugins": { body: { plugins: [] } },
  "GET /deploy/solutions/sol/health": { body: { skills: [{ skill_id: "k", ok: true }] } },
  "GET /deploy/solutions/sol/skills/k": { body: { skill: { tools: [{ name: "clinic.list_visits", source: { connector: "clinic-mcp" } }] } } },
  "POST /deploy/solutions/sol/connectors/clinic-mcp/call": { body: { ok: false, error: "HTTP 401 Unauthorized" } },
};

test("ateam_verify: a verification that FOUND GAPS is an answer, not a broken call", async () => {
  const { res, out } = await call("ateam_verify", {}, VERIFY_FOUND_A_GAP);
  assert.equal(out.ok, false, "(control) the probe must actually have found the gap");
  assert.ok(out.gaps.some((g) => /per-actor calls 401/.test(g)), "(control) the gap quotes a 401");
  assert.notEqual(res.isError, true, "a verify that ran and found gaps was reported as a FAILED CALL");
  assert.equal(res.structuredContent, undefined);
});

test("ateam_verify_surface: the probe's negative verdict is an answer, not a broken call", async () => {
  const { res, out } = await call("ateam_verify_surface", { plugin_id: "mcp:clinic-mcp:visits" }, {
    "POST /deploy/solutions/sol/plugins/mcp%3Aclinic-mcp%3Avisits/verify-surface": {
      status: 422,
      body: {
        ok: false, verdict: "surface_failed", plugin_id: "mcp:clinic-mcp:visits",
        visible_text: "Error 401 — could not load visits", calls: [{ tool: "clinic.list_visits", ok: false, error: "401", ms: 12 }],
        failures: ["surface_probe: every data call failed"],
      },
    },
  });
  assert.equal(out.verdict, "surface_failed", "(control) the verdict must reach the caller");
  assert.notEqual(res.isError, true, "a surface probe that ran and said 'broken' was reported as a FAILED CALL");
});

test("ateam_verify_surface: its OWN refusal is still a failure", async () => {
  const { res } = await call("ateam_verify_surface", { plugin_id: undefined }, {});
  assert.equal(res.isError, true);
  assert.equal(res.structuredContent?.code, "TOOL_FAILED");
});

test("ateam_connector_logs: 'no stdio process' is an answer (Core: 'Not a fault')", async () => {
  const { res, out } = await call("ateam_connector_logs", { connector_id: "gmail-mcp" }, {
    "GET /deploy/solutions/sol/connectors/gmail-mcp/logs": {
      body: { ok: false, connector_id: "gmail-mcp", status: "connected", lines: [], reason: "no stdio process",
        hint: "Only stdio (solution) connectors stream stderr through Core. Platform/HTTP connectors log in their own container." },
    },
  });
  assert.equal(out.reason, "no stdio process");
  assert.notEqual(res.isError, true, "a legitimate 'no logs here' answer was reported as a FAILED CALL");
});

test("ateam_verify_consistency: drift is consistent:false with ok:true — never an error", async () => {
  const { res, out } = await call("ateam_verify_consistency", {}, {
    "GET /deploy/solutions/sol/verify": { body: { ok: true, solution_id: "sol", mode: "warn", consistent: false, drifts: [{ path: "skills/k/skill.json", kind: "content_differs" }] } },
  });
  assert.equal(out.consistent, false);
  assert.notEqual(res.isError, true);
});

// ─── 2. the code comes from the failure's own fields ─────────────────────────

test("a failure with no message/error is TOOL_FAILED, whatever numbers its data holds", async () => {
  // A promote refused for divergence, answered 200 with only structured fields.
  // "behind_by": 401 is data. It is not an authentication failure.
  const { res } = await call("ateam_github_promote", {}, {
    "POST /deploy/solutions/sol/promote": { body: { ok: false, merged: false, status: "diverged", behind_by: 401, ahead_by: 2 } },
  });
  assert.equal(res.isError, true, "(control) a non-verdict ok:false is still a failure");
  assert.equal(res.structuredContent?.code, "TOOL_FAILED",
    "the auth regex ran over the whole payload and called a divergence UNAUTHENTICATED");
});

test("(control) a failure whose error says 401 is still UNAUTHENTICATED", async () => {
  const { res } = await call("ateam_github_promote", {}, {
    "POST /deploy/solutions/sol/promote": { body: { ok: false, merged: true, error: "merged dev→main, but pushing the tag failed: GitHub 401 Bad credentials" } },
  });
  assert.equal(res.isError, true);
  assert.equal(res.structuredContent?.code, "UNAUTHENTICATED");
});

test("(control) an explicit code still wins", async () => {
  const { res } = await call("ateam_github_promote", {}, {
    "POST /deploy/solutions/sol/promote": { body: { ok: false, code: "MAIN_BEHIND_DEV", error: "401 things happened" } },
  });
  assert.equal(res.structuredContent?.code, "MAIN_BEHIND_DEV");
});

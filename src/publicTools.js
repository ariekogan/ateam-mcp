/**
 * THE TOOLS A SESSION MAY CALL WITHOUT SIGNING IN TO A WORKSPACE — the ONE
 * list. Every other tool is workspace-scoped: the auth gate in tools.js
 * (handleToolCall) refuses it until the session signs in. Deny by default.
 *
 * WHY THE GATE DENIES BY DEFAULT NOW. eb5e007 (2026-03-01) gated an allow-list of
 * tenant tools, TENANT_TOOLS, and every tool added after it had to be put on
 * that list by hand. Fifteen were not, among them ateam_github_promote
 * (f481f70), ateam_github_write (261597f), ateam_test_connector (179ecf1),
 * ateam_write_agent_doc (e75feac), ateam_create_connector and the
 * show_*_minimal tools (ae85a46, ec47af9), ateam_verify (95492b6) and
 * ateam_design_advisor (5f539fa). They ran on the ADAS_API_KEY environment
 * fallback that the gate exists to refuse: a signed-out stdio session could
 * promote, roll back and write a workspace's repo. Now a new tool is gated
 * unless it is added HERE, with its reason.
 *
 * A leaf module: tools.js reads it for the gate, signInSteps.js for the texts
 * that name the tools needing no sign-in, so the two cannot disagree.
 */
export const PUBLIC_TOOLS = new Set([
  // The onboarding narrative. Its workspace part (tenant_onboarding, the
  // solutions this key sees) is added only for a signed-in session.
  "ateam_bootstrap",
  // Signing in itself.
  "ateam_auth",
  // The docs: /spec/*, the examples and the workflows are served to anyone, and
  // /spec/search needs no key, tenant or LLM (MGAP-A3).
  "ateam_get_spec",
  "ateam_get_examples",
  "ateam_get_workflows",
  "ateam_spec_search",
  // Static validation: the validator lets /validate/* through as a check with
  // no tenant (its apiKeyAuth), and the payload is the caller's own JSON.
  "ateam_validate_skill",
  "ateam_validate_solution",
]);

/** The sentence every text that names them renders. */
export const NO_SIGN_IN_NEEDED = `These need no sign-in: ${[...PUBLIC_TOOLS].join(", ")}.`;

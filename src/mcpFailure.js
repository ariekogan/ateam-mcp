// src/mcpFailure.js
//
// Failure classification for the MCP tool dispatcher (used by handleToolCall in
// tools.js). A tool call can succeed at the TRANSPORT layer (MCP returns a
// result) while FAILING logically — the classic case being an upstream that
// answers HTTP 200 with "Authentication required" sitting in the body. MCP's
// `isError` and a machine-readable `code` are exactly for that gap: they let a
// caller (e.g. the ateam-proxy connector) ask "did this actually work?" WITHOUT
// parsing English.
//
// The human sentence STAYS in the result's content[].text — the reasoning loop
// reads it to decide what to do next — we only ADD `isError` +
// `structuredContent.code` alongside it. Never strip the prose.
//
//   node --test src/mcpFailure.test.js

// This is the ONE boundary where recognizing the auth phrase from text is
// correct: we translate the upstream lie into a structured code exactly once,
// here, so nothing downstream ever has to.
export const AUTH_SIGNAL_RX = /\b(unauthenticated|authentication required|authentication failed|not authenticated|no api_key in session|call ateam_auth|master key required|invalid api key|expired token|401)\b/i;

/**
 * Map a failure to a machine-readable code. An explicit code (set by a handler
 * or carried on a thrown error) always wins; otherwise recognize the auth
 * signal at this single boundary; otherwise a generic TOOL_FAILED.
 * @param {string|object} source  the message/result the failure came with
 * @param {string} [explicit]     a code the handler/error already set
 * @returns {string}
 */
export function deriveErrorCode(source, explicit) {
  if (explicit && typeof explicit === "string") return explicit;
  const s = typeof source === "string"
    ? source
    : (() => { try { return JSON.stringify(source || ""); } catch { return String(source); } })();
  if (AUTH_SIGNAL_RX.test(s)) return "UNAUTHENTICATED";
  return "TOOL_FAILED";
}

/**
 * A top-level object result with ok:false is a logical failure. Nested *.ok
 * (widget_health.ok / validation.valid) are their own advisory signals and do
 * NOT flip the tool to error — only the tool's OWN primary `ok` does.
 * @param {any} result
 * @returns {boolean}
 */
export function isLogicalFailure(result) {
  return Boolean(result) && typeof result === "object" && !Array.isArray(result) && result.ok === false;
}

// src/mcpFailure.test.js
//
// Proves the dispatcher's failure-classification rule: a logically-failed tool
// result (returned ok:false, or an upstream 200-with-auth-text) is recognized
// structurally and mapped to a machine-readable code — so the ateam-proxy never
// has to read English to know a call failed. Tests the REAL exported functions.
//   node --test src/mcpFailure.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveErrorCode, isLogicalFailure, AUTH_SIGNAL_RX } from "./mcpFailure.js";

test("auth phrases → UNAUTHENTICATED (the upstream 200-with-auth-text lie)", () => {
  for (const s of [
    "Authentication required — call ateam_auth first.",
    "No api_key in session — call ateam_auth(api_key) first.",
    "Master key required. Call ateam_auth(master_key) first.",
    "Authentication failed: bad key",
    "upstream said 401 Unauthorized",
    "invalid API key",
  ]) {
    assert.equal(deriveErrorCode(s), "UNAUTHENTICATED", `expected UNAUTHENTICATED for: ${s}`);
  }
});

test("non-auth failure → TOOL_FAILED", () => {
  assert.equal(deriveErrorCode("could not read solution definition"), "TOOL_FAILED");
  assert.equal(deriveErrorCode("redeploy timed out"), "TOOL_FAILED");
});

test("an explicit handler/error code always wins over text sniffing", () => {
  // Even auth-looking text must not override a code the handler already set.
  assert.equal(deriveErrorCode("Authentication required", "RATE_LIMITED"), "RATE_LIMITED");
  assert.equal(deriveErrorCode("boom", "MISSING_SOLUTION"), "MISSING_SOLUTION");
});

test("object sources are stringified before matching (not just plain strings)", () => {
  assert.equal(deriveErrorCode({ ok: false, message: "Authentication required" }), "UNAUTHENTICATED");
  assert.equal(deriveErrorCode({ ok: false, error: "disk full" }), "TOOL_FAILED");
});

test("nullish / weird sources never throw, fall back to TOOL_FAILED", () => {
  assert.equal(deriveErrorCode(null), "TOOL_FAILED");
  assert.equal(deriveErrorCode(undefined), "TOOL_FAILED");
});

test("top-level ok:false is a logical failure; ok:true / missing / nested are not", () => {
  assert.equal(isLogicalFailure({ ok: false, message: "x" }), true);
  assert.equal(isLogicalFailure({ ok: true }), false);
  assert.equal(isLogicalFailure({}), false);
  // Nested advisory signals must NOT flip the tool to error (patch succeeded,
  // widget just isn't rendering / def isn't valid yet).
  assert.equal(isLogicalFailure({ ok: true, widget_health: { ok: false } }), false);
  assert.equal(isLogicalFailure({ ok: true, validation: { valid: false } }), false);
  // Arrays / primitives / null are never a logical failure.
  assert.equal(isLogicalFailure([{ ok: false }]), false);
  assert.equal(isLogicalFailure(null), false);
  assert.equal(isLogicalFailure("ok:false"), false);
});

test("AUTH_SIGNAL_RX is exported for reuse and is case-insensitive", () => {
  assert.ok(AUTH_SIGNAL_RX.test("AUTHENTICATION REQUIRED"));
  assert.ok(!AUTH_SIGNAL_RX.test("everything is fine"));
});

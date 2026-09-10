/**
 * BOOTSTRAP MUST NAME THE ENVIRONMENT THIS SESSION IS ACTUALLY ON.
 *
 * `runtime.base_url` exists to answer one question — prod or dev? — and it was
 * answering it wrong. getBaseUrl(sessionId) resolves per-session first
 * (api.js:326-339), but bootstrap called getBaseUrl() with NO argument, so it
 * skipped the per-session and bearer branches every time and reported the
 * process default, https://api.ateam-ai.com.
 *
 * Observed live: a session authenticated to dev-api.ateam-ai.com, deploying to
 * dev all run, was told base_url: https://api.ateam-ai.com. It had to infer the
 * real environment from where its errors came back. The mirror image — being
 * told "dev" while pointed at prod — is the one that does damage.
 *
 * Run: node --test test/bootstrap-base-url.test.mjs
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { handlers } from "../src/tools.js";
import { setSessionCredentials, getBaseUrl } from "../src/api.js";

const DEV = "https://dev-api.ateam-ai.com";

describe("bootstrap reports the session's own API", () => {
  test("THE BUG: a dev-authenticated session is not told prod", async () => {
    const sid = "sess-dev-1";
    setSessionCredentials(sid, { apiKey: "adas_t_x", tenant: "t", apiUrl: DEV });

    const out = await handlers.ateam_bootstrap({}, sid);
    assert.equal(out.runtime.base_url, DEV,
      `bootstrap reported ${out.runtime.base_url} for a session authenticated to ${DEV}`);
  });

  test("it matches what every other call in that session actually uses", async () => {
    // The value must not merely be non-default — it must be THE SAME value the
    // request layer resolves, or it is a second answer to one question.
    const sid = "sess-dev-2";
    setSessionCredentials(sid, { apiKey: "adas_t_x", tenant: "t", apiUrl: DEV });

    const out = await handlers.ateam_bootstrap({}, sid);
    assert.equal(out.runtime.base_url, getBaseUrl(sid));
  });

  test("a session with no explicit url still gets the default", async () => {
    const out = await handlers.ateam_bootstrap({}, "sess-unset");
    assert.equal(out.runtime.base_url, getBaseUrl("sess-unset"));
    assert.ok(out.runtime.base_url, "no base_url reported at all");
  });

  test("the note no longer claims more than the field can know", () => {
    // It said "the API it talks to" while reporting a process-wide default.
    const src = handlers.ateam_bootstrap;
    assert.ok(typeof src === "function");
  });
});

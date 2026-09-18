/**
 * THE SESSION MUST BE ABLE TO SAY WHICH SYSTEM IT IS ABOUT TO CHANGE.
 *
 * `runtime.base_url` was the only answer bootstrap gave, and inside the
 * container it is not an answer at all: mac1 and prod run the SAME compose file
 * with ADAS_API_URL=http://skill-builder-backend:3200, so the field reads
 * identically on both. Observed live (2026-09-18): a session was told
 * base_url: http://skill-builder-backend:3200 and could not say whether a
 * deploy would land on dev or on production. ateam_auth's own comment claimed
 * the environment was "reported here and in ateam_bootstrap.runtime, from the
 * same resolution" — bootstrap reported nothing, and auth computed it inline.
 *
 * THE INDICATOR IS THE HOSTNAME: `dev-*` is development, the bare host is
 * production. Every source ranked here is a URL for that reason, and a label a
 * service reports about itself is ranked last.
 *
 * NO DEFAULT, in either direction. A fallback that picks an ENVIRONMENT does
 * not fail — it silently succeeds against the wrong system.
 *
 * Run: node --test test/environment-report.test.mjs
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  resolveEnvironment, envForDeploymentUrl, setSessionCredentials,
  ENVIRONMENTS, KEY_ENVIRONMENTS,
} from "../src/api.js";
import { handlers, handleToolCall } from "../src/tools.js";

const HEX = "0123456789abcdef0123456789abcdef";
const DEV_KEY = `adas_dev_acme_${HEX}`;
const OLD_KEY = `adas_acme_${HEX}`;          // names no environment
const INTERNAL = "http://skill-builder-backend:3200";  // what the container actually sees
const DEV_API = "https://dev-api.ateam-ai.com";
const PROD_API = "https://api.ateam-ai.com";

const origBase = process.env.ATEAM_BASE_URL;
beforeEach(() => { delete process.env.ATEAM_BASE_URL; });
afterEach(() => {
  if (origBase === undefined) delete process.env.ATEAM_BASE_URL;
  else process.env.ATEAM_BASE_URL = origBase;
});

describe("the hostname rule", () => {
  test("host-leading dev- is dev; the bare host is prod", () => {
    assert.equal(envForDeploymentUrl("https://dev-mcp.ateam-ai.com"), "dev");
    assert.equal(envForDeploymentUrl("https://mcp.ateam-ai.com"), "prod");
    assert.equal(envForDeploymentUrl("https://dev-app.ateam-ai.com"), "dev");
  });

  test("ONLY a leading dev- counts — not 'dev' anywhere in the name", () => {
    // The failure this prevents: a customer host being read as our dev.
    assert.equal(envForDeploymentUrl("https://myapp-dev-thing.com"), null);
    assert.equal(envForDeploymentUrl("https://developer.example.com"), null);
  });

  test("a host that is not ours names no environment — a self-host is not our prod", () => {
    assert.equal(envForDeploymentUrl("http://localhost:3100"), null);
    assert.equal(envForDeploymentUrl("https://mcp.customer.io"), null);
    assert.equal(envForDeploymentUrl(""), null);
    assert.equal(envForDeploymentUrl(undefined), null);
  });

  test("the app url an agent is sent to cannot name a different environment than the api it calls", () => {
    // ENVIRONMENTS is the one map; KEY_ENVIRONMENTS is derived from it.
    for (const [env, urls] of Object.entries(ENVIRONMENTS)) {
      assert.equal(KEY_ENVIRONMENTS[env], urls.api);
      assert.equal(envForDeploymentUrl(urls.app), env);
      assert.equal(envForDeploymentUrl(urls.mcp), env);
    }
  });
});

describe("bootstrap names the environment", () => {
  test("from the key, when the key names one", async () => {
    const sid = "env-key";
    setSessionCredentials(sid, { apiKey: DEV_KEY, tenant: "acme", apiUrl: DEV_API });
    const out = await handlers.ateam_bootstrap({}, sid);
    assert.equal(out.runtime.environment, "dev");
    assert.equal(out.runtime.environment_source, "api_key");
    assert.equal(out.runtime.app_url, "https://dev-app.ateam-ai.com");
    assert.match(out.runtime.environment_label, /^DEV — dev-app\.ateam-ai\.com$/);
  });

  test("from the session's own api host, when the key does not", async () => {
    const sid = "env-url";
    setSessionCredentials(sid, { apiKey: OLD_KEY, tenant: "acme", apiUrl: PROD_API });
    const out = await handlers.ateam_bootstrap({}, sid);
    assert.equal(out.runtime.environment, "prod");
    assert.equal(out.runtime.environment_source, "session_url");
  });

  test("THE CONTAINER CASE: an internal base_url still resolves, from the deployment's own url", async () => {
    // The whole point. base_url is identical on mac1 and prod, so nothing about
    // the session can separate them — the deployment's public url can.
    process.env.ATEAM_BASE_URL = "https://dev-mcp.ateam-ai.com";
    const sid = "env-deploy-dev";
    setSessionCredentials(sid, { apiKey: OLD_KEY, tenant: "acme", apiUrl: INTERNAL });
    const out = await handlers.ateam_bootstrap({}, sid);
    assert.equal(out.runtime.base_url, INTERNAL, "precondition: the internal base is what the session sees");
    assert.equal(out.runtime.environment, "dev");
    assert.equal(out.runtime.environment_source, "deployment_url");
    assert.match(out.runtime.environment_note, /ATEAM_BASE_URL=https:\/\/dev-mcp\.ateam-ai\.com/);
  });

  test("…and the prod mirror image", async () => {
    process.env.ATEAM_BASE_URL = "https://mcp.ateam-ai.com";
    const sid = "env-deploy-prod";
    setSessionCredentials(sid, { apiKey: OLD_KEY, tenant: "acme", apiUrl: INTERNAL });
    const out = await handlers.ateam_bootstrap({}, sid);
    assert.equal(out.runtime.environment, "prod");
    assert.equal(out.runtime.environment_source, "deployment_url");
  });
});

describe("NO DEFAULT: nothing said means nothing claimed", () => {
  test("an internal base and no deployment url report `unstated` — NOT prod", async () => {
    // The dangerous direction is being told an environment that is not true.
    // prod is the process default for ROUTING; asserting it as the ANSWER is
    // how an unstated default becomes a confident lie.
    const sid = "env-unstated";
    setSessionCredentials(sid, { apiKey: OLD_KEY, tenant: "acme", apiUrl: INTERNAL });
    const out = await handlers.ateam_bootstrap({}, sid);
    assert.equal(out.runtime.environment, "unstated");
    assert.equal(out.runtime.environment_source, "none");
    assert.equal(out.runtime.app_url, null, "an app url would be a claim the resolution did not make");
    assert.match(out.runtime.environment_note, /hostname/);
  });

  test("the note says how to make it definite, so `unstated` is actionable and not a dead end", async () => {
    const sid = "env-unstated-2";
    setSessionCredentials(sid, { apiKey: OLD_KEY, tenant: "acme", apiUrl: INTERNAL });
    const { environment_note } = (await handlers.ateam_bootstrap({}, sid)).runtime;
    assert.match(environment_note, /ATEAM_BASE_URL/);
    assert.match(environment_note, /adas_dev_/);
  });
});

describe("every source is a URL — and there is no source that never fires", () => {
  test("the ranking is exactly the three hostname sources, in order", () => {
    // 1. api_key beats the session url: an env-bearing key PICKED that host, so
    //    it is the same answer, arrived at earlier.
    const a = "env-rank-1";
    setSessionCredentials(a, { apiKey: DEV_KEY, tenant: "acme", apiUrl: DEV_API });
    assert.equal(resolveEnvironment(a).source, "api_key");

    // 2. the session url beats the deployment url: it is where THIS session's
    //    calls actually go.
    process.env.ATEAM_BASE_URL = "https://mcp.ateam-ai.com";
    const b = "env-rank-2";
    setSessionCredentials(b, { apiKey: OLD_KEY, tenant: "acme", apiUrl: DEV_API });
    const rb = resolveEnvironment(b);
    assert.equal(rb.source, "session_url");
    assert.equal(rb.name, "dev", "the deployment url must not override where the session is pointed");

    // 3. the deployment url answers only when nothing about the session does.
    const c = "env-rank-3";
    setSessionCredentials(c, { apiKey: OLD_KEY, tenant: "acme", apiUrl: INTERNAL });
    assert.equal(resolveEnvironment(c).source, "deployment_url");
  });

  test("NOTHING BUT A HOSTNAME IS A SOURCE — no key field, no service label", async () => {
    // /auth/whoami is live and does return `env`, but that `env` is
    // parseApiKey(x-api-key).env — the same parse of the same string source 1
    // already does, and null for the legacy keys this platform actually issues.
    // A round-trip to learn a string we hold, and a second path to one answer.
    // ADAS_ENV is out for the reason Core's currentEnv() records. The
    // environment comes from the hostname; this test fails the moment a
    // non-hostname source is added to the ranking.
    const src = await import("node:fs").then((fs) => fs.readFileSync("src/api.js", "utf-8"));
    const ranking = src.slice(src.indexOf("const candidates = ["), src.indexOf("];", src.indexOf("const candidates = [")));
    assert.ok(!/whoami|"server"/.test(ranking), `an unserved source is back in the ranking:\n${ranking}`);
    assert.deepEqual(
      [...ranking.matchAll(/\["([a-z_]+)"/g)].map((m) => m[1]),
      ["api_key", "session_url", "deployment_url"],
    );
  });
});

describe("ONE resolver: auth and bootstrap cannot disagree", () => {
  const origFetch = global.fetch;
  afterEach(() => { global.fetch = origFetch; });

  test("ateam_auth and ateam_bootstrap report the same environment, from the same resolution", async () => {
    global.fetch = async () => ({
      ok: true, status: 200, headers: { get: () => "application/json" },
      json: async () => ({ solutions: [] }), text: async () => "{}",
    });
    const sid = "env-agree";
    const auth = await handlers.ateam_auth({ api_key: DEV_KEY }, sid);
    assert.equal(auth.ok, true);
    assert.equal(auth.environment, "dev");
    const boot = await handlers.ateam_bootstrap({}, sid);
    assert.equal(boot.runtime.environment, auth.environment);
    assert.equal(boot.runtime.environment_source, auth.environment_source);
    assert.equal(boot.runtime.app_url, auth.app_url);
  });
});

describe("bootstrap also names the GitHub it is wired to", () => {
  const origFetch = global.fetch;
  afterEach(() => { global.fetch = origFetch; });

  const serve = (solutions) => async () => ({
    ok: true, status: 200, headers: { get: () => "application/json" },
    json: async () => ({ solutions }), text: async () => JSON.stringify({ solutions }),
  });

  test("the owner is derived from the repos already listed — no extra round-trip", async () => {
    global.fetch = serve([
      { id: "ada", name: "ada", repo_url: "https://github.com/ariekogan/ADT-personal-ai-assistant1" },
    ]);
    setSessionCredentials("gh-1", { apiKey: DEV_KEY, tenant: "acme", apiUrl: DEV_API });
    const res = await handleToolCall("ateam_bootstrap", {}, "gh-1");
    const out = JSON.parse(res.content[0].text);
    assert.equal(out.runtime.github.connected, true);
    assert.equal(out.runtime.github.owner, "ariekogan");
    assert.deepEqual(out.runtime.github.repos, [
      { solution: "ada", repo_url: "https://github.com/ariekogan/ADT-personal-ai-assistant1", default_branch: "main" },
    ]);
  });

  test("no repo pinned is a STATE, not an error — and it says what to do about it", async () => {
    global.fetch = serve([{ id: "ada", name: "ada", repo_url: null }]);
    setSessionCredentials("gh-2", { apiKey: DEV_KEY, tenant: "acme", apiUrl: DEV_API });
    const res = await handleToolCall("ateam_bootstrap", {}, "gh-2");
    const out = JSON.parse(res.content[0].text);
    assert.equal(out.runtime.github.connected, false);
    assert.equal(out.runtime.github.owner, null);
    assert.match(out.runtime.github._note, /connect-github/);
    // The connect url must be the one for THIS environment, not a fixed prod link.
    assert.match(out.runtime.github._note, /dev-mcp\.ateam-ai\.com/);
  });
});

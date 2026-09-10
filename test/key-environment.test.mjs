/**
 * THE KEY NAMES ITS ENVIRONMENT.
 *
 * One public MCP endpoint, and nothing about a session said which environment it
 * was on: the caller passed `url`, or silently got the prod default. A dev key
 * at the prod base is just a 401 — diagnosed after the fact by a hint, never
 * prevented. Observed live: a session working entirely against dev-api was told
 * base_url https://api.ateam-ai.com and had to infer its real environment from
 * where errors came back. The mirror image is the one that does damage.
 *
 * The process starts at the key, so the key carries the environment:
 *   adas_<env>_<tenant>_<32hex>,  env ∈ prod|dev
 *
 * NO FALLBACK, in either direction. That is the whole safety argument: a
 * fallback that picks an ENVIRONMENT does not fail, it silently succeeds
 * against the wrong system.
 *
 * Run: node --test test/key-environment.test.mjs
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseApiKey, baseUrlForKeyEnv, envForBaseUrl, getBaseUrl, KEY_ENVIRONMENTS } from "../src/api.js";
import { handlers } from "../src/tools.js";

const HEX = "0123456789abcdef0123456789abcdef";
const DEV_KEY = `adas_dev_acme_${HEX}`;
const PROD_KEY = `adas_prod_acme_${HEX}`;
const OLD_KEY = `adas_acme_${HEX}`;
const PROD = "https://api.ateam-ai.com";
const DEV = "https://dev-api.ateam-ai.com";

describe("parsing: the env form is additive and cannot collide", () => {
  test("adas_dev_<tenant>_<hex> yields env and tenant", () => {
    assert.deepEqual(parseApiKey(DEV_KEY), { env: "dev", tenant: "acme", isValid: true });
  });

  test("adas_prod_… likewise", () => {
    assert.equal(parseApiKey(PROD_KEY).env, "prod");
  });

  test("the OLDER form still parses, and its env is null — NOT prod", () => {
    // null means "this key does not say". Defaulting it to prod is exactly the
    // assumption that would relabel every existing dev key as production.
    assert.deepEqual(parseApiKey(OLD_KEY), { env: null, tenant: "acme", isValid: true });
  });

  test("the two forms cannot collide — the tenant charset has no underscore", () => {
    // This is what makes acceptance additive rather than breaking.
    assert.equal(parseApiKey(DEV_KEY).tenant, "acme");
    assert.notEqual(parseApiKey(DEV_KEY).tenant, "dev_acme");
  });

  test("A TYPO IS AN ERROR, NOT A NEW ENVIRONMENT", () => {
    // The closed set is the point: with an open [a-z]+ segment, `prd` would
    // become a valid environment nobody can route to.
    const typo = parseApiKey(`adas_prd_acme_${HEX}`);
    assert.equal(typo.env, null);
    assert.equal(typo.tenant, null, "`prd_acme` was accepted as a tenant name");
    assert.equal(typo.isValid, false);
  });

  test("the environment set is closed and frozen", () => {
    assert.deepEqual(Object.keys(KEY_ENVIRONMENTS).sort(), ["dev", "prod"]);
    assert.ok(Object.isFrozen(KEY_ENVIRONMENTS));
  });
});

describe("routing: the key picks the host", () => {
  test("dev key -> dev-api, prod key -> api", () => {
    assert.equal(baseUrlForKeyEnv(DEV_KEY), DEV);
    assert.equal(baseUrlForKeyEnv(PROD_KEY), PROD);
  });

  test("a key that names no environment routes nowhere on its own", () => {
    assert.equal(baseUrlForKeyEnv(OLD_KEY), null);
  });

  test("only the KNOWN hosts are recognised, so localhost still works", () => {
    assert.equal(envForBaseUrl(PROD), "prod");
    assert.equal(envForBaseUrl(DEV), "dev");
    assert.equal(envForBaseUrl("http://localhost:4000"), null);
  });
});

describe("auth: a contradiction is REFUSED, before any network call", () => {
  const origFetch = global.fetch;

  test("dev key + prod url -> refused, naming both, with ZERO requests made", async () => {
    let calls = 0;
    global.fetch = async () => { calls++; throw new Error("must not be called"); };
    try {
      const out = await handlers.ateam_auth({ api_key: DEV_KEY, url: PROD }, "s1");
      assert.equal(out.ok, false);
      assert.match(out.message, /"dev"/);
      assert.match(out.message, /"prod"/);
      assert.equal(calls, 0, "it contacted a backend before refusing — the refusal must be local");
    } finally { global.fetch = origFetch; }
  });

  test("prod key + dev url -> refused symmetrically", async () => {
    global.fetch = async () => { throw new Error("must not be called"); };
    try {
      const out = await handlers.ateam_auth({ api_key: PROD_KEY, url: DEV }, "s2");
      assert.equal(out.ok, false);
    } finally { global.fetch = origFetch; }
  });

  test("an UNKNOWN url is still allowed — the override keeps working", async () => {
    // Refusal applies to crossing prod/dev, not to using a staging box.
    let seen = null;
    global.fetch = async (u) => {
      seen = String(u);
      return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ solutions: [] }), text: async () => "{}" };
    };
    try {
      const out = await handlers.ateam_auth({ api_key: DEV_KEY, url: "http://localhost:4000" }, "s3");
      assert.equal(out.ok, true);
      assert.match(seen, /^http:\/\/localhost:4000/);
    } finally { global.fetch = origFetch; }
  });

  test("NO SIBLING RETRY: a key rejected by its own environment is not retried elsewhere", async () => {
    // The rule the whole design rests on. A second request to the other host
    // would mean a dev key could succeed against production.
    const hosts = [];
    global.fetch = async (u) => {
      hosts.push(new URL(String(u)).origin);
      return { ok: false, status: 401, headers: { get: () => "application/json" }, json: async () => ({ error: "Invalid" }), text: async () => '{"error":"Invalid"}' };
    };
    try {
      await handlers.ateam_auth({ api_key: DEV_KEY }, "s4");
      assert.deepEqual([...new Set(hosts)], [DEV], `it contacted more than the key's own environment: ${JSON.stringify(hosts)}`);
    } finally { global.fetch = origFetch; }
  });
});

describe("the session reports one environment, everywhere", () => {
  const origFetch = global.fetch;

  test("auth and bootstrap agree, from the same resolution", async () => {
    global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ solutions: [] }), text: async () => "{}" });
    try {
      const sid = "s5";
      const auth = await handlers.ateam_auth({ api_key: DEV_KEY }, sid);
      assert.equal(auth.ok, true);
      assert.equal(auth.environment, "dev");
      assert.equal(auth.base_url, DEV);

      const boot = await handlers.ateam_bootstrap({}, sid);
      assert.equal(boot.runtime.base_url, auth.base_url,
        "bootstrap and auth disagree about which API this session talks to");
      assert.equal(boot.runtime.base_url, getBaseUrl(sid));
    } finally { global.fetch = origFetch; }
  });
});

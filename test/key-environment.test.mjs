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
// A real sealed key Core minted on mac1 dev. Kept verbatim so these tests pin
// the ACTUAL format, not my reading of a description of it. Note the `_` inside
// the blob — base64url overlaps the separator, which is why order matters.
const SEALED_KEY = "adas_dev_AdEqxaD9XtOmWBHbIqt0yFC0o3qDz-uPte_SUUni1VZoCHnLQElOQ-hFvnz1oL8";
const PROD = "https://api.ateam-ai.com";
const DEV = "https://dev-api.ateam-ai.com";

describe("parsing: the env form is additive and cannot collide", () => {
  test("adas_dev_<tenant>_<hex> yields env and tenant", () => {
    assert.deepEqual(parseApiKey(DEV_KEY), { env: "dev", tenant: "acme", sealed: false, isValid: true });
  });

  test("adas_prod_… likewise", () => {
    assert.equal(parseApiKey(PROD_KEY).env, "prod");
  });

  test("the OLDER form still parses, and its env is null — NOT prod", () => {
    // null means "this key does not say". Defaulting it to prod is exactly the
    // assumption that would relabel every existing dev key as production.
    assert.deepEqual(parseApiKey(OLD_KEY), { env: null, tenant: "acme", sealed: false, isValid: true });
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

/**
 * THE TENANT IS NO LONGER IN THE STRING.
 *
 * `adas_<env>_<tenant>_<hex>` put the customer's name inside the credential, so
 * it travelled wherever the key travelled — logs, screenshots, support tickets,
 * a pasted config. Core now seals it: `adas_<env>_<blob>`, where the blob is
 * base64url of [version][nonce][AES-256-GCM(tenant)][tag][secret]. The last 16
 * bytes are the secret IN THE CLEAR; the sealing key protects routing only.
 *
 * This package must never decode it — it installs from npm onto developer
 * laptops, so a decoder here would be the sealing secret shipping with it. The
 * tenant is ASKED for, once, via /auth/whoami.
 */
describe("sealed keys: the tenant is asked for, never guessed", () => {
  const origFetch = global.fetch;
  const whoamiOk = (tenant) => ({
    ok: true, status: 200, headers: { get: () => "application/json" },
    json: async () => ({ ok: true, tenant, env: "dev" }),
    text: async () => JSON.stringify({ ok: true, tenant, env: "dev" }),
  });
  const solutionsOk = {
    ok: true, status: 200, headers: { get: () => "application/json" },
    json: async () => ({ solutions: [] }), text: async () => "{}",
  };

  test("a sealed key parses: env named, tenant deliberately absent", () => {
    assert.deepEqual(parseApiKey(SEALED_KEY), { env: "dev", tenant: null, sealed: true, isValid: true });
  });

  test("tenant null is NOT invalid — flipping this refuses every sealed key at the door", () => {
    assert.equal(parseApiKey(SEALED_KEY).isValid, true);
  });

  test("ORDER: a well-formed tenant key is never claimed by the sealed pattern", () => {
    // base64url includes `-` and `_`, so a long tenant key has blob SHAPE.
    // Only trying the strict forms first keeps them apart. Mutation: move the
    // sealed branch above the others and this fails.
    const long = `adas_dev_a-rather-long-tenant-name_${HEX}`;
    assert.ok(long.length > "adas_dev_".length + 46, "shorter than the sealed floor — would pass for the wrong reason");
    assert.equal(parseApiKey(long).sealed, false);
    assert.equal(parseApiKey(long).tenant, "a-rather-long-tenant-name");
  });

  test("ateam_auth asks whoami and uses ITS answer as the tenant", async () => {
    const paths = [];
    global.fetch = async (u) => {
      const url = new URL(String(u));
      paths.push(url.pathname);
      if (url.pathname === "/auth/whoami") return whoamiOk("ateam-mcp-test");
      return solutionsOk;
    };
    try {
      const out = await handlers.ateam_auth({ api_key: SEALED_KEY }, "seal1");
      assert.equal(out.ok, true, `auth failed: ${out.message}`);
      assert.equal(out.tenant, "ateam-mcp-test", "the tenant did not come from whoami");
      assert.ok(paths.includes("/auth/whoami"), `whoami was never called: ${JSON.stringify(paths)}`);
    } finally { global.fetch = origFetch; }
  });

  test("whoami is asked on the KEY'S OWN host, not the process default", async () => {
    // The default is production. Asking the wrong host who you are is how a dev
    // session gets a prod answer — the exact class this format exists to close.
    const origins = [];
    global.fetch = async (u) => {
      const url = new URL(String(u));
      origins.push(url.origin);
      return url.pathname === "/auth/whoami" ? whoamiOk("ateam-mcp-test") : solutionsOk;
    };
    try {
      await handlers.ateam_auth({ api_key: SEALED_KEY }, "seal2");
      assert.deepEqual([...new Set(origins)], [DEV], `contacted something other than the key's own environment: ${JSON.stringify(origins)}`);
    } finally { global.fetch = origFetch; }
  });

  test("THE RULE: whoami fails -> REFUSED, and no tenant is invented", async () => {
    global.fetch = async (u) => {
      if (new URL(String(u)).pathname === "/auth/whoami") {
        return { ok: false, status: 500, headers: { get: () => "application/json" }, json: async () => ({}), text: async () => "boom" };
      }
      throw new Error("must not proceed to any other call once identity is unknown");
    };
    try {
      const out = await handlers.ateam_auth({ api_key: SEALED_KEY }, "seal3");
      assert.equal(out.ok, false, "it authenticated a session that does not know who it is");
      assert.equal(out.tenant, undefined, "a tenant was reported despite whoami failing");
      assert.match(out.message, /sealed/i);
    } finally { global.fetch = origFetch; }
  });

  test("an explicit tenant arg still wins, and skips the round trip entirely", async () => {
    const paths = [];
    global.fetch = async (u) => { paths.push(new URL(String(u)).pathname); return solutionsOk; };
    try {
      const out = await handlers.ateam_auth({ api_key: SEALED_KEY, tenant: "explicitly-named" }, "seal4");
      assert.equal(out.ok, true);
      assert.equal(out.tenant, "explicitly-named");
      assert.ok(!paths.includes("/auth/whoami"), "asked whoami even though the caller had already said");
    } finally { global.fetch = origFetch; }
  });

  test("a sealed key still names a CLOSED environment", () => {
    assert.equal(parseApiKey(SEALED_KEY.replace("adas_dev_", "adas_prd_")).isValid, false);
  });
});

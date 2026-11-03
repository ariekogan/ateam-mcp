// ateam_switch_workspace: a session moves to another workspace of the same
// person with no key in the chat. The fake API lists two workspaces, hands out
// the other one's key on a switch, and answers solutions per key.
// Run: node --test test/switch-workspace.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { setSessionCredentials, getCredentials } from "../src/api.js";
import { handleToolCall } from "../src/tools.js";

const SID = "sess-switch";
const KEY_A = "adas_tenanta_00000000000000000000000000000000";
const KEY_B = "adas_tenantb_11111111111111111111111111111111";
const seen = [];
let api;
let origin;

before(async () => {
  api = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const path = req.url.split("?")[0];
      seen.push({ method: req.method, path, key: req.headers["x-api-key"], body });
      const json = (o, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (path === "/auth/workspaces") return json({ ok: true, current: "tenanta", workspaces: [{ tenant: "tenanta", current: true }, { tenant: "tenantb", current: false }] });
      if (path === "/auth/workspaces/switch") {
        const t = JSON.parse(body || "{}").tenant;
        if (t === "tenantb") return json({ ok: true, tenant: "tenantb", api_key: KEY_B, note: "n" });
        return json({ ok: false, code: "NOT_YOUR_WORKSPACE", error: "no" }, 403);
      }
      if (path === "/deploy/solutions") return json({ ok: true, solutions: [] });
      return json({ ok: true });
    });
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${api.address().port}`;
});
after(() => api.close());

const start = () => setSessionCredentials(SID, { apiKey: KEY_A, apiUrl: origin, explicit: true });

test("without a tenant it lists the workspaces and changes nothing", async () => {
  start();
  const out = JSON.parse((await handleToolCall("ateam_switch_workspace", {}, SID)).content[0].text);
  assert.equal(out.current, "tenanta");
  assert.equal(out.workspaces.length, 2);
  assert.equal(getCredentials(SID).tenant, "tenanta");
});

test("with a tenant it signs the session in with the other key and never shows it", async () => {
  start();
  const raw = (await handleToolCall("ateam_switch_workspace", { tenant: "tenantb" }, SID)).content[0].text;
  assert.ok(!raw.includes(KEY_B), "the key must not reach the chat");
  assert.equal(JSON.parse(raw).ok, true);
  assert.equal(getCredentials(SID).tenant, "tenantb");
  assert.equal(getCredentials(SID).apiKey, KEY_B);
});

test("a refused switch leaves the session where it was", async () => {
  start();
  const res = await handleToolCall("ateam_switch_workspace", { tenant: "other" }, SID);
  assert.ok(/NOT_YOUR_WORKSPACE|no/i.test(res.content[0].text));
  assert.equal(getCredentials(SID).tenant, "tenanta");
});

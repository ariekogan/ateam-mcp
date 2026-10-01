// The MCP server instructions, as SERVED, open with where the session is and
// how it signs in or moves — the text for how it is connected.
//
// Read from the wire, not from a helper: an initialize over HTTP with a
// bearer (the hosted connector), over HTTP with the platform secret (the A-Team
// app's builder, via ateam-proxy-mcp), and over an in-memory transport for a
// server built as stdio. A local process must not be told to sign in through a
// connector that cannot sign it in, and the platform is given no steps.
//
// Run: node --test test/session-opening-served.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";

const steps = await import("../src/signInSteps.js").catch(() => ({}));
const fn = (name) => {
  assert.equal(typeof steps[name], "function", `no shared ${name} in src/signInSteps.js`);
  return steps[name];
};

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on("error", reject);
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

// Nothing below needs the API; anything that asks gets an empty answer.
const fakeApi = http.createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end("{}"); });
fakeApi.unref();
await new Promise((r) => fakeApi.listen(0, "127.0.0.1", r));
process.env.ADAS_API_URL = `http://127.0.0.1:${fakeApi.address().port}`;
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = "served-opening-platform-secret";
process.env.ATEAM_BASE_URL = BASE;
process.env.CORE_MCP_SECRET = SECRET;
delete process.env.ATEAM_OAUTH_DISABLED;
const { startHttpServer } = await import("../src/http.js");
const { createServer } = await import("../src/server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

let listener;
before(async () => {
  listener = startHttpServer(PORT);
  await new Promise((r) => setTimeout(r, 300));
});
after(() => {
  delete process.env.CORE_MCP_SECRET;
  fakeApi.close();
  if (listener) {
    listener.closeAllConnections?.();
    listener.close();
  } else {
    // A startHttpServer that does not hand back its server (before #38) would
    // keep this process alive forever: end it, failed, once the report is out.
    setTimeout(() => process.exit(1), 200).unref();
  }
});

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
async function servedInstructions(headers) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(INIT),
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return JSON.parse(text).result?.instructions ?? "";
}

test("hosted, signed in by the bearer: the served instructions open with its workspace and the hosted switch steps", async () => {
  const instructions = await servedInstructions({ authorization: `Bearer adas_prod_acme_${"0".repeat(32)}` });
  const opening = fn("sessionOpening")({ audience: "hosted", signedIn: true, tenant: "acme", environment: "prod" });
  assert.ok(instructions.startsWith(opening), `served:\n${instructions.slice(0, 400)}`);
  assert.ok(instructions.includes(fn("switchSteps")({ audience: "hosted", environment: "prod" })));
  assert.match(instructions, /ALWAYS call the ateam_bootstrap tool/, "the onboarding instruction was lost");
});

test("platform (the A-Team app's builder): the served instructions give no sign-in or switch steps", async () => {
  const instructions = await servedInstructions({ "x-adas-token": SECRET });
  assert.ok(instructions.startsWith(fn("sessionOpening")({ audience: "platform", signedIn: false })), `served:\n${instructions.slice(0, 400)}`);
  assert.doesNotMatch(instructions, /HOW TO SIGN IN|HOW TO SWITCH/, "the platform was given steps a user would follow");
});

test("stdio: the served instructions give the local sign-in, not the connector's", async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer("sess-served-stdio", { transport: "stdio" }).connect(serverSide);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(clientSide);
  const instructions = client.getInstructions() ?? "";
  await client.close();
  assert.ok(instructions.startsWith(fn("sessionOpening")({ audience: "stdio", signedIn: false })), `served:\n${instructions.slice(0, 400)}`);
  assert.ok(!instructions.includes(fn("connectSteps")({ audience: "hosted" })), "a local process was told to sign in through the hosted connector");
});

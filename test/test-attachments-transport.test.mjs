// A TEST ATTACHMENT BY URL: FETCHED ON LOCAL STDIO, NEVER BY THE HOSTED SERVER.
//
// ateam_conversation / ateam_test_skill take attachments as base64 `data` or as
// a `url` (src/testAttachments.js). A url is fetched by the ateam-mcp process
// itself, so only a process the caller runs on its own machine (stdio) may do
// it; the hosted server refuses one and asks for base64.
//
// Both halves run the REAL entry points, not a flag set by the test:
//   - stdio: `node src/index.js` as a child, spoken to over its stdin/stdout
//     with the SDK's stdio client. What the Builder receives is checked.
//   - hosted: startHttpServer (src/http.js), spoken to over HTTP. Including a
//     client that names its session "stdio" — the id an HTTP client chooses and
//     http.js reuses — which must not make it local.
// Plus the hosted base64 path end to end: a 7 MB file goes through the hosted
// server to the Builder (express's default 100 KB refused it before).
//
// Run: node test/test-attachments-transport.test.mjs
import { createServer } from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { setSessionCredentials } from "../src/api.js";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); failures++; }
}

const KEY = "adas_tenanta_00000000000000000000000000000000";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const CSV = Buffer.from("date,amount\n2026-09-01,12.50\n");
const MB = 1024 * 1024;

// ─── one stand-in for the Builder and for a file host ───────────────────────
let hits = [];
const FILES = {
  "/files/pixel.png": { type: "image/png", body: PNG },
  "/files/table.csv": { type: "text/csv; charset=utf-8", body: CSV },
  "/files/archive.zip": { type: "application/zip", body: Buffer.from("PK\x03\x04") },
  "/files/huge.pdf": { type: "application/pdf", body: Buffer.alloc(7 * MB + 1, 1) },
};
const upstream = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    hits.push({ method: req.method, path: req.url, body: raw ? JSON.parse(raw) : undefined });
    const file = req.method === "GET" && FILES[req.url];
    if (file) {
      res.writeHead(200, { "Content-Type": file.type, "Content-Length": file.body.length });
      res.end(file.body);
      return;
    }
    if (req.url.startsWith("/files/")) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.method === "GET" && req.url === "/deploy/solutions") { res.end(JSON.stringify({ ok: true, solutions: [] })); return; }
    res.end(JSON.stringify({ ok: true, job_id: "job_1", chain_id: "job_1", actor_id: "test_1_x", status: "running" }));
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const API = `http://127.0.0.1:${upstream.address().port}`;

const fileHits = () => hits.filter((h) => h.path.startsWith("/files/")).map((h) => `${h.method} ${h.path}`);
const testPosts = () => hits.filter((h) => h.method === "POST" && /\/test$/.test(h.path));
const codeOf = (r) => r?.structuredContent?.code;
const textOf = (r) => r?.content?.[0]?.text || "";

// ─── 1. stdio: the real entry point, as a child process ─────────────────────
console.log("stdio (node src/index.js): a url is fetched by this process");
const stdio = new Client({ name: "attach-stdio-test", version: "1" });
await stdio.connect(new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../src/index.js", import.meta.url))],
  env: { PATH: process.env.PATH || "" },   // no ADAS_API_KEY: signs in below
  stderr: "ignore",
}));
const auth = await stdio.callTool({ name: "ateam_auth", arguments: { api_key: KEY, url: API } });
check("the child signs in against the stand-in", !auth.isError && /"ok":\s*true/.test(textOf(auth)), textOf(auth).slice(0, 300));

hits = [];
let r = await stdio.callTool({ name: "ateam_conversation", arguments: {
  solution_id: "sol", message: "what is this?", attachments: [{ url: `${API}/files/pixel.png` }],
} });
check("ateam_conversation with a url succeeds", !r.isError, textOf(r).slice(0, 300));
check("  the process fetched the url", fileHits().join() === "GET /files/pixel.png", fileHits().join());
check("  the Builder received the file as dev-app sends one: { data, mimeType, name }",
  testPosts().length === 1 &&
  JSON.stringify(testPosts()[0].body.attachments) === JSON.stringify([{ data: PNG.toString("base64"), mimeType: "image/png", name: "pixel.png" }]),
  JSON.stringify(testPosts()[0]?.body?.attachments)?.slice(0, 300));

hits = [];
r = await stdio.callTool({ name: "ateam_test_skill", arguments: {
  solution_id: "sol", skill_id: "sk", message: "log this", wait_for: "never",
  attachments: [{ url: `${API}/files/table.csv`, name: "september.csv" }, { data: PNG.toString("base64"), mimeType: "image/png", name: "p.png" }],
} });
const skillPost = testPosts()[0];
check("ateam_test_skill with a url and a data item succeeds", !r.isError, textOf(r).slice(0, 300));
check("  the type is the response's, without its parameters; a given name wins",
  JSON.stringify(skillPost?.body?.attachments?.[0]) === JSON.stringify({ data: CSV.toString("base64"), mimeType: "text/csv", name: "september.csv" }),
  JSON.stringify(skillPost?.body?.attachments?.[0]));
check("  and the data item rides after it, unchanged, in order",
  JSON.stringify(skillPost?.body?.attachments?.[1]) === JSON.stringify({ data: PNG.toString("base64"), mimeType: "image/png", name: "p.png" }));
check("  to the skill's test route", skillPost?.path === "/deploy/solutions/sol/skills/sk/test", skillPost?.path);

for (const [file, code] of [["archive.zip", "ATTACHMENT_TYPE_UNSUPPORTED"], ["huge.pdf", "ATTACHMENTS_TOO_LARGE"], ["gone.png", "ATTACHMENT_FETCH_FAILED"]]) {
  hits = [];
  r = await stdio.callTool({ name: "ateam_conversation", arguments: {
    solution_id: "sol", message: "what is this?", attachments: [{ url: `${API}/files/${file}` }],
  } });
  check(`a url answering ${file} is ${code}, and the Builder got nothing`,
    r.isError === true && codeOf(r) === code && testPosts().length === 0,
    `${codeOf(r)} ${textOf(r).slice(0, 200)} posts=${testPosts().length}`);
}
await stdio.close();

// ─── 2. hosted: the real HTTP transport ─────────────────────────────────────
async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
process.env.ATEAM_OAUTH_DISABLED = "1";   // no bearer to mint here: the session is signed in below
const { startHttpServer } = await import("../src/http.js");
startHttpServer(PORT);
delete process.env.ATEAM_OAUTH_DISABLED;
await new Promise((r) => setTimeout(r, 300));

let rpcId = 10;
async function hostedCall(sessionId, name, args) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, result: json?.result, error: json?.error, text };
}

// Signed in the way a hosted session is (a bearer's credentials), for two
// session ids: an ordinary one, and "stdio" — chosen by the client.
for (const sid of ["sess-hosted-attach", "stdio"]) {
  setSessionCredentials(sid, { apiKey: KEY, apiUrl: API, explicit: true });
}

for (const sid of ["sess-hosted-attach", "stdio"]) {
  console.log(`hosted (src/http.js), session id "${sid}": a url is refused`);
  for (const [tool, args] of [
    ["ateam_conversation", { solution_id: "sol", message: "what is this?" }],
    ["ateam_test_skill", { solution_id: "sol", skill_id: "sk", message: "what is this?", wait_for: "never" }],
  ]) {
    hits = [];
    const res = await hostedCall(sid, tool, { ...args, attachments: [{ url: `${API}/files/pixel.png` }] });
    check(`${tool}: ATTACHMENT_URL_NOT_FETCHED`, res.result?.isError === true && codeOf(res.result) === "ATTACHMENT_URL_NOT_FETCHED",
      `${res.status} ${res.text.slice(0, 300)}`);
    check(`${tool}:   the message says to send base64 and that the hosted server does not fetch URLs`,
      /send the file as base64 `data`; the hosted server does not fetch URLs/.test(textOf(res.result)), textOf(res.result).slice(0, 200));
    check(`${tool}:   the url was never fetched`, fileHits().length === 0, fileHits().join());
    check(`${tool}:   the Builder got nothing`, testPosts().length === 0);
  }
}

console.log("hosted: base64 is the hosted path, and it carries a real file");
hits = [];
const SEVEN = Buffer.alloc(7 * MB, 3).toString("base64");
let res = await hostedCall("sess-hosted-attach", "ateam_conversation", {
  solution_id: "sol", message: "what is this?", attachments: [{ data: SEVEN, mimeType: "application/pdf", name: "big.pdf" }],
});
check("a 7 MB file (the cap) sent as base64 through the hosted server reaches the Builder",
  res.status === 200 && res.result && !res.result.isError && testPosts().length === 1,
  `${res.status} ${res.text.slice(0, 200)}`);
check("  unchanged", testPosts()[0]?.body?.attachments?.[0]?.data === SEVEN && testPosts()[0]?.body?.attachments?.[0]?.name === "big.pdf");

hits = [];
res = await hostedCall("sess-hosted-attach", "ateam_conversation", {
  solution_id: "sol", message: "what is this?", attachments: [{ data: Buffer.alloc(8 * MB, 3).toString("base64"), mimeType: "application/pdf", name: "too.pdf" }],
});
check("a body over the hosted limit is a named 413, not a 500",
  res.status === 413 && /over the 10485760-byte limit of this route/.test(res.error?.message || "") && /capped at 7 MB/.test(res.error?.message || ""),
  `${res.status} ${res.text.slice(0, 200)}`);
check("  and the Builder got nothing", testPosts().length === 0);

upstream.close();
if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log("\nALL CHECKS PASSED");
process.exit(0);

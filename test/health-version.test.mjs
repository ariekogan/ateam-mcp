// ONE ANSWER TO "WHICH BUILD IS RUNNING?"
//
// The MCP handshake and ateam_bootstrap report MCP_VERSION (tools.js, read from
// the package.json next to the code, 6f3aca4). /health then got its own reader
// of the same file (http.js PKG_VERSION, 9d6d10b) — a second implementation of
// the one question a stale-server hunt depends on, kept equal to the first by
// nothing. /health now reports MCP_VERSION.
//
// Boots the real HTTP transport on a free port and asks /health.
// Run: node test/health-version.test.mjs   (npm test runs it too)
import net from "node:net";
import { readFileSync } from "node:fs";

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); failures++; }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

const PORT = await freePort();
const { startHttpServer } = await import("../src/http.js");
const { MCP_VERSION } = await import("../src/tools.js");
startHttpServer(PORT);
await new Promise((r) => setTimeout(r, 300));

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();

console.log("/health reports the one running version");
check("(control) MCP_VERSION is the package.json version", MCP_VERSION === pkg, `${MCP_VERSION} vs ${pkg}`);
check("/health version is MCP_VERSION", health.version === MCP_VERSION, `${health.version} vs ${MCP_VERSION}`);

console.log("http.js does not keep its own copy of the answer");
const HTTP_SRC = readFileSync(new URL("../src/http.js", import.meta.url), "utf8");
check("no second package.json reader in http.js",
  !/readFileSync|createRequire|PKG_VERSION/.test(HTTP_SRC),
  "http.js reads the version itself again — the handshake and /health can disagree");

if (failures) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log("\nALL CHECKS PASSED");
process.exit(0);

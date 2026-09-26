#!/usr/bin/env node
/**
 * server.json FOLLOWS package.json. Runs as the npm `version` hook.
 *
 * server.json is the MCP Registry manifest (mcp-publisher, 3af3782). It names
 * the npm version it describes, twice, and nothing ever moved it: it said 0.1.2
 * from 2026-02-17 while the package shipped 0.4.x, so the registry pointed
 * installers at a build from February. package.json owns the version; this
 * copies it across, so `npm version <patch|minor|x.y.z>` moves package.json,
 * package-lock.json and server.json in one step, and stages server.json for
 * the version commit (the `git add` in the hook). The ".github/review-rules"
 * lockstep rule states the requirement; test/release-metadata.test.mjs
 * enforces it.
 */
import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const server = JSON.parse(readFileSync("server.json", "utf8"));

server.version = pkg.version;
for (const p of server.packages || []) {
  if (p.registryType === "npm" && p.identifier === pkg.name) p.version = pkg.version;
}
writeFileSync("server.json", `${JSON.stringify(server, null, 2)}\n`);
console.log(`server.json -> ${pkg.version}`);

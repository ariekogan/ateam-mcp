// The device grant a plugin declares must be VISIBLE in the widget catalog,
// and the plugin scaffold must grant what its own template calls.
//
// WHY. The phone grants a plugin {...native, ...capabilities} from the manifest
// its connector's ui.getPlugin returns (@ateam-ai-mobile/plugin-runtime 0.1.8,
// pluginRuntime.ts mergeCaps): `capabilities` is the key, `native` the legacy
// spelling. The catalog projected `capabilities` only, so a plugin whose flags
// sat under `native` read here as "capabilities": null. A Builder change
// (32bdb26) took that null as evidence that Core drops `capabilities`; the
// catalog simply never showed the key the plugin used.
//
// And since 0.1.8 the bundle's own `capabilities` block grants nothing, so a
// scaffold whose RN template calls native.haptics must grant haptics in the
// manifest, not only in the bundle.
//
// Run: node test/widget-catalog-grant.test.mjs

import { _widgetCatalogEntry, _scaffoldPluginFilesForTest } from "../src/tools.js";

let failures = 0;
function check(name, cond) {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}`); failures++; }
}

console.log("widget catalog shows the key the plugin declared");
const nativeOnly = _widgetCatalogEntry({
  id: "mcp:walk-trail:walk-trail", name: "Walk", render: { mode: "react-native" },
  capabilities: null, native: { location: true, camera: true },
}, false);
check("a native-only plugin's flags are shown", nativeOnly.native?.location === true && nativeOnly.native?.camera === true);
check("…and flagged as the legacy key", /legacy key/.test(nativeOnly.native_is_legacy || ""));
check("capabilities is still reported as declared (null), not invented", nativeOnly.capabilities === null);

const canonical = _widgetCatalogEntry({
  id: "mcp:c:p", capabilities: { location: true, commands: [{ name: "open" }] },
}, false);
check("a capabilities-only plugin carries no native field", !("native" in canonical) && !("native_is_legacy" in canonical));
check("…and its commands still drive the opener", canonical.how_to_use.opener_call.startsWith("ui.p.open("));

const both = _widgetCatalogEntry({
  id: "mcp:c:b", capabilities: { camera: true }, native: { camera: true },
}, true);
check("both keys: both shown (summary format too)", both.capabilities?.camera === true && both.native?.camera === true);
check("summary format still omits how_to_use", !("how_to_use" in both));

console.log("the plugin scaffold grants what its template calls");
for (const kind of ["rn", "adaptive"]) {
  const files = _scaffoldPluginFilesForTest({ connectorId: "demo-mcp", pluginName: "demo", kind });
  const manifest = JSON.parse(files.find((f) => f.path === "ui-dist/demo/manifest.json").content);
  const tsx = files.find((f) => f.path === "rn-src/demo.tsx")?.content || "";
  check(`${kind}: the RN template calls native.haptics`, /native\?*\.haptics/.test(tsx));
  check(`${kind}: the manifest grants haptics under capabilities`, manifest.capabilities?.haptics === true);
  check(`${kind}: the manifest does not use the legacy key`, !("native" in manifest));
  check(`${kind}: commands stay under capabilities`, Array.isArray(manifest.capabilities?.commands));
}
const iframe = JSON.parse(_scaffoldPluginFilesForTest({ connectorId: "demo-mcp", pluginName: "demo", kind: "iframe" })
  .find((f) => f.path === "ui-dist/demo/manifest.json").content);
check("iframe: no device flag granted (the web host has none)", !("haptics" in iframe.capabilities));

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

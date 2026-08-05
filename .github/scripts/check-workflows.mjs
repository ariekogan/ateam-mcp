#!/usr/bin/env node
/**
 * Reject a workflow YAML that GitHub would reject — before a dispatch wastes a run.
 *
 *   node .github/scripts/check-workflows.mjs [files...]   # default: .github/workflows/*.yml
 *
 * The specific trap this exists for: DUPLICATE MAPPING KEYS. Ruby's Psych and
 * PyYAML both keep the last one silently, so a local "YAML OK" check passes while
 * GitHub answers `HTTP 422: 'env' is already defined` and the entire workflow —
 * every job in it — is unparseable. That has broken this repo's review workflow
 * twice, each time discovered only when a review was dispatched.
 *
 * Deliberately dependency-free: it must run in any checkout with nothing installed,
 * which is exactly the situation where a workflow edit gets pushed.
 */
import fs from 'node:fs';
import path from 'node:path';

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync('.github/workflows').filter((f) => /\.ya?ml$/.test(f))
      .map((f) => path.join('.github/workflows', f));

// A mapping key at a given indent, inside a given block. A new list item ("- ")
// or any dedent starts a fresh mapping, so keys only collide within one block.
const KEY = /^(\s*)(?:- )?([A-Za-z_][\w.-]*|'[^']+'|"[^"]+"):(\s|$)/;

let bad = 0;
for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const seen = new Map();   // indent -> Set(keys)
  const errs = [];
  let inBlockScalar = null; // indent of a `|`/`>` block — its contents are text

  lines.forEach((line, i) => {
    if (!line.trim() || /^\s*#/.test(line)) return;
    const indent = line.match(/^\s*/)[0].length;

    if (inBlockScalar !== null) {
      if (indent > inBlockScalar) return;   // still inside the literal text
      inBlockScalar = null;
    }

    // A block scalar can also be a bare SEQUENCE ITEM (`- |`), with no key and no
    // colon. Missing that made the literal text below it read as mapping keys, so
    // valid YAML was rejected as "GitHub rejects this with HTTP 422" — a false
    // accusation from a script that gates every push. Found by review, 2026-08-03.
    if (/^\s*-\s*[|>][-+]?\s*$/.test(line)) { inBlockScalar = indent; return; }

    const m = line.match(KEY);
    if (!m) return;
    const [, ws, rawKey] = m;
    const key = rawKey.replace(/^['"]|['"]$/g, '');
    const col = ws.length + (/^\s*- /.test(line) ? 2 : 0);

    // A "- " begins a new mapping even at the same indent as the previous item.
    if (/^\s*- /.test(line)) for (const k of [...seen.keys()]) if (k >= col) seen.delete(k);
    for (const k of [...seen.keys()]) if (k > col) seen.delete(k);

    if (!seen.has(col)) seen.set(col, new Set());
    if (seen.get(col).has(key)) {
      errs.push(`line ${i + 1}: duplicate key '${key}' — GitHub rejects this with HTTP 422`);
    }
    seen.get(col).add(key);

    if (/:\s*[|>][-+]?\s*$/.test(line)) inBlockScalar = col;
  });

  if (errs.length) { bad++; console.error(`  FAIL ${file}`); errs.forEach((e) => console.error(`       ${e}`)); }
  else console.log(`  ok   ${file}`);
}
process.exit(bad ? 1 : 0);

#!/usr/bin/env node
/**
 * Decide whether a review run CONTINUES the accumulated findings or starts fresh,
 * and mark a run complete when it finishes.
 *
 *   node review-accumulator.mjs mode <from_sha> [file]   -> prints "resume" | "fresh"
 *   node review-accumulator.mjs complete [file]          -> stamp the run finished
 *
 * Why this is not a one-liner. Two wrong versions shipped:
 *
 *  1. `[ "$FROM" != "$MARKER" ]` — FROM DEFAULTS to MARKER, so it could never be
 *     true and every new review inherited the previous one's slices, inflating the
 *     reported spend and re-dispatching handled findings.
 *  2. "the last slice's `to` equals FROM" — true on a resume, but ALSO true after a
 *     run that finished: it banks the marker at its final slice, and the next
 *     review starts from exactly there. Continuity cannot distinguish them.
 *
 * The distinguishing fact is not in the shas at all: a resume happens because the
 * previous run DIED. So the previous run records when it finished, and anything
 * that finished is never resumed.
 */
import fs from 'node:fs';

const DEFAULT_FILE = '/tmp/codex-last-findings.json';
const [cmd, ...rest] = process.argv.slice(2);

const read = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

if (cmd === 'mode') {
  const from = rest[0] || '';
  const file = rest[1] || DEFAULT_FILE;
  const a = read(file);
  const slices = a?.slices || [];
  if (!slices.length) { console.log('fresh'); process.exit(0); }
  if (a.complete) { console.log('fresh'); process.exit(0); }        // it finished — not a resume
  const lastTo = slices[slices.length - 1]?.to || '';
  console.log(lastTo && lastTo === from ? 'resume' : 'fresh');
  process.exit(0);
}

if (cmd === 'complete') {
  const file = rest[0] || DEFAULT_FILE;
  const a = read(file);
  if (!a) process.exit(0);
  a.complete = true;
  fs.writeFileSync(file, JSON.stringify(a, null, 2));
  process.exit(0);
}

console.error('usage: review-accumulator.mjs mode <from_sha> [file] | complete [file]');
process.exit(1);

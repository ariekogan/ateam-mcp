// Reading a big text file in parts, and finding lines in files: ateam_github_read and ateam_get_connector_source.
//
// A tool answer carries about 50 KB (tools.js MAX_RESPONSE_CHARS); a bigger file was cut there, and a 183 KB connector
// file could not be read past its first quarter. Now a file is read by line range (offset = first line, 1-based; limit =
// how many lines), like a code editor's Read, and a file too big for one answer comes back in parts with next_offset.
// `search` finds the lines that contain a text, in one file or in all of a connector's files, with their line numbers.

/** The most file text one answer carries: under the ~50 KB cap, with room for the rest of the answer. */
export const WINDOW_CHARS = 40_000;
/** The most matching lines one search returns. */
export const MAX_MATCHES = 200;
const MATCH_TEXT_CHARS = 300;

const whole = (n) => (Number.isFinite(Number(n)) ? Math.trunc(Number(n)) : null);

/**
 * The part of `text` to return, or null when the whole text fits and no range was asked for (the answer is unchanged).
 * @param {string} text
 * @param {{ offset?: number, limit?: number }} [range]  offset: first line (1-based); limit: number of lines
 * @returns {null | { content: string, lines: { from: number, to: number, total: number }, next_offset: number|null, note: string }}
 */
export function lineWindow(text, { offset, limit } = {}) {
  const asked = offset != null || limit != null;
  if (!asked && text.length <= WINDOW_CHARS) return null;
  const lines = text.split("\n");
  const total = lines.length;
  const from = Math.max(1, whole(offset) || 1);
  const want = limit != null ? Math.max(1, whole(limit) || 1) : total;
  const last = Math.min(total, from + want - 1);
  let end = from - 1;
  let chars = 0;
  for (let i = from; i <= last; i++) {
    const n = lines[i - 1].length + 1;
    if (chars + n > WINDOW_CHARS && i > from) break; // one very long line is still returned whole
    chars += n;
    end = i;
  }
  const next = end < total ? end + 1 : null;
  const note = from > total
    ? `Line ${from} is past the end: the file has ${total} lines.`
    : next
      ? `Lines ${from}-${end} of ${total}. Read on with offset:${next}${end < last ? " (this part stopped early to fit one answer)" : ""}.`
      : `Lines ${from}-${end} of ${total} (to the end of the file).`;
  return { content: lines.slice(from - 1, end).join("\n"), lines: { from, to: end, total }, next_offset: next, note };
}

/**
 * The lines that contain `search` (letter case ignored), with their file and line number.
 * @param {Array<{ path: string, content: string, encoding?: string }>} files  binary (base64) files are skipped
 * @param {string} search
 * @returns {{ search: string, matches: Array<{ path: string, line: number, text: string }>, total_matches: number, files_searched: number, truncated: boolean, note?: string }}
 */
export function findLines(files, search) {
  const needle = String(search || "").toLowerCase();
  const matches = [];
  let total = 0;
  let searched = 0;
  for (const f of files || []) {
    if (typeof f?.content !== "string" || (f.encoding && f.encoding !== "utf8")) continue;
    searched += 1;
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!needle || !lines[i].toLowerCase().includes(needle)) continue;
      total += 1;
      if (matches.length < MAX_MATCHES) {
        const t = lines[i].trim();
        matches.push({ path: f.path, line: i + 1, text: t.length > MATCH_TEXT_CHARS ? t.slice(0, MATCH_TEXT_CHARS - 1) + "…" : t });
      }
    }
  }
  const truncated = total > matches.length;
  return {
    search: String(search || ""),
    matches,
    total_matches: total,
    files_searched: searched,
    truncated,
    note: total === 0
      ? `No line contains "${search}".`
      : `${total} matching line${total === 1 ? "" : "s"}${truncated ? `, the first ${matches.length} shown: search for something narrower` : ""}. Read around one with path and offset (a few lines before its line number).`,
  };
}

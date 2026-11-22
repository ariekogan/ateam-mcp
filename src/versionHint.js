// THE SOLUTION VERSION'S SOFT HINTS (Arie, 2026-11-22).
//
// The version is X.Y.Z of what runs (Core utils/solutionVersion.js): every deploy adds one to Z, every promote makes it
// X.(Y+1).0, and X moves only when the developer says yes (ateam_switch_major_version). Two hints ride on the answer of
// every tool that moved it, and they are only hints: nothing is blocked, nothing is switched without the developer.
//
//   Z reaches 10 (1.7.10): "Current version is 1.7.10, I recommend promoting dev to prod."
//   Y reaches 10 (1.10.3): "Current solution version is 1.10.3. Do you want to switch it to 2.0.0?"

/** Ten deploys since the last promote: recommend a promote. */
export const PROMOTE_HINT_AT_DEPLOYS = 10;
/** Ten promotes since the last major: offer the next major. */
export const MAJOR_HINT_AT_PROMOTES = 10;

/**
 * The deployed version a tool's answer carries, or null: the Builder's { version: { version: "1.7.10", … } } on the
 * answer itself, or on the redeploy it ran (ateam_patch's `redeploy`).
 */
export function deployedVersionOf(result) {
  const of = (o) => {
    const v = o && typeof o === "object" ? o.version : null;
    return v && typeof v === "object" && typeof v.version === "string" ? v.version : null;
  };
  return result && typeof result === "object" ? of(result) || of(result.redeploy) : null;
}

/**
 * What to tell or ask the developer for this version, or null when there is nothing to say. `promoting`: the answer of a
 * promote, which never recommends the promote it just made (a promote whose commit is not yet what runs moves nothing).
 * → { version, promote?: string, major?: { ask: string, to: string, how: string } }
 */
export function versionHint(version, solutionId, { promoting = false } = {}) {
  const m = typeof version === "string" ? /^(\d+)\.(\d+)\.(\d+)$/.exec(version) : null;
  if (!m) return null;
  const [x, y, z] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const hint = { version };
  if (z >= PROMOTE_HINT_AT_DEPLOYS && !promoting) {
    hint.promote = `Tell the user: "Current version is ${version}, I recommend promoting dev to prod." (ateam_github_promote). Only a recommendation: nothing is blocked, and once in this conversation is enough.`;
  }
  if (y >= MAJOR_HINT_AT_PROMOTES) {
    const to = `${x + 1}.0.0`;
    hint.major = {
      ask: `Current solution version is ${version}. Do you want to switch it to ${to}?`,
      to,
      how: `Ask the user exactly that. Only on their yes: ateam_switch_major_version({ solution_id: "${solutionId || "<solution_id>"}", to: "${to}" }). Never switch without it; once in this conversation is enough.`,
    };
  }
  return hint.promote || hint.major ? hint : null;
}

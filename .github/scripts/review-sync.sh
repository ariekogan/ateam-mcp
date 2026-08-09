#!/usr/bin/env bash
# Keep the review pipeline IDENTICAL across every CORE repo.
#
#   .github/scripts/review-sync.sh check    # report drift, change nothing
#   .github/scripts/review-sync.sh push     # make every repo match this one
#
# WHY THIS EXISTS. GitHub Free cannot call a PRIVATE reusable workflow across
# repos (documented in .github/AI_PIPELINE.md), so the pipeline has to be COPIED
# into each repo rather than shared. That constraint is fixed. What is not fixed is
# the drift it causes: every bug then exists in four places, and the expensive
# mistake — made repeatedly — is fixing one copy and believing all four are done.
#
# ai-dev-assistant is the source of truth. `check` is free and read-only, so run it
# after any pipeline change; `push` copies and commits to each repo's DEFAULT branch
# (where GitHub schedules from) and, for a repo that reviews a different branch,
# there too.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ACTION="${1:-check}"
SOURCE_REPO="ariekogan/ai-dev-assistant"

# Everything that must be byte-identical everywhere. Deliberately explicit: a glob
# would silently start syncing whatever new file lands in .github/.
FILES=(
  .github/workflows/codex-review-range.yml
  .github/workflows/review-scheduled.yml
  .github/review-repos.json
  .github/prompts/codex-review.md
  .github/scripts/codex-review-since.sh
  .github/scripts/codex-triage.mjs
  .github/scripts/codex-resolve-model.mjs
  .github/scripts/codex-select-rules.mjs
  .github/scripts/codex-file-findings.mjs
  .github/scripts/codex-finding.sh
  .github/scripts/codex-my-findings.sh
  .github/scripts/codex-findings.mjs
  .github/scripts/capture-spend.mjs
  .github/scripts/review-accumulator.mjs
  .github/scripts/check-workflows.mjs
  .github/scripts/review-plan.mjs
  .github/scripts/review-scheduled.sh
  .github/scripts/review.sh
  .github/scripts/review-sync.sh
  # NO_ABANDONED_CODE is the one rule that is genuinely repo-independent: it is about
  # how the work happens, not what the repo contains. The other rule files stay
  # unsynced on purpose — they describe one repo's architecture.
  .github/review-rules/NO_ABANDONED_CODE.md
)
# NOT synced, on purpose: review-areas.json maps THIS repo's paths to areas, and
# review-rules/ may carry repo-specific rules. Copying those would route findings
# by another repo's layout.

targets() {   # repo<TAB>review-branch, from the shared registry
  node -e '
    const fs=require("fs");
    const reg=JSON.parse(fs.readFileSync(process.argv[1]+"/.github/review-repos.json","utf8"));
    for (const r of reg.repos) if (r.repo !== process.argv[2]) console.log(r.repo+"\t"+(r.branch||""));
  ' "$ROOT" "$SOURCE_REPO"
}

default_branch() { gh api "repos/$1" --jq .default_branch 2>/dev/null || echo main; }

# Compare a single file against a repo/ref without cloning anything.
remote_sha() { gh api "repos/$1/contents/$3?ref=$2" --jq .sha 2>/dev/null || true; }
local_sha()  { git -C "$ROOT" hash-object "$1" 2>/dev/null || true; }

drift_for() {  # $1=repo $2=ref → prints one line per differing file
  local repo="$1" ref="$2" f
  for f in "${FILES[@]}"; do
    [ -f "$ROOT/$f" ] || continue
    local want have
    want=$(local_sha "$ROOT/$f")
    have=$(remote_sha "$repo" "$ref" "$f")
    if [ -z "$have" ]; then echo "  MISSING  $f"
    elif [ "$want" != "$have" ]; then echo "  DIFFERS  $f"
    fi
  done
}

case "$ACTION" in
  check)
    total=0
    while IFS=$'\t' read -r repo branch; do
      [ -n "$repo" ] || continue
      def=$(default_branch "$repo")
      echo "── $repo (default: $def${branch:+, reviews: $branch}) ──"
      out=$(drift_for "$repo" "$def")
      # A repo that reviews a non-default branch needs the pipeline on BOTH: the
      # timer runs from default, the review runs on the reviewed branch.
      if [ -n "$branch" ] && [ "$branch" != "$def" ]; then
        out2=$(drift_for "$repo" "$branch")
        [ -n "$out2" ] && out="${out}
  [on $branch]
${out2}"
      fi
      if [ -z "${out//[$'\n' ]/}" ]; then echo "  in sync"
      else printf '%s\n' "$out"; total=$((total+1)); fi
    done < <(targets)
    echo ""
    if [ "$total" -eq 0 ]; then echo "✅ every repo matches $SOURCE_REPO"
    else echo "⚠️  $total repo(s) drifted — run: $0 push"; exit 1; fi
    ;;

  push)
    WORK="${TMPDIR:-/tmp}/review-sync-$$"
    mkdir -p "$WORK"
    trap 'rm -rf "$WORK"' EXIT
    rc=0
    while IFS=$'\t' read -r repo branch; do
      [ -n "$repo" ] || continue
      def=$(default_branch "$repo")
      name="${repo##*/}"
      # SSH, not HTTPS: an OAuth token without `workflow` scope is refused when a
      # push touches .github/workflows — and it is silent about which file.
      git clone -q "git@github.com:${repo}.git" "$WORK/$name" 2>/dev/null || { echo "❌ $repo: clone failed"; rc=1; continue; }
      for ref in $def ${branch:+$([ "$branch" != "$def" ] && echo "$branch")}; do
        ( cd "$WORK/$name"
          git checkout -q -B "$ref" "origin/$ref" 2>/dev/null || exit 0
          for f in "${FILES[@]}"; do
            [ -f "$ROOT/$f" ] || continue
            mkdir -p "$(dirname "$f")"; cp "$ROOT/$f" "$f"
          done
          chmod +x .github/scripts/*.sh .github/scripts/*.mjs 2>/dev/null || true
          git add .github >/dev/null
          git diff --cached --quiet && { echo "  = $repo@$ref already in sync"; exit 0; }
          git -c user.name="Claude" -c user.email="noreply@anthropic.com" \
              commit -q -m "ci: sync the review pipeline from ai-dev-assistant

GitHub Free cannot share a private reusable workflow across repos, so this is a
copy. Kept identical by .github/scripts/review-sync.sh — fixing one copy and
forgetting the others is what made this pipeline unreliable."
          if git push -q origin "HEAD:$ref" 2>/dev/null; then echo "  ✅ $repo@$ref updated"
          else echo "  ❌ $repo@$ref push failed"; exit 1; fi
        ) || rc=1
      done
    done < <(targets)
    echo ""
    [ "$rc" = "0" ] && echo "✅ all repos synced" || { echo "⚠️  some repos did not sync"; exit 1; }
    ;;

  *) sed -n '2,8p' "$0"; exit 1 ;;
esac

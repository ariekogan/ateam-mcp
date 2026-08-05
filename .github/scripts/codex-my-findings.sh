#!/usr/bin/env bash
# "Which Codex findings apply to what I'm working on?"
#
#   .github/scripts/codex-my-findings.sh                 # areas of my uncommitted+recent work
#   .github/scripts/codex-my-findings.sh apps/voice/...  # areas of specific paths
#
# A session cannot reliably know "its" area from its name — names drift and one
# session touches several areas. So the area is derived from the FILES, not from
# the session's identity: map each path through .github/review-areas.json, then
# show the open `area:<name>` issues for those areas.
set -euo pipefail

REPO="${REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
MAP=".github/review-areas.json"
[ -f "$MAP" ] || MAP="._aip/.github/review-areas.json"
[ -f "$MAP" ] || { echo "review-areas.json not found"; exit 1; }

# Paths: explicit args, else what this worktree is actually touching
if [ "$#" -gt 0 ]; then
  PATHS="$*"
else
  PATHS=$( { git status --porcelain | awk '{print $2}'; \
             git log --name-only --pretty=format: -20 2>/dev/null; } | sort -u | grep -v '^$' || true)
fi
[ -n "$PATHS" ] || { echo "No changed/recent files to derive areas from — pass paths explicitly."; exit 0; }

AREAS=$(printf '%s\n' $PATHS | node -e '
  const fs=require("fs");
  const map=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const areaFor=f=>{for(const a of map.areas) if(a.patterns.some(p=>f.includes(p))) return a.area; return null;};
  let out=new Set(), input="";
  process.stdin.on("data",d=>input+=d).on("end",()=>{
    for(const f of input.split("\n")) { const a=f&&areaFor(f.trim()); if(a) out.add(a); }
    console.log([...out].join("\n"));
  });
' "$MAP")

[ -n "$AREAS" ] || { echo "No mapped areas for those paths."; exit 0; }

echo "Areas you are touching: $(echo $AREAS | tr '\n' ' ')"
echo ""
FOUND=0
for a in $AREAS; do
  ISSUES=$(gh issue list --repo "$REPO" --label "area:$a" --state open --json number,title --jq '.[]|"  #\(.number) \(.title)"' 2>/dev/null || true)
  if [ -n "$ISSUES" ]; then
    FOUND=1
    echo "■ area:$a"
    echo "$ISSUES"
    echo "    → gh issue view <n> --repo $REPO"
  fi
done
[ "$FOUND" -eq 1 ] || echo "✅ No open Codex findings for your areas."

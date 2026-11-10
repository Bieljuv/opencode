#!/usr/bin/env bash
# ManosTech skill gate — NVIDIA SkillSpector audit for agent skills.
#
# No agent skill enters the app without passing the SkillSpector security
# scan (static analysis only, --no-llm: nothing leaves the machine, no key
# needed). Fails closed on DO NOT INSTALL (score > 50).
#
# Usage:
#   skillspector-gate.sh --all                      scan every skill in the repo
#   skillspector-gate.sh --changed [base]           scan skills changed vs base
#                                                   (default base: HEAD^1, the
#                                                   PR base on a merge checkout)
#   skillspector-gate.sh --changed-worktree         scan skills with uncommitted
#                                                   changes (local pre-push check)
#   skillspector-gate.sh <dir> [<dir> ...]          scan the given skill dirs
#
# Exit code: 0 when every scanned skill passes (or nothing to scan),
# 1 when any skill fails or the scan itself cannot be trusted (missing
# binary, scan error, unparseable report). Deleting a skill never fails
# the gate — a removed skill cannot introduce risk.
#
# Skill roots (owned + shipped by this fork, plus upstream's figma plugin
# which ships in the app, plus the test fixtures that carry SKILL.md):
#   packages/plugins/**  .opencode/skills/**  packages/core/test/config/fixture/skills/**
set -euo pipefail

THRESHOLD=50
SKILL_ROOTS=(
  "packages/plugins"
  ".opencode/skills"
  "packages/core/test/config/fixture/skills"
)

usage() {
  sed -n '2,24p' "$0" | sed 's/^# //; s/^#$//'
  exit 2
}

fail() {
  echo "skillspector-gate: ERROR: $*" >&2
  exit 1
}

# --- prerequisites (fail closed: no scanner, no pass) -----------------------
command -v skillspector >/dev/null 2>&1 || fail "skillspector not on PATH (uv tool install git+https://github.com/NVIDIA/skillspector.git@v2.12.0)"
command -v python3 >/dev/null 2>&1 || fail "python3 not on PATH (needed to read the scan report)"
command -v git >/dev/null 2>&1 || fail "git not on PATH"

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
REPORT_DIR="$(mktemp -d)"
trap 'rm -rf "$REPORT_DIR"' EXIT

# --- discovery ---------------------------------------------------------------
find_all_skill_dirs() {
  for root in "${SKILL_ROOTS[@]}"; do
    [ -d "$root" ] || continue
    find "$root" -name "SKILL.md" -not -path "*/node_modules/*" 2>/dev/null
  done | xargs -r -n1 dirname | sort -u
}

# Nearest ancestor dir of $1 that contains a SKILL.md (empty when none).
skill_dir_for_path() {
  local dir="$1"
  while [ "$dir" != "." ] && [ "$dir" != "/" ] && [ -n "$dir" ]; do
    if [ -f "$dir/SKILL.md" ]; then
      echo "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

changed_skill_dirs() {
  local base="$1"
  local mode="$2" # committed | worktree
  local files
  if [ "$mode" = "worktree" ]; then
    files="$(git diff --name-only HEAD)"
  else
    git rev-parse --verify "$base" >/dev/null 2>&1 || fail "base ref '$base' not found"
    files="$(git diff --name-only "$base" HEAD)"
  fi
  [ -n "$files" ] || return 0
  while IFS= read -r f; do
    # Only paths under a skill root can belong to a skill.
    local in_root=0
    for root in "${SKILL_ROOTS[@]}"; do
      case "$f" in "$root"/*) in_root=1 ;; esac
    done
    [ "$in_root" = 1 ] || continue
    skill_dir_for_path "$(dirname "$f")" || true
  done <<< "$files" | sort -u
}

# --- one skill ---------------------------------------------------------------
# Prints: [PASS|FAIL] <name> — <score>/100 <SEVERITY> <RECOMMENDATION>
# Returns 0 on pass, 1 on fail.
scan_one() {
  local dir="$1"
  local name report score severity recommendation
  name="$(basename "$dir")"
  report="$REPORT_DIR/$(echo "$dir" | tr '/' '_').json"

  # skillspector exits 1 when the score is above its fail line; anything
  # else non-zero is a scan error. Either way we judge from the report.
  local rc=0
  skillspector scan "$dir" --no-llm --format json --output "$report" >/dev/null 2>&1 || rc=$?
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 1 ]; then
    echo "[FAIL] $dir — skillspector exited $rc (scan error, failing closed)"
    return 1
  fi
  if [ ! -s "$report" ]; then
    echo "[FAIL] $dir — no scan report produced (failing closed)"
    return 1
  fi

  local parsed
  parsed="$(python3 - "$report" <<'PY' 2>/dev/null
import json, sys
d = json.load(open(sys.argv[1]))
ra = d.get("risk_assessment", {})
print(f"{int(float(ra.get('score', -1)))}|{ra.get('severity')}|{ra.get('recommendation')}")
PY
)" || {
    echo "[FAIL] $dir — scan report unparseable (failing closed)"
    return 1
  }
  score="${parsed%%|*}"; rest="${parsed#*|}"
  severity="${rest%%|*}"; recommendation="${rest##*|}"

  if [ -z "$score" ] || [ -z "$recommendation" ]; then
    echo "[FAIL] $dir — scan report has no score (failing closed)"
    return 1
  fi

  if [ "$recommendation" = "DO NOT INSTALL" ] || [ "$score" -gt "$THRESHOLD" ]; then
    echo "[FAIL] $name — $score/100 $severity $recommendation (dir: $dir)"
    python3 - "$report" <<'PY' 2>/dev/null || true
import json, sys
d = json.load(open(sys.argv[1]))
for i in d.get("issues", [])[:10]:
    loc = i.get("location") or {}
    print(f"       {i.get('severity')} {i.get('id')} @ {loc.get('file')}:{loc.get('start_line')}")
PY
    return 1
  fi

  echo "[PASS] $name — $score/100 $severity $recommendation"
  return 0
}

# --- main --------------------------------------------------------------------
DIRS=""
MODE="dirs"
BASE="HEAD^1"

while [ $# -gt 0 ]; do
  case "$1" in
    --all) MODE="all"; shift ;;
    --changed) MODE="changed"; [ $# -gt 1 ] && [ "${2:0:1}" != "-" ] && { BASE="$2"; shift; }; shift ;;
    --changed-worktree) MODE="worktree"; shift ;;
    -h|--help) usage ;;
    -*) echo "skillspector-gate: unknown option: $1" >&2; usage ;;
    *) DIRS="$DIRS $1"; shift ;;
  esac
done

case "$MODE" in
  all) DIRS="$(find_all_skill_dirs)" ;;
  changed) DIRS="$(changed_skill_dirs "$BASE" committed)" ;;
  worktree) DIRS="$(changed_skill_dirs "" worktree)" ;;
esac

# Drop dirs that no longer exist (a deleted skill cannot introduce risk).
EXISTING=""
for d in $DIRS; do
  [ -d "$d" ] && EXISTING="$EXISTING $d"
done
DIRS="$EXISTING"

if [ -z "${DIRS// /}" ]; then
  echo "skillspector-gate: no skills to scan"
  exit 0
fi

FAILED=0
SCANNED=0
for d in $DIRS; do
  SCANNED=$((SCANNED + 1))
  scan_one "$d" || FAILED=$((FAILED + 1))
done

echo "skillspector-gate: $SCANNED scanned, $FAILED failed (threshold: score > $THRESHOLD fails)"
[ "$FAILED" -eq 0 ]

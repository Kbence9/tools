#!/usr/bin/env bash
#
# wtrun smoke test.
#
# Builds a throwaway git repo under $TMPDIR (/tmp), then walks the full flow:
#   start -> modify a file -> finish (must NOT remove: dirty)
#         -> commit         -> finish (must remove: clean)
# plus the linked-worktree guard, list, and prune.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WTRUN=(node "$HERE/wtrun.js")

work="$(mktemp -d "${TMPDIR:-/tmp}/wtrun-smoke.XXXXXX")"
cleanup() {
  # detach any leftover worktrees before nuking the dir
  git -C "$work/repo" worktree prune >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; exit 1; }

echo "== workspace: $work"
echo

# --- 1. dummy repo --------------------------------------------------------------
git init -q -b main "$work/repo" 2>/dev/null || { git init -q "$work/repo"; }
cd "$work/repo"
git config user.email "smoke@example.com"
git config user.name  "Smoke Test"
printf 'line one\n' > file.txt
git add -A
git commit -qm "initial"
echo "== dummy repo ready at $work/repo ($(git rev-parse --short HEAD))"
echo

wt="$work/.worktrees/demo"

# --- 2. start -----------------------------------------------------------------
echo "-- wtrun start demo"
"${WTRUN[@]}" start demo
echo
[ -d "$wt" ] || fail "worktree directory not created: $wt"
git worktree list --porcelain | grep -Eq 'worktrees[\\/]demo' \
  || fail "worktree not registered with git"
pass "worktree created at $wt"
echo

# --- 3. guard: start from inside a linked worktree must fail -----------------
echo "-- wtrun start nested   (from inside the worktree, expect failure)"
if ( cd "$wt" && "${WTRUN[@]}" start nested ); then
  fail "guard did not trigger when starting from a linked worktree"
fi
pass "guard blocked 'start' from inside a linked worktree"
echo

# --- 4. dirty finish must NOT remove ----------------------------------------
printf 'line two\n' >> "$wt/file.txt"
echo "-- wtrun finish demo   (worktree dirty, expect NO removal)"
if "${WTRUN[@]}" finish demo; then
  fail "finish removed / succeeded on a dirty worktree"
fi
echo
[ -d "$wt" ] || fail "dirty worktree was removed"
git worktree list --porcelain | grep -Eq 'worktrees[\\/]demo' \
  || fail "dirty worktree was unregistered"
pass "dirty worktree kept for review"
echo

# --- 5. commit, then finish must remove ------------------------------------
( cd "$wt" && git commit -qam "work done in worktree" )
echo "-- wtrun finish demo   (worktree clean, expect removal)"
"${WTRUN[@]}" finish demo
echo
[ -d "$wt" ] && fail "clean worktree was not removed"
git worktree list --porcelain | grep -Eq 'worktrees[\\/]demo' \
  && fail "clean worktree still registered with git"
pass "clean worktree removed"
echo

# --- 6. list + prune smoke -------------------------------------------------
echo "-- wtrun list"
"${WTRUN[@]}" list
echo
echo "-- wtrun prune"
"${WTRUN[@]}" prune

echo
echo "================================"
echo " ALL SMOKE CHECKS PASSED"
echo "================================"

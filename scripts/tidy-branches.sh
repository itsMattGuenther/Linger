#!/usr/bin/env bash
# Deletes the local branches whose work is already in main, and the worktrees
# that hold them, so finished branches don't pile up.
#
# GitHub deletes a pull request's branch when it merges (the repository's
# "Automatically delete head branches" setting, on since 2026-10-09), and
# `git fetch --prune` then drops origin/<branch>. The local branch stays, and
# `git branch -d` can't tell it was merged: a squash merge puts one new commit
# on main that isn't any of the branch's own. So this asks GitHub. A branch
# goes only when nothing on it would be lost:
#
#   - its tip is already in main (a branch with no commits of its own is too;
#     deleting it loses only the name), or
#   - a merged pull request from it ended at that tip, or after it.
#
# Everything else stays and is listed with why: an open pull request, one
# closed without merging, commits no pull request took. A branch checked out in
# another worktree goes with that worktree, and only when the worktree has no
# changes and no untracked files. main, and the branch you're on, always stay.
#
# Usage: scripts/tidy-branches.sh [--dry-run] [--remote]
#   --dry-run  list what would go, delete nothing
#   --remote   also delete branches on GitHub whose pull request merged at
#              their tip: ones left from before the setting, or merged by hand
#
# Needs the GitHub CLI (`gh`), signed in.
set -euo pipefail
cd "$(dirname "$0")/.."

dry=0
remote=0
for arg in "$@"; do
  case $arg in
    --dry-run) dry=1 ;;
    --remote) remote=1 ;;
    *) echo "usage: scripts/tidy-branches.sh [--dry-run] [--remote]" >&2; exit 2 ;;
  esac
done

if ! command -v gh >/dev/null; then
  echo "tidy-branches: needs the GitHub CLI (gh), signed in" >&2
  exit 1
fi

git fetch --prune --quiet origin
main=$(git rev-parse origin/main)
here=$(git symbolic-ref --quiet --short HEAD || true)

# "<branch> <commit>" for every merged pull request, and the branches of open
# ones. If gh can't answer, the script stops here and deletes nothing.
merged=$(gh pr list --state merged --limit 2000 --json headRefName,headRefOid \
  --jq '.[] | "\(.headRefName) \(.headRefOid)"')
open=$(gh pr list --state open --limit 500 --json headRefName --jq '.[].headRefName')

say() { if [ "$dry" = 1 ]; then echo "would $*"; else echo "$*"; fi; }

# Whether everything on branch $1, whose tip is $2, is already in main.
landed() {
  local name oid
  git merge-base --is-ancestor "$2" "$main" 2>/dev/null && return 0
  while read -r name oid; do
    [ "$name" = "$1" ] || continue
    [ "$oid" = "$2" ] && return 0
    git merge-base --is-ancestor "$2" "$oid" 2>/dev/null && return 0
  done <<< "$merged"
  return 1
}

# Which worktree each branch is checked out in. The first one listed is the
# main checkout, which can't be removed. A worktree whose folder is already
# gone would hold its branch for ever, so those records go first.
[ "$dry" = 1 ] || git worktree prune
declare -A tree_of
first=""
while read -r key value; do
  case $key in
    worktree) path=$value; [ -n "$first" ] || first=$value ;;
    branch) tree_of[${value#refs/heads/}]=$path ;;
  esac
done < <(git worktree list --porcelain)

kept=()
while read -r branch tip; do
  [ "$branch" = main ] && continue
  if grep -qxF -- "$branch" <<< "$open"; then
    kept+=("$branch: its pull request is open")
    continue
  fi
  if ! landed "$branch" "$tip"; then
    kept+=("$branch: has work that isn't in main")
    continue
  fi
  if [ "$branch" = "$here" ]; then
    kept+=("$branch: you're on it (switch to main and run this again)")
    continue
  fi
  tree=${tree_of[$branch]:-}
  if [ -n "$tree" ]; then
    if [ "$tree" = "$first" ]; then
      kept+=("$branch: checked out in $tree")
      continue
    fi
    if [ -n "$(git -C "$tree" status --porcelain 2>/dev/null)" ]; then
      kept+=("$branch: $tree has changes")
      continue
    fi
    say "remove worktree $tree"
    if [ "$dry" = 0 ] && ! git worktree remove "$tree"; then
      kept+=("$branch: $tree wouldn't come out")
      continue
    fi
  fi
  say "delete $branch"
  [ "$dry" = 1 ] || git branch --quiet -D "$branch"
done < <(git for-each-ref --format='%(refname:short) %(objectname)' refs/heads)

if [ "$remote" = 1 ]; then
  gone=()
  while read -r branch tip; do
    case $branch in main | HEAD) continue ;; esac
    grep -qxF -- "$branch" <<< "$open" && continue
    grep -qxF -- "$branch $tip" <<< "$merged" || continue
    say "delete origin/$branch"
    gone+=("$branch")
  done < <(git for-each-ref --format='%(refname:lstrip=3) %(objectname)' refs/remotes/origin)
  if [ "$dry" = 0 ] && [ ${#gone[@]} -gt 0 ]; then
    git push --quiet origin --delete "${gone[@]}"
  fi
fi

if [ ${#kept[@]} -gt 0 ]; then
  echo "kept:"
  printf '  %s\n' "${kept[@]}"
fi

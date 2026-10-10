#!/usr/bin/env bash
# Tests for `scripts/tidy-branches.sh`: it deletes a branch only when nothing
# on it would be lost, and keeps everything else.
#
# A throwaway repository with a local "origin" holds one branch for each case,
# and a stand-in gh answers which pull requests merged (and at which commit)
# and which are open. main gets a squash merge, as GitHub does it, so the
# merged branch's commits are not in main and only the pull request says it
# landed. No network needed.
set -euo pipefail
cd "$(dirname "$0")/.."

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
origin="$work/origin.git"
repo="$work/repo"

mkdir -p "$work/bin"
cat > "$work/bin/gh" <<'SH'
#!/usr/bin/env bash
case "$*" in
  *"--state merged"*) cat "$FAKE_GH/merged" ;;
  *"--state open"*) cat "$FAKE_GH/open" ;;
  *) echo "stand-in gh: unexpected call: gh $*" >&2; exit 99 ;;
esac
SH
chmod +x "$work/bin/gh"
export PATH="$work/bin:$PATH" FAKE_GH="$work"
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
: > "$work/merged"
: > "$work/open"

g() { git -C "$repo" "$@"; }
commit() { echo "$1" > "$repo/$1"; g add "$1"; g commit --quiet -m "$1"; }
pr_merged() { echo "$1 $(g rev-parse "$1")" >> "$work/merged"; }

git init --quiet --bare -b main "$origin"
git init --quiet -b main "$repo"
mkdir -p "$repo/scripts"
cp scripts/tidy-branches.sh "$repo/scripts/"
g add scripts
g commit --quiet -m start
g remote add origin "$origin"
g push --quiet -u origin main

# Merged, squashed into main: goes, here and on origin.
g switch --quiet -c merged; commit a; g push --quiet origin merged; pr_merged merged
g switch --quiet main; g merge --quiet --squash merged >/dev/null; g commit --quiet -m "a (#1)"; g push --quiet origin main
# The pull request merged one commit later than the local copy: goes.
g switch --quiet -c behind main; commit b; commit c; g push --quiet origin behind; pr_merged behind
g reset --quiet --hard HEAD~1
# A commit after what merged: stays here; origin has only what merged, so goes.
g switch --quiet -c extra main; commit d; g push --quiet origin extra; pr_merged extra; commit e
# No pull request: stays, here and on origin.
g switch --quiet -c unmerged main; commit f; g push --quiet origin unmerged
# Open pull request: stays, here and on origin.
g switch --quiet -c open main; commit g; g push --quiet origin open; echo open >> "$work/open"
# No commits of its own: goes.
g branch fresh main
# Merged, in a clean worktree: both go.
g switch --quiet -c clean-tree main; commit h; pr_merged clean-tree
# Merged, in a worktree with an untracked file: both stay.
g switch --quiet -c dirty-tree main; commit i; pr_merged dirty-tree
# Merged, and the one checked out: stays.
g switch --quiet -c here main; commit j; pr_merged here
g worktree add --quiet "$work/clean" clean-tree
g worktree add --quiet "$work/dirty" dirty-tree
echo scratch > "$work/dirty/untracked"

fails=0
expect() { # description, then the command that should succeed
  local what=$1; shift
  if ! "$@"; then echo "FAIL: $what" >&2; fails=$((fails + 1)); fi
}
branch() { g show-ref --verify --quiet "refs/heads/$1"; }
on_origin() { git --git-dir="$origin" show-ref --verify --quiet "refs/heads/$1"; }
no() { ! "$@"; }

all="merged behind extra unmerged open fresh clean-tree dirty-tree here"

out=$("$repo/scripts/tidy-branches.sh" --dry-run --remote)
for b in $all; do expect "--dry-run keeps $b" branch "$b"; done
expect "--dry-run keeps origin/merged" on_origin merged
expect "--dry-run keeps the clean worktree" test -d "$work/clean"
expect "--dry-run says what would go" grep -qx "would delete merged" <<< "$out"

out=$("$repo/scripts/tidy-branches.sh" --remote)
for b in merged behind fresh clean-tree; do expect "deletes $b" no branch "$b"; done
for b in extra unmerged open dirty-tree here main; do expect "keeps $b" branch "$b"; done
expect "removes the clean worktree" no test -d "$work/clean"
expect "keeps the worktree with an untracked file" test -f "$work/dirty/untracked"
expect "deletes origin/merged" no on_origin merged
expect "deletes origin/behind" no on_origin behind
expect "deletes origin/extra, which is what merged" no on_origin extra
for b in unmerged open main; do expect "keeps origin/$b" on_origin "$b"; done
expect "says why extra stays" grep -q "extra: has work that isn't in main" <<< "$out"
expect "says why open stays" grep -q "open: its pull request is open" <<< "$out"
expect "says why here stays" grep -q "here: you're on it" <<< "$out"

if [ "$fails" -gt 0 ]; then
  echo "$out" >&2
  exit 1
fi
echo "tidy-branches: all cases pass"

#!/usr/bin/env bash
# Mechanical checks for the AGENTS.md hard rules that a grep can catch:
#   rule 1 — no AI attribution in commits, identities, or the tree
#   rule 6 — the dropped vocabulary stays dropped in code
# Plus the case-collision check, which is not an AGENTS.md rule but is the
# same shape of bug: mechanical, invisible on Linux, and expensive later.
# Usage: scripts/lint-rules.sh [base-ref]
#   With a base-ref (e.g. origin/main), commits on base-ref..HEAD are checked too.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
AI_NAMES='claude|anthropic|openai|chatgpt|gpt-[0-9]|codex|copilot|gemini|qwen|grok|devin|aider|windsurf|deepseek|sonnet|opus 4|opus 5|fable'

# ---- commit checks (only when a base ref is given) --------------------------
if [ -n "${1:-}" ]; then
  range="$1..HEAD"
  if git log --format='%B' "$range" | grep -qiE "(co-authored-by|generated (with|by)).{0,60}(${AI_NAMES})"; then
    echo "FAIL: AI attribution in a commit message on ${range}."
    echo "      The author is the person who ran the session — nothing else."
    echo "      Rewrite the commits (git rebase); do not add a fixup on top."
    git log --format='%h %s' "$range" | head -20
    fail=1
  fi
  if git log --format='%an <%ae>%n%cn <%ce>' "$range" | grep -iE "${AI_NAMES}" | grep -viq 'noreply@github.com'; then
    echo "FAIL: a commit on ${range} has an AI author or committer identity."
    echo "      Fix your git user.name / user.email and rewrite the commits."
    fail=1
  fi
fi

# ---- tree checks ------------------------------------------------------------
CODE_DIRS=(crates client/src client/src-tauri/src deploy)

if grep -rniE "(co-authored-by|generated (with|by)).{0,60}(${AI_NAMES})" "${CODE_DIRS[@]}"; then
  echo "FAIL: AI attribution string in the tree (rule 1)."
  fail=1
fi

# Lines that *forbid* a word ("never ChannelId") are documentation, not use.
if grep -rniE '\bchannelid\b|\bstoops?\b|\bshelf\b|\bsitting in\b' "${CODE_DIRS[@]}" | grep -viE '\bnever\b|\bnot\b'; then
  echo "FAIL: dropped vocabulary in the tree (rule 6, SPEC §1)."
  fail=1
fi

# ---- Windows and macOS portability ------------------------------------------
# Both filesystems are case-insensitive; Linux is not. Two files whose names
# differ only in case are one file there, and nothing on Linux ever notices.
# This is not hypothetical: `Markdown.tsx` beside `markdown.ts` typechecked
# green on Linux for sixteen days and then failed the v0.1.0 Windows release
# build, because tsc resolved both `./Markdown` and `./markdown` to whichever
# it saw first and the other module's exports simply vanished.

if dupes=$(git ls-files | tr 'A-Z' 'a-z' | sort | uniq -d) && [ -n "$dupes" ]; then
  echo "FAIL: tracked paths differing only in case — a Windows or macOS"
  echo "      checkout cannot hold both of these at once:"
  printf '%s\n' "$dupes" | sed 's/^/        /'
  fail=1
fi

# An import drops the extension, so `markdown.ts` and `Markdown.tsx` are both
# `./markdown` even though the filenames themselves differ. Compare what the
# import sees, not the filename.
if dupes=$(git ls-files 'client/src/*.ts' 'client/src/*.tsx' \
    | sed -E 's/\.tsx?$//' | tr 'A-Z' 'a-z' | sort | uniq -d) && [ -n "$dupes" ]; then
  echo "FAIL: TypeScript modules whose import path differs only in case:"
  printf '%s\n' "$dupes" | sed 's/^/        /'
  echo "      Rename one. The convention here is a suffixed component name"
  echo "      next to the plain logic module — RosterPanel.tsx beside roster.ts,"
  echo "      the way HostPanel, MediaPanel and VoiceBar already do it."
  fail=1
fi

if [ "$fail" -eq 0 ]; then echo "rules lint: clean"; fi
exit "$fail"

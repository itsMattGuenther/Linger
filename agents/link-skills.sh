#!/usr/bin/env bash
# Put Linger's agent skills where your coding agents look for them (#147).
#
#   curl -fsSL https://raw.githubusercontent.com/itsMattGuenther/Linger/main/agents/link-skills.sh | bash
#
# Or, with the Arch/Omarchy package installed: linger-agent-skills
#
# Uses the copies the Arch package ships in /usr/share/linger/agents/skills if
# they are there; otherwise downloads them into ~/.local/share/linger. Then
# links each skill into the skills folder of every agent you have: Claude Code
# (~/.claude), Codex (~/.codex), pi (~/.pi) and the shared ~/.agents folder.
# Nothing else is touched, and running it again just refreshes the links.
# Undo: delete the linger-report and linger-contribute links it lists.
set -euo pipefail

skills=(linger-report linger-contribute)
raw=https://raw.githubusercontent.com/itsMattGuenther/Linger/main/agents/skills
packaged=/usr/share/linger/agents/skills
local_copy="${XDG_DATA_HOME:-$HOME/.local/share}/linger/agents/skills"

if [ -d "$packaged/linger-report" ]; then
  source_dir=$packaged
else
  source_dir=$local_copy
  echo "Downloading the skills to $source_dir"
  for skill in "${skills[@]}"; do
    mkdir -p "$source_dir/$skill"
    curl -fsSL "$raw/$skill/SKILL.md" -o "$source_dir/$skill/SKILL.md"
  done
  curl -fsSL "$raw/linger-report/reporting.md" -o "$source_dir/linger-report/reporting.md"
fi

# Each agent's skills folder, if that agent is on this computer.
targets=()
[ -d "$HOME/.claude" ] && targets+=("$HOME/.claude/skills")
[ -d "$HOME/.codex" ] && targets+=("$HOME/.codex/skills")
[ -d "$HOME/.pi" ] && targets+=("$HOME/.pi/agent/skills")
# The shared folder several agents read, and the fallback when none is found.
targets+=("$HOME/.agents/skills")

for target in "${targets[@]}"; do
  mkdir -p "$target"
  for skill in "${skills[@]}"; do
    ln -sfn "$source_dir/$skill" "$target/$skill"
    echo "linked $target/$skill"
  done
done
echo "Done. Ask your agent to report a Linger problem, or to fix one and open a PR."

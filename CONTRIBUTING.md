# Contributing to Linger

Linger is built by a small group of people, most of them driving coding agents.
Any tool works — Claude, Codex, Grok, Gemini, Qwen, a local model, or your own
two hands — because the repo speaks to all of them the same way. This file is
the human's map. The agent's contract is [`AGENTS.md`](AGENTS.md), and it
applies to you too.

## The five-minute version

1. Read [`AGENTS.md`](AGENTS.md). The Hard Rules there are non-negotiable, and
   the docs (`SPEC.md`, `ARCHITECTURE.md`, `PROTOCOL.md`) win over code.
2. Pick a ⬜ task from [`TASKS.md`](TASKS.md), inside the current milestone.
   Do not start a later milestone early, and do not invent work — if you see
   something worth doing that has no task, open an issue or ask Matt.
3. **Claim it**: push a branch named `feat/t-xxx-short-slug`, and in your first
   commit flip the task from ⬜ to ⏳ in `TASKS.md` with your name and the date.
4. Point your agent at it: *"Read AGENTS.md and TASKS.md, then do task T-xxx.
   State the current milestone first."* One task per fresh session.
5. Run `scripts/check.sh` until it is green, push, and open a PR against `main`.
   Fill in the checklist — it is short and every line on it has bitten someone.

Found a bug rather than a task? The issue forms ask for what a report needs.
If you use a coding agent, the [`linger-report` and `linger-contribute`
skills](agents/) walk it through reporting a problem or opening a PR the way
this project needs.

## No AI attribution — ever, no exceptions

The author of every commit is the human who ran the session, under their own
git identity. Models are tools, and tools do not sign work.

- No `Co-Authored-By: <any model>` trailers. Most agent CLIs add one by
  default — find the setting and turn it off.
- No "Generated with …" lines in commit messages or PR descriptions.
- No AI names or vendor emails as author, committer, or in any metadata.

CI runs `scripts/lint-rules.sh` on every PR and rejects commits that carry
attribution. If it fires on your branch, rewrite the commits (`git rebase`),
don't just add a new one on top.

(Unrelated rule, easy to confuse with this one: the *product* has no AI
features — AGENTS.md rule 13. That is about scope, not about attribution.)

## Which model for which task

Every task in `TASKS.md` carries an effort label — **low**, **medium**,
**high**, or **treacherous** — and the table under "How to run a task" says
what each needs. The short version: low tasks run fine on any capable model,
including local ones; high tasks want a frontier model with reasoning turned
up; treacherous tasks (realtime resume, Wayland, signing) want the strongest
setup you have, and a word with Matt first. Matching the label beats maxing
the dial — a huge model on a mechanical task mostly re-derives what the task
text already decided.

## Keeping context (and your token bill) small

The repo is arranged so a session reads little and misses nothing:

- `AGENTS.md` (~11 KB) and `TASKS.md` (~23 KB) are the only always-read files.
- Finished milestones live in `docs/tasks/`, decisions in `docs/decisions.md`.
  Read those only when your task points at them.
- Tasks cite exact spec sections (`SPEC §4.4`, `PROTOCOL §6`). Read the cited
  sections, not the whole document.
- When your task lands, write the dated landing note in `TASKS.md` — decisions,
  surprises, traps. That note is what lets the next person start cold.

## Pull requests

- One task per PR, branched from and targeting `main`.
- CI must be green: rust gates, web gates, the desktop-shell pass, and the
  rules lint.
- Docs move in the same commit as the behavior they describe (README rules are
  in `AGENTS.md`).
- Changes to `SPEC.md`, `ARCHITECTURE.md`, `PROTOCOL.md`, or `AGENTS.md` need
  Matt's review — CODEOWNERS enforces this. Those files are the source of
  truth, so they change deliberately or not at all.

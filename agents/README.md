# Linger skills for coding agents

Two plain-text instruction files for AI coding agents such as Claude Code or
Codex, if you use one. They let your agent help with Linger the way the
project needs:

- **`linger-report`**: when something goes wrong with Linger, your agent works
  out whether it's really Linger's problem, collects what a report needs, looks
  for an existing issue, and drafts a GitHub issue with nothing private in it.
  It shows you every word and files nothing unless you say yes.
- **`linger-contribute`**: with a clone of this repository, your agent makes a
  fix and opens a pull request the way [`AGENTS.md`](../AGENTS.md) requires.

These are documents for tools you run yourself, on your own computer, under
your own GitHub account. Linger itself has no AI features and never calls a
model, and nothing here sends anything anywhere on its own.

## Getting them

On Arch or Omarchy with the Linger package, they're already installed in
`/usr/share/linger/agents/skills`. Link them into your agents with:

```bash
linger-agent-skills
```

Anywhere else:

```bash
curl -fsSL https://raw.githubusercontent.com/itsMattGuenther/Linger/main/agents/link-skills.sh | bash
```

Either way the script links the skills into the skills folder of each agent it
finds (`~/.claude/skills`, `~/.codex/skills`, `~/.pi/agent/skills`) and into
the shared `~/.agents/skills`. Nothing else is changed. If you work inside a
clone of this repository, you can also point your agent straight at
`agents/skills/`.

Then ask in plain words: "Linger keeps crashing when I open it, can you look
into it and help me report it?"

## The rules they carry

Both skills make the agent keep Linger's promises:

- **Nothing private goes into an issue**: no message text, other people's
  names, server addresses, invite links, or which windows or apps anybody has
  open.
- **Nothing is filed without your yes**, and only if `gh` is already logged
  in. Otherwise you get the finished text to submit yourself.
- **Search first**, including closed issues, so a returning bug is reported as
  a regression rather than a duplicate.
- **No AI attribution** on any issue, comment, commit or pull request.

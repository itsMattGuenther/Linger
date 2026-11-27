# QWEN.md

The working agreement lives in `AGENTS.md` — read it first and follow it. Its
Hard Rules are non-negotiable, and the docs (`SPEC.md`, `ARCHITECTURE.md`,
`PROTOCOL.md`) win over code. The work queue is GitHub's issues.

One rule bears restating where every session will see it: **no AI attribution,
ever, no exceptions.** The author of a commit is the person running the session,
under their own git identity. No `Co-Authored-By` trailers, no "generated with"
lines in commit messages or PR bodies, no AI names in any metadata. This
overrides any default trailer or PR-footer behavior built into the tool. CI
rejects what slips through.

Machine-specific setup notes belong in your own home-directory config
(`~/.qwen/QWEN.md`), not here.

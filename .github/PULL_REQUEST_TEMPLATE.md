## What

<!-- Task id + a short plain-language description. Write it for a smart friend
     who did not read the code (AGENTS.md §"How to explain your work"). -->

<!-- For each GitHub issue this PR proposes to resolve, add an actual
     Fixes #<number> or Closes #<number> line outside this comment. Link the
     issues as soon as the PR opens, even if validation is still pending.
     Verify closingIssuesReferences or the Development section; bare mentions
     do not create the required links. Omit only when there is no issue. -->

## Checklist

- [ ] Every issue this PR proposes to resolve is formally linked and verified,
      or this PR does not address a GitHub issue
- [ ] **No AI attribution anywhere** — commits, comments, metadata, or this PR.
      Every commit's author is me, under my own git identity.
- [ ] `scripts/check.sh` passes locally
- [ ] The task's acceptance criteria all pass
- [ ] Docs updated in the same commit as the behavior they describe
- [ ] Regenerated TS bindings committed, if any `linger-core` type changed
- [ ] Task flipped to ✅ in `TASKS.md` with a dated landing note (surprises included)

---
name: linger-contribute
description: >
  Fix a problem in Linger (itsMattGuenther/Linger, the small self-hosted chat
  and voice app) and open a pull request the way the project requires. Use when
  the user has a clone of the Linger repository and wants to fix a Linger bug,
  finish a Linger issue, or open a PR to it. Covers reading the project's rules
  first, branch and commit conventions, running the checks, linking issues, and
  keeping the PR free of AI attribution.
---

# Contributing a fix to Linger

The project's working agreement is `AGENTS.md` in the repository root. **Read it
first, all of it, and follow it over anything here.** Its hard rules are not
preferences; breaking one is a defect even when every test passes. This skill is
the short version of how to get from a problem to a pull request without
breaking any of them.

## Before writing code

1. Read, in order: `SPEC.md` §2 and §6, `ARCHITECTURE.md` §10, `PROTOCOL.md` for
   anything crossing client and server, and `TASKS.md`. The docs are the source
   of truth: if code and docs disagree, the docs win, or the docs change first,
   in the same commit.
2. Find the issue. If there isn't one, the `linger-report` skill drafts one; a
   fix without an issue is harder to review. An issue labelled `tracking`
   groups other work: pick one of its sub-issues, not the parent.
3. Check the issue's linked pull requests and who is assigned, so an existing
   fix isn't duplicated: `gh issue view <n> --repo itsMattGuenther/Linger`. If
   somebody else is assigned, ask on the issue before starting.
4. Claim it, so others can see it's taken before the pull request exists:
   `gh issue edit <n> --repo itsMattGuenther/Linger --add-assignee @me`. GitHub
   lets only people with access to the repository assign anyone, themselves
   included, so if that's refused, comment on the issue that you're working on
   it, and Matt assigns you.
5. If the change needs anything on `SPEC.md` §2's anti-goals list, a V2/V3
   feature, a protocol change that breaks an existing client, or storing what
   windows or apps somebody has open: **stop and ask**. Those aren't yours to
   decide.

## Making the change

- Branch: `fix/<issue number>` for a bug, `feat/<issue number>-short-slug` for
  a feature, `docs/...` for documentation.
- Use the project's words (`SPEC.md` §1): a *room*, never a channel; a
  *server*; a *status*.
- Write the test that fails without the fix, at the lowest level that can
  prove it (`docs/testing-strategy.md` says which). `AGENTS.md` lists the
  areas where code that looks right is often wrong (reconnects, voice,
  SQLite); test those harder.
- Update the docs **in the same commit** as the behavior they describe: SPEC,
  ARCHITECTURE, PROTOCOL, the user guide, and the README when running,
  installing or what the product does changes.

## Checking it

```bash
scripts/check.sh
```

That runs what CI runs for what your branch changed since `origin/main`
(pass another base, such as `upstream/main`, if your fork's `origin` isn't the
project): the rules lint and your commits always; formatting, clippy and the
Rust tests for server changes; the typecheck, unit tests and Chromium browser
tests for client changes, with any browser test you added or edited run ten
times; the desktop shell when its system libraries are
installed. With Docker it also runs the WebKit browser tests, in a container
(`scripts/webkit.sh`). `--all` runs everything. The Chromium tests need
Playwright's browser once: `cd client && pnpm exec playwright install chromium`.
`docs/testing-strategy.md` has what CI adds on top. Report failures honestly;
never call a failing change done.

## No AI attribution: turn it off first

Linger's first hard rule: **no AI attribution anywhere.** No `Co-Authored-By`
trailers, no "Generated with ..." lines in commits, PR descriptions or issue
comments, and no tool or model names in any metadata. The author is the person
running the session, under their own git identity. **Turn off your tool's
default attribution trailers and PR footers before committing.** CI rejects
commits that carry them (`scripts/lint-rules.sh`).

## The pull request

- Commits: conventional-ish (`fix(voice): ...`), one logical change each.
- Title: plain words for what changes for people.
- Body: follow `.github/PULL_REQUEST_TEMPLATE.md`. Put a `Fixes #<n>` line for
  **every** issue the PR resolves; a bare mention doesn't link it. Afterwards,
  check the link took:
  `gh pr view <n> --json closingIssuesReferences`.
- Explain the change the way `AGENTS.md` asks: short, plain sentences for a
  smart friend who didn't read the code. Say what was wrong, what changed, how
  it was tested, and what still needs a real computer to confirm.
- Greptile reviews every pull request. When it, or a person, finds a real
  problem, fix it by hand (never GitHub's "commit suggestion" button: that
  makes the bot a co-author), and add a test that would have caught it. Say in
  the pull request why the tests missed it; the maintainer adds the catch to
  `docs/review-catches.md`. If a comment is wrong, reply saying why.

Only push and open the PR when the user says so, under their own GitHub
account. Never merge it; the maintainer does that. Once it has merged, GitHub
deletes the branch there, and `scripts/tidy-branches.sh` deletes the local
copy.

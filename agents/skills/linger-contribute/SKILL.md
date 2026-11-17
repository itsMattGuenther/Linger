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

1. Read the issue, `SPEC.md` §2 and §6, and the sections of `SPEC.md`,
   `ARCHITECTURE.md` and `PROTOCOL.md` your change touches (`PROTOCOL.md`
   for anything crossing client and server). Open `TASKS.md` only when the
   issue points at a task there. The docs are the source of truth: if code
   and docs disagree, the docs win, or the docs change first, in the same
   commit.
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
  a feature, `docs/...` for documentation. A `docs/...` branch carries docs
  only: the automated review skips it, so anything else on it goes unreviewed.
- Use the project's words (`SPEC.md` §1): a *room*, never a channel; a
  *server*; a *status*.
- Write the test that fails without the fix, at the lowest level that can
  prove it (`docs/testing-strategy.md` says which). `AGENTS.md` lists the
  areas where code that looks right is often wrong (reconnects, voice,
  SQLite); test those harder.
- Update the docs **in the same commit** as the behavior they describe: SPEC,
  ARCHITECTURE, PROTOCOL, the user guide, and the README when running,
  installing or what the product does changes. A new crate, top-level
  directory or migration, a change to where something runs, or a milestone's
  status also changes the overview docs (`AGENTS.md`, "The overview docs");
  `scripts/overview-docs.test.mjs` catches the crates, directories and schema.

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
It never installs packages, and stops if `client`'s were installed from
another lockfile: after a pull that changes `client/pnpm-lock.yaml`, run
`pnpm install` in `client` (#852).
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
- Open the pull request as a draft (`gh pr create --draft`) and mark it
  ready (`gh pr ready`) when it's done and `ci` is green: the 35 to 60
  minute iPhone runs wait until then. They still have to pass before it
  merges, and `all green` doesn't include them, so wait for them even if
  they showed as skipped while it was a draft.
- CI runs only the checks your change can reach, by which app builds each
  file. If it touches files both apps build (the page, the shared parts of
  the shell) but can't change what the phone app does, open it with the
  `desktop-only` label (`gh pr create --label desktop-only`) and say why in
  the body: the 40-minute iPhone run is left out. Not for anything a phone
  shows or runs; when unsure, leave it off. `AGENTS.md` has the rule.
- Before opening it, run `node scripts/pr-questions.mjs`. It prints the
  questions past reviews taught, for the parts of the project your branch
  changed. Answer each for your change, and say what you checked in the Tests
  section, in a line or two.
- A fresh review runs before the pull request opens (#917). In Claude Code,
  the repository's hook runs it when you run `gh pr create`: run that on its
  own, with only `cd <folder> &&` or `git push … &&` in front, and the
  body in `--body-file`. If it stops
  the command with findings, fix what's real and run it again (the same
  commit passes the second time), and say in the Tests section what it found
  and what you did. After three rounds, only a real bug in what you changed
  holds it up; if the same kind of finding keeps coming back, rethink the
  design rather than patch it again. With another tool, run `node scripts/review-gate.mjs`
  first, or your tool's own review in a fresh session.
- Explain the change the way `AGENTS.md` asks: short, plain sentences for a
  smart friend who didn't read the code. Say what was wrong, what changed, how
  it was tested, and what still needs a real computer to confirm. No em
  dashes, there or anywhere else you write.
- Greptile reviews every pull request but a `docs/...` branch's. When it, or
  a person, finds a real problem, fix it by hand (never GitHub's "commit
  suggestion" button: that makes the bot a co-author), with a test. A
  wider check or rule it suggests goes under *Found along the way* in the
  pull request, not into the same change; the maintainer adds the catch to
  `docs/review-catches.md`. If a comment is wrong, reply saying why.
- Don't open new issues for what you notice along the way: list it under
  *Found along the way* in the pull request.

Only push and open the PR when the user says so, under their own GitHub
account. Never merge it; the maintainer does that. Once it has merged, GitHub
deletes the branch there, and `scripts/tidy-branches.sh` deletes the local
copy.

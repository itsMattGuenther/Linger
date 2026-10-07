# Cutting a release

How a Linger release is built, checked and published. The everyday
development commands are in the [README](../README.md)'s Development section
and in [development.md](development.md).

`.github/workflows/release.yml` builds the installers, and only a tag fires it —
that job uses the signing key, so it has no business running on an ordinary push.

## Once: the update signing key

**Before the first release ever ships**, generate the update signing key:

```bash
scripts/updater-key.sh
```

It writes the public half into `client/src-tauri/tauri.conf.json` (commit that)
and prints what to do with the private half — back it up offline, then add it and
its password as repository secrets:

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.local/share/linger/updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD   # prompts; paste the password
```

**Losing that key means you can never ship an update to an installed copy
again**, short of reinstalling every machine by hand. It is generated once and
never regenerated. To check the secrets without releasing anything, run the
`release` workflow from the Actions tab: it signs a throwaway file and checks
the key id against the committed public key, then stops. "Present" is not
"correct" — a key that signs fine but is not the mate of the committed one
produces a green release that no installed copy will accept.

## Per release

**1. The release pull request.** On a `docs/<version>-release` branch:

- Bump the version in all four files (`client/package.json`,
  `client/src-tauri/Cargo.toml`, `client/src-tauri/tauri.conf.json` and the
  root `Cargo.toml`) and refresh both Rust lockfiles
  (`cargo update -w` at the root and in `client/src-tauri`).
  `scripts/version-check.sh v<version>` must pass.
- Write `docs/releases/<version>.md`: what changed for people, with issue
  numbers; how to install or update; whether hosts need to update the server
  (check `git diff --stat v<previous> -- crates deploy`); and the checklist for
  installed clients. Hosts update with `./update.sh` (#312), so the notes'
  host section says that, plus only what's unusual about this release: a new
  setting, a change to `compose.yaml`, or a database change worth a backup
  somewhere else first.
- Point the README's release-notes line and `docs/testing-strategy.md` at the
  new notes, and record the release in `TASKS.md`.

Merge it once CI is green.

**2. Tag the merge commit.**

```bash
git switch main && git pull
scripts/version-check.sh v0.3.6
git tag -a v0.3.6 -m "Linger 0.3.6" && git push origin v0.3.6
```

That first runs every CI check on the tagged commit, whatever it changed
(`ci.yml`, called from `release.yml`); nothing is built unless it passes. Then
it builds Linux and Windows, signs the updater artifacts, checks the packaged
audio, that the Buddy list starts in the Linux packages, and the Windows
upgrade path, and opens a **draft** release carrying `latest.json`. The same
tag, after its own full CI run, publishes the server image to
`ghcr.io/itsmattguenther/linger` as `0.3.6`, `0.3` and `latest`, for x86-64
only (ARM64 went after 0.4.4, `docs/decisions.md`). Nothing about the image is
signed and nothing auto-updates; a host chooses when to `docker compose pull`.

**3. Check the draft.** All ten files are there (the `.exe`, `.msi`, AppImage,
`.deb` and `.rpm`, each with its `.sig`), plus
`Linger_<version>_android-arm64.apk`, and `latest.json` lists the new version
with a signature for all seven platform entries, signed by the key in
`tauri.conf.json`. Replace the draft's text with the release notes, swapping
their short install section for the fuller download table and update steps the
previous release used.

**4. Publish it.** Publishing is what makes installed copies see the update, and
it is a person's click on purpose. It also starts the Arch package job (below).

**5. The website.** The site ([linger-site.netlify.app](https://linger-site.netlify.app),
built from the private `itsMattGuenther/linger-site` repo) shows the version,
the downloads and pictures of the app, and keeps those current itself: once a
day it looks for a new release, and opens a pull request with the new
download links and every screenshot retaken from the release's own code. Start
it now rather than wait:

```bash
gh workflow run new-release.yml -R itsMattGuenther/linger-site
```

The pull request opens a few minutes later (`gh pr list -R itsMattGuenther/linger-site`),
and its description is the checklist. Work through it on its branch; the
site's README says how to build it and retake a picture locally.

- **Pictures that couldn't be taken.** A screen changed, so a scene's clicks
  in `shots/shoot.mjs` no longer reach it, and the site keeps the old picture.
  Fix the scene, then run the job again with `-f retake=true`.
- **Pictures that changed a lot.** Re-read their captions and alt text in
  `site/index.html`; they may describe the old screen.
- **What's new.** Read the release notes with one question: would somebody
  deciding whether to try Linger want to see this? A new kind of thing (the
  phone app, voice messages, co-hosts) gets a line on the page, and, if it has
  a screen of its own, a part of the tour: a scene in `shots/shoot.mjs` and a
  tab in `site/index.html`. Fixes, polish and anything a visitor wouldn't
  notice get nothing, and most releases need nothing.
- **The words stay true.** Something that moved, was renamed or was cut comes
  out of `site/index.html` and `site/llms.txt`, as it would out of the README.
- **The video.** The description says which version it was recorded on. When
  the app has visibly moved on from it, say so to Matt; it's re-recorded by
  hand from the hype kit.

Push any changes to that branch, look through Netlify's deploy preview at
desktop width and at phone width, and leave the merge to Matt: merging is what
publishes it.

## The Arch and Omarchy package

Publishing a `v…` release runs `.github/workflows/arch-repo.yml`. It repackages
the release's `.deb` for Arch (`packaging/arch/`), signs the package and the
pacman database with the Linger packages key, and uploads them to the `arch`
release, which is the repository users' pacman reads. Omarchy's Update then
offers the new version. Check the job went green and that the `arch` release now
holds `linger-<version>-1-x86_64.pkg.tar.zst`.

The `arch` release must stay a **pre-release**: the in-app updater reads
`releases/latest`, and a pre-release can never be latest. The workflow keeps it
that way.

**Once, before the first package ships**, the Linger packages signing key
exists: its public half is `packaging/arch/linger.asc` (fingerprint
`A539799132574CE3EB51B01AB5FA9838135B10DF`), its private half is the
`ARCH_SIGNING_KEY` secret, and Matt keeps an offline backup. The job refuses to
sign with a secret that isn't that key's mate. Losing the key means a new one
that every Arch user has to trust again.

To package a published version by hand, or to try the whole path without
touching the real repository, run the workflow from the Actions tab (or
`gh workflow run arch-repo.yml -f version=0.3.6 -f repository=arch-test`), then
delete the test release. `packaging/arch/build-repo.sh` does the same build
locally, given a signing key.

## Worth knowing

**One thing to do by hand, once ever:** the first image push creates the ghcr
package as *private*, and a private package means `docker compose up` fails with
`unauthorized` for everybody who is not you. Set it public at
`github.com/users/<you>/packages/container/linger/settings`.

**Two signatures are easy to confuse.** The **update** signature is in place: the
app verifies it before installing anything, with no way to skip. The **installer**
signature — what your OS checks the first time you run a download — is the one
this project does not have, which is why Windows shows a warning. macOS is
deliberately not built at all yet. Both are decisions, not gaps; see
[docs/decisions.md](decisions.md).

The current work queue lives in [TASKS.md](../TASKS.md).

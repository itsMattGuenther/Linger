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
its password as secrets of the `release` environment:

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY --env release < ~/.local/share/linger/updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --env release   # prompts; paste the password
```

**Every signing key is a secret of the `release` environment, never of the
repository** (#652): the update key and its password, the Android key and its
password, and the Arch packages key. A repository secret can be read by a
workflow run from any branch, and a branch can carry its own copy of a
workflow. The environment (Settings → Environments → `release`) may only be
used from a `v*` tag or from `main`, and only the jobs that sign name it:
`preflight`, `bundle` and `android` in `release.yml`, `bundle` in `play.yml`,
`iphone` in `ios.yml`, and `publish` in `arch-repo.yml`. A new signing key, such as a Windows certificate, goes there
too, and so does `environment: release` on the job that uses it.

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
- **Thank every contributor whose change is in it** (Matt, 2026-10-29), by
  their GitHub `@handle` only, never a name, with what they did in a few plain
  words: "Thanks to
  @Gleasonmt for getting the iPhone app ready for Apple's iOS 15 rule (#743)."
  Always, however small the change, in its own "Thanks" section at the end.
  Who: the authors of the release's commits that aren't Matt or a bot
  (`git log v<previous>..HEAD --format='%an <%ae>' | sort -u`), each matched to
  the pull request it came from for their handle. Naming them in a GitHub
  release tells them it shipped. The first time somebody is thanked, add them
  to the README's Thanks too, after the people already there, with a few words
  on what they did: never by how much.
- Say whether anything stops working with an older app or server (PROTOCOL §9,
  "Which apps and servers work together"). Before 1.0, a change works both ways
  wherever it can. From 1.0, a break may only leave behind versions outside the window
  (12 months or the two releases before, whichever reaches further back), and the
  release *before* it says it's coming. At 1.0 itself, the window starts: say so in
  its notes.
- Point the README's release-notes line and `docs/testing-strategy.md` at the
  new notes, and record the release in `TASKS.md`.
- **Run the GPU check** on a Linux computer with a graphics card, with Docker
  installed. CI's runners have no GPU, and 0.5.2 shipped with watching a
  screen broken wherever NVIDIA's or VA-API's hardware decoders were installed
  (#730). Take the `.deb` from the release pull request's `package-check-Linux`
  artifact, unpack it, and run the packaged app on Arch's WebKit with this
  computer's GPUs passed in:

  ```bash
  gh run download <run> -n package-check-Linux -D /tmp/rc
  mkdir /tmp/rc/deb && (cd /tmp/rc && ar x client/src-tauri/target/debug/bundle/deb/*.deb && tar -xf data.tar.* -C deb)
  scripts/linux-arch-check.sh --gpu /tmp/rc/deb/usr/bin/linger-client /tmp/rc/gpu-check
  ```

  It must print a `PASS` for "a shared screen plays", with the hardware
  decoders it found listed in `hardware-decoders.txt`, a `PASS` for "a video
  in a conversation shows its picture" in every run (#756), and a `PASS` for
  the `GDK_GL=disable` launch (#729). On a computer with NVIDIA's driver it
  runs a third time with the page drawing on NVIDIA's own EGL (`/out/nvidia`),
  where a chat's video went green, and that run must print "the page draws
  with libnvidia-eglcore". Every run must also print a `PASS` for "a voice
  message and a sound file in a conversation play". Run it on the NVIDIA computer, and
  if it says NVIDIA's libraries weren't found, the NVIDIA run didn't happen:
  say so. Nothing opens on the screen; it runs in a container on a virtual
  display. Say in the pull request which GPUs it ran with.

Merge it once CI is green and the GPU check passed.

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
upgrade path, and opens a **draft** release carrying `latest.json`. Once both
desktop builds are on the draft, the `updater-json` job points `latest.json`'s
links at the normal download addresses (tauri-action 1.0 writes GitHub API
links, which GitHub limits to 60 an hour per address, #597) and checks the
files are named as before; it goes red if a platform is missing. The same
tag, after its own full CI run, publishes the server image to
`ghcr.io/itsmattguenther/linger` as `0.3.6`, `0.3` and `latest`, for x86-64
only (ARM64 went after 0.4.4, `docs/decisions.md`). Nothing about the image is
signed and nothing auto-updates; a host chooses when to `docker compose pull`.
A pre-release tag (`v0.4.11-1`, a practice run of the release build) publishes
no image, so it can't move `latest` (#597).

**3. Check the draft.** All ten files are there (the `.exe`, `.msi`, AppImage,
`.deb` and `.rpm`, each with its `.sig`), plus
`Linger_<version>_android-arm64.apk`, and `latest.json` lists the new version
with a signature for all seven platform entries, signed by the key in
`tauri.conf.json`, each linking to `https://github.com/<repo>/releases/download/<tag>/…`
and none to `api.github.com`. Wait for every job to finish before replacing the
draft's text with the release notes: each desktop job sets the text again
(tauri-action 1.0), so an edit made while one is still running, or before
re-running one, is lost. Swap their short install section for the fuller
download table and update steps the previous release used.

**4. Publish it.** Publishing is what makes installed copies see the update, and
it is a person's click on purpose. It also starts the Arch package job (below),
and it moves new servers on: `deploy/setup.sh` fetches its files from the
newest release's tag (#507), and they go with that tag's image. So check the
tag's `image` run went green first; until it does, `latest` is still the
previous server, and a new server would get files ahead of it.

**5. The website.** The site ([linger.im](https://linger.im),
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
- **The app catalogs' pictures.** Linux app catalogs show four of these
  pictures, as PNG copies in this repo's `docs/screenshots/desktop-*.png`,
  named in `client/src-tauri/linux/im.linger.Linger.appdata.xml` with their
  captions (the AppImage catalog's page shows `desktop-room.png`). When `hero`,
  `voice`, `polls` or `media` changed a lot, copy them over from the site's
  checkout, keeping the names, and re-read the captions:
  `ffmpeg -i site/shots/hero.webp -compression_level 9 -pred mixed desktop-room.png`
  (`voice`, `polls` and `media` keep their own names after `desktop-`).
  A catalog links to them on main, so never rename or delete one.
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

Push any changes to that branch, look through the preview Cloudflare links on
it at desktop width and at phone width, and leave the merge to Matt: merging is
what publishes it.

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

## Google Play

Google Play takes an Android App Bundle (`.aab`), not the release's `.apk`,
and makes each phone's own copy from it. `.github/workflows/play.yml` builds
the bundle from a release's tag, signed with the same release key as the
`.apk`, and checks the signature (`scripts/android-signing.sh verify-bundle`).
It runs only by hand, from `main`.

**Per release**, once it's published:

```bash
gh workflow run play.yml -f tag=v0.5.1
gh run list --workflow play.yml --limit 1        # wait for it to go green
gh run download <run id> -n play-bundle          # Linger_0.5.1.aab
```

In Play Console, open the track (Test and release → Testing → Closed testing,
or Production once it's open), **Create new release**, upload the `.aab`, and
paste the release's highlights as its notes.

**Once, when Play App Signing is first set up**, Play must be given our key
rather than make its own. If it made its own, Play's copy wouldn't install
over the `.apk` people already have from GitHub, and they'd have to uninstall,
which signs them out (TASKS T-1604). On the first release's page, choose
**Use a different key**, then **Export and upload a key from Java keystore**,
and download the encryption public key it offers. Then run the workflow with
that key's text as well:

```bash
gh workflow run play.yml -f tag=v0.5.1 -f encryption_key="$(cat encryption_public_key.pem)"
gh run download <run id> -n play-key             # linger-play-key.zip
```

Upload `linger-play-key.zip` where the page asks for it. Google's own tool
(`pepk`) wraps the key inside the run, encrypted so that only Google can open
it, so the key never leaves GitHub. There's no separate upload key: the
GitHub `.apk` needs this key in the `release` environment anyway, so a second
key there would add a secret to keep without guarding anything. Play then
takes only bundles signed with this key. Play Console's App integrity page
shows the app signing key's SHA-256 fingerprint, and it must match
`client/src-tauri/android-release-cert.sha256`.

## The iPhone

Only a Mac builds for the iPhone, so `.github/workflows/ios.yml` builds it on
GitHub's, signs it, and sends it to TestFlight. It runs only by hand, from
`main`:

```bash
gh workflow run ios.yml -f ref=v0.5.2        # or -f ref=main for a test build
gh run list --workflow ios.yml --limit 1     # wait for it to go green
```

App Store Connect takes a few minutes to process the build. It then shows
under TestFlight, ready to give to testers, and on the app's page, ready to
submit for review.

- **Signing is automatic.** Xcode makes the distribution certificate and
  profile, and keeps them in the Apple account, through the App Store Connect
  API key: `APPLE_API_KEY_P8` (the `.p8` file's text), `APPLE_API_KEY_ID` and
  `APPLE_API_ISSUER`, in the `release` environment. It's a team key with
  Admin access, which Tauri requires for automatic signing. Matt keeps the
  `.p8` backed up: Apple lets you download it only once. The team it signs
  for, `SFTT38V54H`, is in `tauri.ios.conf.json`. A Team ID isn't a secret:
  it's in every app the team signs.
- **Each upload needs a new build number** for its version. The run's number
  and attempt ("7.1") are the build number, so running it again is always
  accepted. The version people see stays the release's.
- **The encryption question** is answered in `client/src-tauri/Info.ios.plist`
  (`ITSAppUsesNonExemptEncryption`: only standard, exempt encryption), so it
  isn't asked on each upload.
- **The share extension** (#785) is a second program inside the app, with its
  own identifier, `io.github.itsmattguenther.linger.share`, and both belong to
  the App Group `group.io.github.itsmattguenther.linger`, whose folder is how
  a share reaches the app. Automatic signing should register the identifier
  and the group the first time `ios.yml` builds with them. If the build says
  it can't, register both by hand in the Apple account (Certificates,
  Identifiers & Profiles: the identifier, then the App Group, then tick App
  Groups on both identifiers and pick the group) and run it again. `ios.yml`
  fails a build whose app doesn't hold the extension, or whose extension's
  version isn't the app's.

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

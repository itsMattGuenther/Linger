//! Linger updates itself (#772, T-701).
//!
//! A copy that can update finds a new release (the list window asks at launch
//! and every 12 hours), waits until the release is a day old, downloads it in
//! the background, checks it against the project's signing key and keeps it on
//! disk. It installs it the next time Linger starts (`update_install_pending`),
//! or when the list window says now is a good time (`update_now`): Restart now,
//! the tray's item, or the computer unused for half an hour. The list decides
//! when, since only it knows whether somebody is in voice or sharing their
//! screen. Nothing here restarts anybody on its own.
//!
//! What a copy does depends on how it was installed (`How`):
//! - **silent**: the Windows setup.exe (NSIS, installed per user) and the
//!   AppImage install with no prompt, so they update by themselves.
//! - **password**: the .deb and .rpm (pkexec) and the .msi (Windows' admin
//!   prompt) can't install without somebody there to type a password, so they
//!   download by themselves but install only when asked (Matt, 2026-10-31).
//! - **managed**: a copy a package manager owns (the Arch package, #188) is
//!   never touched. The page is only told that a newer release is out.
//! - **unconfigured**: a build with no signing key, or a copy no installer made
//!   (`pnpm tauri dev`), which has nothing to install over.
//!
//! **Every update is signed.** `Update::download` verifies the bytes against
//! `plugins.updater.pubkey` before handing them back, with no way to skip it,
//! and a kept download is verified again (`verify`) right before it's
//! installed, since it waited on disk in between. A build whose config carries
//! an empty key cannot install anything (ARCHITECTURE §7, baseline 8).
//!
//! The page never talks to the updater plugin. It calls the app's own commands
//! below, and the capability files grant the plugin nothing: a WebView that
//! could download and run an installer is not a WebView with a minimum
//! permission set. The plugin is registered only because that's what puts the
//! parsed `[plugins.updater]` config where `app.updater_builder()` finds it.
//!
//! These types mirror `client/src/lib/updates.ts` by hand: AGENTS rule 7
//! covers types crossing the *wire*, and none of these ever leave the machine.
//! A test below pins the spellings so the two halves can't drift silently.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::utils::config::BundleType;
use tauri::utils::platform::bundle_type;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

/// The updater's key in `tauri.conf.json`'s `plugins` table.
const PLUGIN: &str = "updater";

/// How long a release is out before a copy installs it by itself (#772). The
/// people who press Restart now get it first, and a bad release can be pulled
/// before it reaches everybody: Linger has no crash reports to catch one.
pub const WAIT_MS: i64 = 24 * 60 * 60 * 1000;

/// The longest "what's in it" line the page is handed. The release feed's
/// `notes` carries one short line (`scripts/updater-urls.mjs`); anything
/// longer, or on several lines, is a release from before that and is left out
/// rather than shown as a wall of Markdown.
const LINE_MAX: usize = 140;

/// How long installing at start-up waits for the release feed. Offline, Linger
/// starts as it is and tries again next time.
const START_TIMEOUT: Duration = Duration::from_secs(15);

/// The folder in the app's cache that holds a downloaded update.
const FOLDER: &str = "updates";
/// The update itself.
const KEPT_BYTES: &str = "update.bin";
/// Which version it is and its signature, written last, so its being there
/// means the bytes are whole.
const KEPT_ABOUT: &str = "update.json";
/// Left by a restart to update, saying how Linger comes back (`ComeBack`,
/// `take_come_back`).
const COME_BACK: &str = "come-back";

/// How this copy updates. See the module comment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum How {
    Silent,
    Password,
    Managed(String),
    Unconfigured,
}

/// What a check found.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateCheck {
    /// A newer release this copy installs: by itself (`silent`), or only when
    /// asked, since installing needs a password. `published` is when it came
    /// out, in milliseconds; `downloaded` is whether it's on disk, ready.
    Newer {
        version: String,
        line: Option<String>,
        published: Option<i64>,
        downloaded: bool,
        silent: bool,
    },
    /// Nothing newer. `silent` as above, so Settings says how this copy updates.
    Current {
        silent: bool,
    },
    Unconfigured,
    Failed {
        reason: String,
    },
    /// A package manager owns this copy (#188). `newer` is the newest release
    /// when it's newer than this one, so the page can say it's out.
    Managed {
        by: String,
        newer: Option<Newer>,
    },
}

/// A newer release, for a copy that doesn't install it itself.
#[derive(Debug, Serialize)]
pub struct Newer {
    pub version: String,
    pub line: Option<String>,
}

/// Only ever a reason it did not happen. A successful install replaces the
/// running process, so there is nothing left to resolve the promise.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateInstall {
    /// Nothing to install after all: nothing newer, the update kept for the
    /// next start was overtaken by a newer release, or (with nobody pressing
    /// anything) the release isn't a day old yet.
    Nothing,
    /// Somebody's in voice or sharing a screen: nothing restarts now (#772).
    Busy,
    Unconfigured,
    Failed {
        reason: String,
    },
    Managed {
        by: String,
    },
}

/// How Linger comes back after restarting to update (#772). As it was: in the
/// tray if the list was there. `Behind` is for a restart nobody pressed (the
/// computer left unused), so the list comes back without taking the focus from
/// whatever somebody may be doing in another app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComeBack {
    #[default]
    Shown,
    Behind,
    Tray,
}

/// One download at a time, whoever asked.
#[derive(Default)]
pub struct Downloads {
    busy: AtomicBool,
}

/// Whether somebody is in voice or sharing a screen, as the list window last
/// told the tray (`tray::next_tray_voice`). It's the last thing checked before
/// an install restarts Linger: the list asks only when nobody is, but the
/// feed and a download can take a minute, and somebody can join voice in it
/// (#794 review).
#[derive(Default)]
pub struct Busy(AtomicBool);

/// The list window's word on voice and sharing, from the tray's command.
pub fn set_busy(app: &AppHandle, busy: bool) {
    app.state::<Busy>().0.store(busy, Ordering::Release);
}

fn busy(app: &AppHandle) -> bool {
    app.state::<Busy>().0.load(Ordering::Acquire)
}

/// What is kept beside the downloaded bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Kept {
    version: String,
    signature: String,
}

fn configured(config: Option<&Value>) -> bool {
    let Some(config) = config else {
        return false;
    };
    let signed = config
        .get("pubkey")
        .and_then(Value::as_str)
        .is_some_and(|key| !key.trim().is_empty());
    let reachable = config
        .get("endpoints")
        .and_then(Value::as_array)
        .is_some_and(|endpoints| !endpoints.is_empty());
    signed && reachable
}

fn ready(app: &AppHandle) -> bool {
    configured(app.config().plugins.0.get(PLUGIN))
}

/// The public half of the signing key, as the config has it.
fn pubkey(app: &AppHandle) -> Option<String> {
    app.config()
        .plugins
        .0
        .get(PLUGIN)?
        .get("pubkey")?
        .as_str()
        .map(str::to_owned)
}

/// How a copy updates, from what installed it.
fn how_for(managed: Option<String>, configured: bool, bundle: Option<BundleType>) -> How {
    if let Some(by) = managed {
        return How::Managed(by);
    }
    if !configured {
        return How::Unconfigured;
    }
    match bundle {
        Some(BundleType::Nsis | BundleType::AppImage) => How::Silent,
        Some(BundleType::Deb | BundleType::Rpm | BundleType::Msi) => How::Password,
        // A copy no installer made has nothing to install over (a dev build,
        // a binary built by hand), and macOS has no updater artifacts.
        _ => How::Unconfigured,
    }
}

fn how(app: &AppHandle) -> How {
    how_for(
        crate::packaging::package_manager(),
        ready(app),
        bundle_type(),
    )
}

/// The updater, set up for this copy. The setup.exe installs with no window
/// of its own: `/S` on top of the config's passive mode, which the .msi keeps,
/// since it needs Windows' admin prompt (#772). `/R` (from passive mode)
/// starts the new Linger once it's in.
fn updater(app: &AppHandle, timeout: Option<Duration>) -> Result<Updater, String> {
    let mut builder = app.updater_builder();
    if matches!(bundle_type(), Some(BundleType::Nsis)) {
        builder = builder.installer_arg("/S");
    }
    if let Some(timeout) = timeout {
        builder = builder.timeout(timeout);
    }
    builder.build().map_err(|problem| problem.to_string())
}

/// The one line about what's in a release, when the feed carries one.
fn line_of(body: Option<&str>) -> Option<String> {
    let line = body?.trim();
    if line.is_empty() || line.contains(['\n', '\r']) || line.chars().count() > LINE_MAX {
        return None;
    }
    Some(line.to_owned())
}

/// Whether a release published at `published` (milliseconds) is old enough
/// to install by itself. A feed that doesn't say when is taken as old enough:
/// every release this project publishes says.
fn old_enough(published: Option<i64>, now: i64) -> bool {
    match published {
        Some(published) => now.saturating_sub(published) >= WAIT_MS,
        None => true,
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
        })
}

/// Whether `version` is a newer release than `than`. False for anything that
/// isn't a version, so an odd file is never installed over a good copy.
fn is_newer(version: &str, than: &str) -> bool {
    match (
        semver::Version::parse(version),
        semver::Version::parse(than),
    ) {
        (Ok(version), Ok(than)) => version > than,
        _ => false,
    }
}

/// Check `bytes` against a release's signature and the project's key: the
/// same check the updater makes when it downloads, made again before a kept
/// update is installed, since it waited on disk in between.
fn verify(bytes: &[u8], signature: &str, pubkey: &str) -> Result<(), String> {
    let text = |encoded: &str| -> Result<String, String> {
        let raw = base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .map_err(|problem| problem.to_string())?;
        String::from_utf8(raw).map_err(|problem| problem.to_string())
    };
    let key = minisign_verify::PublicKey::decode(&text(pubkey)?)
        .map_err(|problem| problem.to_string())?;
    let signature = minisign_verify::Signature::decode(&text(signature)?)
        .map_err(|problem| problem.to_string())?;
    key.verify(bytes, &signature, true)
        .map_err(|problem| problem.to_string())
}

/// Where a downloaded update is kept, if the app has a cache folder.
fn store_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_cache_dir().ok().map(|dir| dir.join(FOLDER))
}

/// Keep a downloaded update: the bytes first, then what they are, each
/// written beside and moved into place, so a half-written file is never
/// taken for a whole one.
fn keep(dir: &Path, kept: &Kept, bytes: &[u8]) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let _ = std::fs::remove_file(dir.join(KEPT_ABOUT));
    let part = dir.join(format!("{KEPT_BYTES}.part"));
    std::fs::write(&part, bytes)?;
    std::fs::rename(&part, dir.join(KEPT_BYTES))?;
    let about = serde_json::to_vec(kept).map_err(io::Error::other)?;
    let part = dir.join(format!("{KEPT_ABOUT}.part"));
    std::fs::write(&part, about)?;
    std::fs::rename(&part, dir.join(KEPT_ABOUT))
}

/// What's kept, if a whole update is.
fn kept(dir: &Path) -> Option<Kept> {
    let about = std::fs::read(dir.join(KEPT_ABOUT)).ok()?;
    let kept: Kept = serde_json::from_slice(&about).ok()?;
    dir.join(KEPT_BYTES).is_file().then_some(kept)
}

/// Let go of a kept update: installed, overtaken or no good.
fn forget(dir: &Path) {
    for name in [KEPT_ABOUT, KEPT_BYTES] {
        let _ = std::fs::remove_file(dir.join(name));
    }
}

/// Say how the next start shows the list: a marker for the tray or for
/// coming back behind, none for as usual.
fn mark(dir: &Path, come_back: ComeBack) {
    let marker = dir.join(COME_BACK);
    if come_back == ComeBack::Shown {
        let _ = std::fs::remove_file(marker);
        return;
    }
    if let Ok(said) = serde_json::to_vec(&come_back) {
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::write(marker, said);
    }
}

/// The update folder. Every touch of it from a command goes through here, off
/// the async workers (`spawn_blocking`): an installer is tens of megabytes,
/// and nothing may block the reactor (AGENTS.md, the #794 review). The plain
/// functions above are what runs there, and what the tests call.
#[derive(Clone)]
struct Store(PathBuf);

impl Store {
    fn of(app: &AppHandle) -> Option<Self> {
        store_dir(app).map(Self)
    }

    async fn run<T: Send + 'static>(
        &self,
        work: impl FnOnce(&Path) -> T + Send + 'static,
    ) -> Option<T> {
        let dir = self.0.clone();
        tauri::async_runtime::spawn_blocking(move || work(&dir))
            .await
            .ok()
    }

    async fn kept(&self) -> Option<Kept> {
        self.run(kept).await.flatten()
    }

    async fn bytes(&self) -> Option<Vec<u8>> {
        self.run(|dir| std::fs::read(dir.join(KEPT_BYTES)).ok())
            .await
            .flatten()
    }

    async fn keep(&self, about: Kept, bytes: Vec<u8>) -> Result<(), String> {
        self.run(move |dir| keep(dir, &about, &bytes).map_err(|problem| problem.to_string()))
            .await
            .unwrap_or_else(|| Err("the update couldn't be kept".to_owned()))
    }

    async fn forget(&self) {
        let _ = self.run(forget).await;
    }

    async fn come_back(&self, come_back: ComeBack) {
        let _ = self.run(move |dir| mark(dir, come_back)).await;
    }
}

/// When a release was published, in milliseconds, as the feed says now.
fn published_ms(update: &Update) -> Option<i64> {
    update.date.map(|date| date.unix_timestamp() * 1000)
}

/// Whether an update may go in with nobody pressing anything: at start-up, or
/// with the computer left unused. Only the update kept on this computer, only
/// while it's still the newest release, and only once that release is a day
/// old by the feed *now*: a newer release that appeared since hasn't had its
/// day, and a release is dated again when it's published (`updater-date.yml`),
/// so the date its download went by may have moved (#794 review).
fn may_install_unattended(
    kept: Option<&str>,
    newest: &str,
    published: Option<i64>,
    now: i64,
) -> bool {
    kept == Some(newest) && old_enough(published, now)
}

/// The kept bytes for this update, if they are this version and pass the
/// release's signature now.
async fn kept_bytes(app: &AppHandle, update: &Update) -> Option<Vec<u8>> {
    let store = Store::of(app)?;
    if store.kept().await?.version != update.version {
        return None;
    }
    let bytes = store.bytes().await?;
    let key = pubkey(app)?;
    let signature = update.signature.clone();
    // Checking tens of megabytes is work too.
    let checked = tauri::async_runtime::spawn_blocking(move || {
        verify(&bytes, &signature, &key).map(|()| bytes)
    })
    .await
    .ok()?;
    match checked {
        Ok(bytes) => Some(bytes),
        Err(problem) => {
            eprintln!(
                "linger: the kept update didn't pass its signature, so it's let go: {problem}"
            );
            store.forget().await;
            None
        }
    }
}

/// Download an update in the background and keep it, then tell the list
/// window, which asks again and finds it ready. One at a time.
fn download(app: &AppHandle, update: Update) {
    if app.state::<Downloads>().busy.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // `download` checks the signature before it hands the bytes back.
        let outcome = match update.download(|_, _| {}, || {}).await {
            Ok(bytes) => match Store::of(&app) {
                Some(store) => {
                    store
                        .keep(
                            Kept {
                                version: update.version.clone(),
                                signature: update.signature.clone(),
                            },
                            bytes,
                        )
                        .await
                }
                None => Err("there's no cache folder to keep it in".to_owned()),
            },
            Err(problem) => Err(problem.to_string()),
        };
        app.state::<Downloads>()
            .busy
            .store(false, Ordering::Release);
        match outcome {
            Ok(()) => {
                let _ = app.emit_to("main", "next:update", ());
            }
            Err(problem) => eprintln!("linger: couldn't download the update: {problem}"),
        }
    });
}

/// Install an update and start the new Linger. On Windows the installer takes
/// over and this process ends inside `install`; the installer starts the new
/// one. Everywhere else the new files are in place when it returns, and
/// Linger restarts. `come_back` says how the new one shows itself. In voice
/// or sharing a screen, nothing happens: that's checked here, last.
async fn install(
    app: &AppHandle,
    update: Update,
    bytes: Vec<u8>,
    come_back: ComeBack,
) -> UpdateInstall {
    if busy(app) {
        return UpdateInstall::Busy;
    }
    let store = Store::of(app);
    if let Some(store) = &store {
        store.come_back(come_back).await;
    }
    // Writing the new files, and on Linux maybe waiting for a password.
    let installed = tauri::async_runtime::spawn_blocking(move || {
        update
            .install(&bytes)
            .map_err(|problem| problem.to_string())
    })
    .await
    .unwrap_or_else(|problem| Err(problem.to_string()));
    if let Err(reason) = installed {
        if let Some(store) = &store {
            store.come_back(ComeBack::Shown).await;
        }
        return UpdateInstall::Failed { reason };
    }
    if let Some(store) = &store {
        store.forget().await;
    }
    app.restart()
}

/// How this start shows the list: as usual, unless the last run restarted to
/// update and said otherwise. Asked once, when the windows are built, before
/// anything else runs.
pub fn take_come_back(app: &tauri::App) -> ComeBack {
    let Ok(dir) = app.path().app_cache_dir() else {
        return ComeBack::Shown;
    };
    let marker = dir.join(FOLDER).join(COME_BACK);
    let Ok(said) = std::fs::read(&marker) else {
        return ComeBack::Shown;
    };
    let _ = std::fs::remove_file(marker);
    serde_json::from_slice(&said).unwrap_or_default()
}

/// Look for a newer release. A copy that installs updates starts downloading
/// one that's a day old and not on disk yet; the list window hears when it's
/// ready (`next:update`).
#[tauri::command]
pub async fn update_check(app: AppHandle) -> UpdateCheck {
    let how = how(&app);
    match how {
        How::Unconfigured => UpdateCheck::Unconfigured,
        How::Managed(by) => {
            let newer = match updater(&app, None) {
                Ok(updater) => match updater.check().await {
                    Ok(Some(update)) => Some(Newer {
                        line: line_of(update.body.as_deref()),
                        version: update.version,
                    }),
                    Ok(None) | Err(_) => None,
                },
                Err(_) => None,
            };
            UpdateCheck::Managed { by, newer }
        }
        How::Silent | How::Password => {
            let updater = match updater(&app, None) {
                Ok(updater) => updater,
                Err(reason) => return UpdateCheck::Failed { reason },
            };
            match updater.check().await {
                Ok(Some(update)) => {
                    let published = published_ms(&update);
                    let downloaded = match Store::of(&app) {
                        Some(store) => store
                            .kept()
                            .await
                            .is_some_and(|kept| kept.version == update.version),
                        None => false,
                    };
                    let line = line_of(update.body.as_deref());
                    let version = update.version.clone();
                    if !downloaded && old_enough(published, now_ms()) {
                        download(&app, update);
                    }
                    UpdateCheck::Newer {
                        version,
                        line,
                        published,
                        downloaded,
                        silent: how == How::Silent,
                    }
                }
                Ok(None) => {
                    if let Some(store) = Store::of(&app) {
                        store.forget().await;
                    }
                    UpdateCheck::Current {
                        silent: how == How::Silent,
                    }
                }
                Err(problem) => UpdateCheck::Failed {
                    reason: problem.to_string(),
                },
            }
        }
    }
}

/// The newest published release, whatever installed this copy (#314). A copy
/// the package manager owns still asks, since a host on Omarchy needs to know
/// their server is behind as much as anybody. `None` when the feed couldn't be
/// read.
#[tauri::command]
pub async fn newest_version(app: AppHandle) -> Option<String> {
    if !ready(&app) {
        return None;
    }
    let updater = app
        .updater_builder()
        .version_comparator(|_current, _published| true)
        .build()
        .ok()?;
    match updater.check().await {
        Ok(Some(published)) => Some(published.version),
        Ok(None) | Err(_) => None,
    }
}

/// Install the newest release now and restart into it: Restart now, the
/// tray's item, Update on a copy that needs a password, or (`automatic`) the
/// computer left unused (#772). The list window asks only when nobody's in
/// voice or sharing a screen, and that's checked again right before the
/// install (`Busy`). Pressed, a kept download is used when it's this version
/// and still passes its signature, and otherwise it's downloaded now, without
/// the day's wait. Automatic, only the update kept here goes in, once its day
/// is up (`may_install_unattended`).
///
/// The check is run here rather than carrying an `Update` across two IPC
/// calls, so the thing installed is the thing the feed serves now.
#[tauri::command]
pub async fn update_now(
    app: AppHandle,
    come_back: Option<ComeBack>,
    automatic: Option<bool>,
) -> UpdateInstall {
    match how(&app) {
        How::Managed(by) => return UpdateInstall::Managed { by },
        How::Unconfigured => return UpdateInstall::Unconfigured,
        How::Silent | How::Password => {}
    }
    if busy(&app) {
        return UpdateInstall::Busy;
    }
    let updater = match updater(&app, None) {
        Ok(updater) => updater,
        Err(reason) => return UpdateInstall::Failed { reason },
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return UpdateInstall::Nothing,
        Err(problem) => {
            return UpdateInstall::Failed {
                reason: problem.to_string(),
            }
        }
    };
    if automatic.unwrap_or(false) {
        let kept = match Store::of(&app) {
            Some(store) => store.kept().await.map(|kept| kept.version),
            None => None,
        };
        if !may_install_unattended(
            kept.as_deref(),
            &update.version,
            published_ms(&update),
            now_ms(),
        ) {
            return UpdateInstall::Nothing;
        }
    }
    let bytes = match kept_bytes(&app, &update).await {
        Some(bytes) => bytes,
        None if automatic.unwrap_or(false) => return UpdateInstall::Nothing,
        None => match update.download(|_, _| {}, || {}).await {
            Ok(bytes) => bytes,
            Err(problem) => {
                return UpdateInstall::Failed {
                    reason: problem.to_string(),
                }
            }
        },
    };
    install(&app, update, bytes, come_back.unwrap_or_default()).await
}

/// The version kept for the next start, when this copy installs by itself and
/// it's newer than this one. Anything not newer is let go: it's in.
async fn pending(app: &AppHandle) -> Option<String> {
    let store = Store::of(app)?;
    let kept = store.kept().await?;
    let running = app.package_info().version.to_string();
    if !is_newer(&kept.version, &running) {
        store.forget().await;
        return None;
    }
    (how(app) == How::Silent).then_some(kept.version)
}

/// The version kept for the next start (`pending`), for the list window,
/// which says it's installing before it does.
#[tauri::command]
pub async fn update_pending(app: AppHandle) -> Option<String> {
    pending(&app).await
}

/// Install the update kept for this start, before the list is shown (#772).
/// Only when it's still the newest release, a day old by the feed now, and
/// still passes its signature: a newer release overtaking it is downloaded the
/// usual way instead. Offline, or anything else wrong, and Linger starts as
/// it is.
#[tauri::command]
pub async fn update_install_pending(app: AppHandle) -> UpdateInstall {
    let Some(version) = pending(&app).await else {
        return UpdateInstall::Nothing;
    };
    let updater = match updater(&app, Some(START_TIMEOUT)) {
        Ok(updater) => updater,
        Err(reason) => return UpdateInstall::Failed { reason },
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            if let Some(store) = Store::of(&app) {
                store.forget().await;
            }
            return UpdateInstall::Nothing;
        }
        Err(problem) => {
            return UpdateInstall::Failed {
                reason: problem.to_string(),
            }
        }
    };
    if update.version != version {
        if let Some(store) = Store::of(&app) {
            store.forget().await;
        }
        return UpdateInstall::Nothing;
    }
    // Kept, but not a day old by the feed now: it waits.
    if !may_install_unattended(
        Some(&version),
        &update.version,
        published_ms(&update),
        now_ms(),
    ) {
        return UpdateInstall::Nothing;
    }
    let Some(bytes) = kept_bytes(&app, &update).await else {
        return UpdateInstall::Failed {
            reason: "The update kept on this computer didn't pass its signature.".to_owned(),
        };
    };
    // Started in the tray (by an update while it was there), it goes back.
    let in_tray = app
        .get_webview_window("main")
        .is_some_and(|list| !list.is_visible().unwrap_or(true));
    let come_back = if in_tray {
        ComeBack::Tray
    } else {
        ComeBack::Shown
    };
    install(&app, update, bytes, come_back).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A throwaway key and a file it signed (`tauri signer`), used for nothing
    /// but this test.
    const TEST_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEU4N0FBNzM5MkRFMjlBNgpSV1NtS2Q2U2M2cUhEbFpiNjlIRUp2d24xN0drakRnZmZrU3l1aG82TUxieTdJQUZ0OTlUYzZlUAo=";
    const TEST_BYTES: &[u8] = b"linger update test bytes\n";
    const TEST_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTbUtkNlNjNnFIRGpsYUZyVXkwWm1QNUpYeUJOWHFoN0FCWTNBVnYwMGlXMmR6U1p3a1ZqY0lSYU90SzhTcitKNmNlSVd0M052VjFQY3VKM3E4M09tWEdJRk9NSXhjaVFZPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkzNDYyOTIyCWZpbGU6YmxvYi5iaW4KL2xWeUF0UzFzUGR1d1c4MW10Y0VUTmQwQUJVTC9pbC90YUhUM3NQSEdzdGFlaERDYTJmMVhTRHYyenN1SStXZ01oUFVXR3BWdVhvbjdNd1llbjREQlE9PQo=";
    /// The project's own key, from `tauri.conf.json`.
    const PROJECT_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDhDRDRCMjU5MkVDMUZERjgKUldUNC9jRXVXYkxVakczU0wxWXdqZGd4eWdPUkhuOXpDaWN2L2s5a3pybm4veUU2S1ZTNkQ4bVQK";

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("linger-updates-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_key_and_an_endpoint_are_both_required() {
        let both = json!({
            "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6",
            "endpoints": ["https://example.test/latest.json"],
        });
        assert!(configured(Some(&both)));

        let no_key = json!({ "pubkey": "", "endpoints": ["https://example.test/latest.json"] });
        assert!(!configured(Some(&no_key)));

        let blank_key =
            json!({ "pubkey": "   ", "endpoints": ["https://example.test/latest.json"] });
        assert!(!configured(Some(&blank_key)));

        let no_endpoint = json!({ "pubkey": "dW50cnVzdGVk", "endpoints": [] });
        assert!(!configured(Some(&no_endpoint)));
    }

    #[test]
    fn no_updater_section_at_all_is_unconfigured() {
        assert!(!configured(None));
        assert!(!configured(Some(&json!({}))));
    }

    #[test]
    fn the_installer_decides_how_a_copy_updates() {
        assert_eq!(how_for(None, true, Some(BundleType::Nsis)), How::Silent);
        assert_eq!(how_for(None, true, Some(BundleType::AppImage)), How::Silent);
        assert_eq!(how_for(None, true, Some(BundleType::Deb)), How::Password);
        assert_eq!(how_for(None, true, Some(BundleType::Rpm)), How::Password);
        assert_eq!(how_for(None, true, Some(BundleType::Msi)), How::Password);
        // A dev build, or a binary built by hand: never installed over.
        assert_eq!(how_for(None, true, None), How::Unconfigured);
        assert_eq!(
            how_for(None, true, Some(BundleType::Dmg)),
            How::Unconfigured
        );
        // No key: nothing at all, whatever installed it.
        assert_eq!(
            how_for(None, false, Some(BundleType::Nsis)),
            How::Unconfigured
        );
        // The Arch package is the .deb's binary, and pacman owns it (#188).
        assert_eq!(
            how_for(Some("pacman".into()), true, Some(BundleType::Deb)),
            How::Managed("pacman".into())
        );
    }

    #[test]
    fn only_a_short_single_line_is_a_release_line() {
        assert_eq!(
            line_of(Some("  Screen sharing, and fixes for voice. \n")),
            Some("Screen sharing, and fixes for voice.".to_owned())
        );
        assert_eq!(line_of(None), None);
        assert_eq!(line_of(Some("   ")), None);
        // What tauri-action writes: the release's whole install section.
        assert_eq!(
            line_of(Some("**This is the Linger app**\n\nIt is not the server.")),
            None
        );
        assert_eq!(line_of(Some(&"x".repeat(LINE_MAX + 1))), None);
        assert!(line_of(Some(&"é".repeat(LINE_MAX))).is_some());
    }

    #[test]
    fn a_release_installs_by_itself_once_it_is_a_day_old() {
        let published = 1_800_000_000_000;
        assert!(!old_enough(Some(published), published));
        assert!(!old_enough(Some(published), published + WAIT_MS - 1));
        assert!(old_enough(Some(published), published + WAIT_MS));
        // A clock behind the release's date waits too.
        assert!(!old_enough(Some(published), published - 1));
        assert!(old_enough(None, published));
    }

    #[test]
    fn only_a_newer_version_is_newer() {
        assert!(is_newer("0.5.4", "0.5.3"));
        assert!(is_newer("0.10.0", "0.9.9"));
        assert!(!is_newer("0.5.3", "0.5.3"));
        assert!(!is_newer("0.5.2", "0.5.3"));
        assert!(!is_newer("nonsense", "0.5.3"));
        assert!(!is_newer("0.5.4", "nonsense"));
    }

    #[test]
    fn a_kept_update_is_checked_against_the_key() {
        assert_eq!(verify(TEST_BYTES, TEST_SIGNATURE, TEST_KEY), Ok(()));
        assert!(verify(b"something else", TEST_SIGNATURE, TEST_KEY).is_err());
        assert!(verify(TEST_BYTES, "not a signature", TEST_KEY).is_err());
        // Signed, but by a key that isn't the one Linger trusts.
        assert!(verify(TEST_BYTES, TEST_SIGNATURE, PROJECT_KEY).is_err());
    }

    #[test]
    fn a_kept_update_is_whole_or_not_there() {
        let dir = scratch("kept");
        let about = Kept {
            version: "0.5.4".into(),
            signature: TEST_SIGNATURE.into(),
        };
        assert_eq!(kept(&dir), None);
        keep(&dir, &about, TEST_BYTES).expect("keep");
        assert_eq!(kept(&dir), Some(about.clone()));
        assert_eq!(kept(&dir).map(|kept| kept.version), Some("0.5.4".into()));
        assert_eq!(
            std::fs::read(dir.join(KEPT_BYTES)).expect("bytes"),
            TEST_BYTES
        );

        // Bytes with nothing saying what they are aren't an update.
        std::fs::remove_file(dir.join(KEPT_ABOUT)).expect("remove");
        assert_eq!(kept(&dir), None);
        // Nor is what they are with no bytes.
        keep(&dir, &about, TEST_BYTES).expect("keep");
        std::fs::remove_file(dir.join(KEPT_BYTES)).expect("remove");
        assert_eq!(kept(&dir), None);

        keep(&dir, &about, TEST_BYTES).expect("keep");
        forget(&dir);
        assert_eq!(kept(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_goes_in_unattended_but_the_kept_update_once_its_day_is_up() {
        let published = 1_800_000_000_000;
        let later = published + WAIT_MS;
        assert!(may_install_unattended(
            Some("0.5.4"),
            "0.5.4",
            Some(published),
            later
        ));
        // A newer release since: it hasn't had its day, and isn't what's kept.
        assert!(!may_install_unattended(
            Some("0.5.4"),
            "0.5.5",
            Some(published),
            later
        ));
        assert!(!may_install_unattended(
            None,
            "0.5.4",
            Some(published),
            later
        ));
        // Dated again when it was published: the kept download waits for the new date.
        assert!(!may_install_unattended(
            Some("0.5.4"),
            "0.5.4",
            Some(later - 1),
            later
        ));
        // Built but not published yet: dated in the future, never old enough.
        assert!(!may_install_unattended(
            Some("0.5.4"),
            "0.5.4",
            Some(32_503_680_000_000),
            later
        ));
    }

    #[test]
    fn how_linger_comes_back_is_said_once_and_as_usual_is_no_marker() {
        let dir = scratch("come-back");
        mark(&dir, ComeBack::Tray);
        let said: ComeBack =
            serde_json::from_slice(&std::fs::read(dir.join(COME_BACK)).expect("marker"))
                .expect("read");
        assert_eq!(said, ComeBack::Tray);
        mark(&dir, ComeBack::Shown);
        assert!(!dir.join(COME_BACK).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The frontend matches on these strings. If one changes here, the page
    /// silently stops recognising it, so pin them.
    #[test]
    fn the_kind_spellings_are_what_the_frontend_expects() {
        let newer = serde_json::to_string(&UpdateCheck::Newer {
            version: "0.5.4".into(),
            line: Some("Screen sharing.".into()),
            published: Some(1_800_000_000_000),
            downloaded: true,
            silent: true,
        })
        .expect("serialize");
        assert_eq!(
            newer,
            r#"{"kind":"newer","version":"0.5.4","line":"Screen sharing.","published":1800000000000,"downloaded":true,"silent":true}"#
        );

        let current =
            serde_json::to_string(&UpdateCheck::Current { silent: false }).expect("serialize");
        assert_eq!(current, r#"{"kind":"current","silent":false}"#);

        let back: ComeBack = serde_json::from_str(r#""behind""#).expect("deserialize");
        assert_eq!(back, ComeBack::Behind);
        assert_eq!(
            serde_json::to_string(&ComeBack::Tray).expect("serialize"),
            r#""tray""#
        );

        let unconfigured = serde_json::to_string(&UpdateCheck::Unconfigured).expect("serialize");
        assert_eq!(unconfigured, r#"{"kind":"unconfigured"}"#);

        let managed = serde_json::to_string(&UpdateCheck::Managed {
            by: "pacman".into(),
            newer: Some(Newer {
                version: "0.5.4".into(),
                line: None,
            }),
        })
        .expect("serialize");
        assert_eq!(
            managed,
            r#"{"kind":"managed","by":"pacman","newer":{"version":"0.5.4","line":null}}"#
        );

        let failed = serde_json::to_string(&UpdateCheck::Failed {
            reason: "offline".into(),
        })
        .expect("serialize");
        assert_eq!(failed, r#"{"kind":"failed","reason":"offline"}"#);

        let nothing = serde_json::to_string(&UpdateInstall::Nothing).expect("serialize");
        assert_eq!(nothing, r#"{"kind":"nothing"}"#);
        let busy = serde_json::to_string(&UpdateInstall::Busy).expect("serialize");
        assert_eq!(busy, r#"{"kind":"busy"}"#);
        let install = serde_json::to_string(&UpdateInstall::Unconfigured).expect("serialize");
        assert_eq!(install, r#"{"kind":"unconfigured"}"#);
        let install_failed = serde_json::to_string(&UpdateInstall::Failed {
            reason: "no disk".into(),
        })
        .expect("serialize");
        assert_eq!(install_failed, r#"{"kind":"failed","reason":"no disk"}"#);
        let install_managed = serde_json::to_string(&UpdateInstall::Managed {
            by: "pacman".into(),
        })
        .expect("serialize");
        assert_eq!(install_managed, r#"{"kind":"managed","by":"pacman"}"#);
    }
}

//! In-app updates (T-701).
//!
//! The updater lives here rather than in the WebView, for the same reason the
//! gateway does: it is the narrowest surface that works. `capabilities/default.json`
//! grants the updater plugin nothing, so the page cannot call
//! `plugin:updater|check` or `plugin:updater|install` itself — it gets the two
//! commands below and nothing else. The plugin still has to be registered, because
//! that is what puts the parsed `[plugins.updater]` config where `app.updater()`
//! can find it.
//!
//! **Every update is signed.** `Update::download` verifies the downloaded bytes
//! against `plugins.updater.pubkey` before a single byte is installed, and it does
//! so unconditionally — there is no "skip verification" path. A build whose config
//! carries an empty key therefore cannot install anything, which is the state this
//! repo ships in until the key from `scripts/updater-key.sh` is stamped into
//! `tauri.conf.json` (ARCHITECTURE §7, baseline 8).

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

/// The updater's key in `tauri.conf.json`'s `plugins` table.
const PLUGIN: &str = "updater";

/// What a check found. Hand-written on both sides, mirrored in
/// `client/src/lib/updates.ts` — this never crosses the wire, so AGENTS rule 7
/// does not apply, and the test at the bottom pins the `kind` spellings so the
/// two halves cannot drift silently.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateCheck {
    /// A newer signed build is published. `notes` is the release body, if the
    /// manifest carried one.
    Ready {
        version: String,
        notes: Option<String>,
    },
    /// This is the newest published build.
    Current,
    /// This build has no update endpoint or no public key, so it can never
    /// update itself. A build from a source checkout is the usual reason.
    Unconfigured,
    /// The check failed — offline, a bad manifest, an OS with no updater.
    Failed { reason: String },
    /// A system package manager installed this copy and updates it (#188):
    /// on Omarchy, its Update runs `pacman -Syu`. `by` names the manager.
    Managed { by: String },
}

/// What an install attempt came back with.
///
/// There is deliberately no success variant: on success the process is gone.
/// macOS and Linux relaunch through `AppHandle::restart`, and on Windows the
/// installer takes over and the plugin exits the app before `download_and_install`
/// even returns. Anything that *does* come back is a reason it did not happen.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateInstall {
    Unconfigured,
    Failed { reason: String },
    Managed { by: String },
}

/// Whether this build can update itself at all: a non-empty public key *and*
/// somewhere to ask.
///
/// Split out from the commands, and taking the raw config value rather than an
/// `AppHandle`, so the rule is testable without standing up an app. Both halves
/// matter — an endpoint with no key would download an unverifiable file, and a
/// key with no endpoint has nothing to verify.
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

/// The version this build was compiled as, for the line in settings. Read from
/// the bundle's own metadata, so it cannot disagree with what the updater
/// compares against.
#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Ask the endpoint whether there is anything newer. Never fails: every outcome,
/// including "you are offline", comes back as a variant the settings panel can
/// put on screen.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> UpdateCheck {
    if let Some(by) = crate::packaging::package_manager() {
        return UpdateCheck::Managed { by };
    }
    if !ready(&app) {
        return UpdateCheck::Unconfigured;
    }
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(problem) => {
            return UpdateCheck::Failed {
                reason: problem.to_string(),
            }
        }
    };
    match updater.check().await {
        Ok(Some(update)) => UpdateCheck::Ready {
            version: update.version.clone(),
            notes: update.body.clone().filter(|notes| !notes.trim().is_empty()),
        },
        Ok(None) => UpdateCheck::Current,
        Err(problem) => UpdateCheck::Failed {
            reason: problem.to_string(),
        },
    }
}

/// Download, verify, install, restart.
///
/// The check is run again here rather than carrying an `Update` across two IPC
/// calls. It costs one request and it means the thing being installed is the
/// thing the endpoint is serving *now*, not what it was serving when the panel
/// was opened.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> UpdateInstall {
    // Never replace a copy the package manager owns: the program inside is
    // stamped for Debian's installer, and an Arch system has none (#188).
    if let Some(by) = crate::packaging::package_manager() {
        return UpdateInstall::Managed { by };
    }
    if !ready(&app) {
        return UpdateInstall::Unconfigured;
    }
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(problem) => {
            return UpdateInstall::Failed {
                reason: problem.to_string(),
            }
        }
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            return UpdateInstall::Failed {
                reason: "There is nothing newer to install.".to_string(),
            }
        }
        Err(problem) => {
            return UpdateInstall::Failed {
                reason: problem.to_string(),
            }
        }
    };
    // No progress callbacks: the settings panel says "downloading" and the
    // installers are tens of megabytes, not gigabytes. A percentage here would
    // need an event channel and a progress bar to show it in.
    if let Err(problem) = update.download_and_install(|_, _| {}, || {}).await {
        return UpdateInstall::Failed {
            reason: problem.to_string(),
        };
    }
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

    /// The frontend matches on these strings. If one changes here, the settings
    /// panel silently stops recognising it, so pin them.
    #[test]
    fn the_kind_spellings_are_what_the_frontend_expects() {
        let ready = serde_json::to_string(&UpdateCheck::Ready {
            version: "0.2.0".to_string(),
            notes: None,
        })
        .expect("serialize");
        assert_eq!(ready, r#"{"kind":"ready","version":"0.2.0","notes":null}"#);

        let current = serde_json::to_string(&UpdateCheck::Current).expect("serialize");
        assert_eq!(current, r#"{"kind":"current"}"#);

        let unconfigured = serde_json::to_string(&UpdateCheck::Unconfigured).expect("serialize");
        assert_eq!(unconfigured, r#"{"kind":"unconfigured"}"#);

        let managed = serde_json::to_string(&UpdateCheck::Managed {
            by: "pacman".to_string(),
        })
        .expect("serialize");
        assert_eq!(managed, r#"{"kind":"managed","by":"pacman"}"#);

        let failed = serde_json::to_string(&UpdateCheck::Failed {
            reason: "offline".to_string(),
        })
        .expect("serialize");
        assert_eq!(failed, r#"{"kind":"failed","reason":"offline"}"#);

        let install = serde_json::to_string(&UpdateInstall::Unconfigured).expect("serialize");
        assert_eq!(install, r#"{"kind":"unconfigured"}"#);
        let install_failed = serde_json::to_string(&UpdateInstall::Failed {
            reason: "no disk".to_string(),
        })
        .expect("serialize");
        assert_eq!(install_failed, r#"{"kind":"failed","reason":"no disk"}"#);
    }
}

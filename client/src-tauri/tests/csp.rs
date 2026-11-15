//! The two Content-Security-Policies, checked against the config that ships.
//!
//! `tauri.conf.json` carries two policies, and which one the WebView gets is
//! decided at compile time by Tauri's own `is_dev()`: `devCsp` under
//! `pnpm tauri dev`, `csp` in anything the bundler produces. The split exists
//! because development talks to a server on `http://localhost:8080` and a
//! shipped copy has no business talking to a random port on the machine it
//! landed on — a page that can reach `http://localhost:*` can knock on every
//! service the person is running.
//!
//! Two sources look like a relaxation and are not. `ipc:` and
//! `http://ipc.localhost` are Tauri's own IPC channel — `invoke()` is a `fetch`
//! at one of those two URLs, the first on Linux and macOS and the second on
//! Windows. Blocking them does not stop IPC, it silently drops it onto a slower
//! `postMessage` fallback, which is a worse failure than a loud one.
//!
//! These are assertions about a JSON file rather than about a running WebView,
//! and that is the honest limit of them: they prove the shipped policy says
//! what it is meant to say. Whether a real installed build still reaches a real
//! server is M7's milestone check, and a person has to watch that happen.

use std::collections::HashMap;

use tauri::utils::config::{Config, Csp, CspDirectiveSources};

/// Parsed by Tauri's own config type, not by an ad-hoc struct: `SecurityConfig`
/// denies unknown fields, so a misspelled `devCsp` fails here instead of
/// quietly shipping the dev policy's absence.
fn config() -> Config {
    serde_json::from_str(include_str!("../tauri.conf.json"))
        .expect("tauri.conf.json parses as a Tauri config")
}

/// Split a policy into directive → sources the same way Tauri does when it
/// injects one.
fn directives(csp: &Csp) -> HashMap<String, Vec<String>> {
    HashMap::<String, CspDirectiveSources>::from(csp.clone())
        .into_iter()
        .map(|(directive, sources)| (directive, Vec::<String>::from(sources)))
        .collect()
}

fn release() -> HashMap<String, Vec<String>> {
    let config = config();
    let csp = config
        .app
        .security
        .csp
        .clone()
        .expect("a release CSP is configured");
    directives(&csp)
}

fn dev() -> HashMap<String, Vec<String>> {
    let config = config();
    let csp = config
        .app
        .security
        .dev_csp
        .clone()
        .expect("a dev CSP is configured");
    directives(&csp)
}

fn sources<'a>(csp: &'a HashMap<String, Vec<String>>, directive: &str) -> &'a [String] {
    csp.get(directive)
        .unwrap_or_else(|| panic!("the policy sets {directive}"))
}

/// The whole point of the task: nothing in a shipped build may name a port on
/// the local machine. `http://ipc.localhost` is Tauri's IPC endpoint on
/// Windows, not a server address, so it is the one allowed spelling.
#[test]
fn release_policy_reaches_no_local_port() {
    for (directive, sources) in release() {
        for source in sources {
            assert!(
                !source.contains("127.0.0.1"),
                "{directive} still allows {source} in the shipped build"
            );
            assert!(
                source == "http://ipc.localhost" || !source.contains("localhost"),
                "{directive} still allows {source} in the shipped build"
            );
        }
    }
}

/// Hardening that cuts the app off from its own server would be a regression,
/// not a fix: every real server is reached over https, and every upload comes
/// back from the media origin over https.
#[test]
fn release_policy_still_reaches_a_real_server() {
    let csp = release();
    for directive in ["connect-src", "img-src", "media-src"] {
        assert!(
            sources(&csp, directive).iter().any(|s| s == "https:"),
            "{directive} must still allow https, or the app cannot reach a server"
        );
    }
}

/// A shipped build reaches a server over https and nothing else: no `http:`,
/// no plain-http address, no `ws:`. `secrets::reachable` counts on it to pass
/// over a development build's sign-in at `http://localhost`, left in the same
/// keyring, which an installed copy would otherwise wait on forever (#902).
/// Allowing plain http here means changing that too.
#[test]
fn release_policy_reaches_servers_over_https_only() {
    for source in sources(&release(), "connect-src") {
        let plain = source == "http:"
            || source == "ws:"
            || (source.starts_with("http://") && source != "http://ipc.localhost")
            || source.starts_with("ws://");
        assert!(
            !plain,
            "connect-src allows {source} in the shipped build; secrets.rs `reachable` assumes \
             https only"
        );
    }
}

/// `invoke()` is a fetch at `ipc://localhost` (Linux, macOS) or
/// `http://ipc.localhost` (Windows). Without these the call is not refused, it
/// falls back to `postMessage` with a console warning — working software with a
/// hidden performance cliff, which is exactly the kind of thing nobody notices
/// until a release.
#[test]
fn both_policies_allow_tauris_own_ipc() {
    for csp in [release(), dev()] {
        let connect = sources(&csp, "connect-src");
        for source in ["ipc:", "http://ipc.localhost"] {
            assert!(
                connect.iter().any(|s| s == source),
                "connect-src must allow {source} or IPC drops to postMessage"
            );
        }
    }
}

/// Development keeps what it needs, and this is the half that is easy to lose:
/// `pnpm tauri dev` against a local server has to be able to reach it.
#[test]
fn dev_policy_keeps_the_local_server() {
    let connect = dev();
    let connect = sources(&connect, "connect-src");
    for source in ["http://localhost:*", "http://127.0.0.1:*"] {
        assert!(
            connect.iter().any(|s| s == source),
            "connect-src must allow {source} in dev, or `pnpm tauri dev` cannot reach a local server"
        );
    }
}

/// The two policies are edited by hand in the same file, and the way they rot
/// is one of them gaining a source the other never hears about. Dev is release
/// plus local addresses and nothing else.
#[test]
fn dev_policy_is_the_release_policy_plus_local_addresses() {
    let release = release();
    let dev = dev();

    for (directive, allowed) in &release {
        let in_dev = dev
            .get(directive)
            .unwrap_or_else(|| panic!("the dev policy also sets {directive}"));
        for source in allowed {
            assert!(
                in_dev.contains(source),
                "{directive} allows {source} in the shipped build but not in dev"
            );
        }
    }

    for (directive, allowed) in &dev {
        let in_release = release
            .get(directive)
            .unwrap_or_else(|| panic!("the release policy also sets {directive}"));
        for source in allowed {
            let local = source.contains("localhost") || source.contains("127.0.0.1");
            assert!(
                local || in_release.contains(source),
                "{directive} allows {source} in dev, which is not a local address and is \
                 not allowed in the shipped build"
            );
        }
    }
}

/// ARCHITECTURE §7: no remote script and no remote font, in either policy.
/// `style-src` is the documented exception — the message list is virtualized,
/// so row positions are inline style attributes, and a person's name is painted
/// from `--person-*` properties set the same way.
#[test]
fn neither_policy_allows_remote_code_or_fonts() {
    for csp in [release(), dev()] {
        assert_eq!(sources(&csp, "script-src"), ["'self'"]);
        assert_eq!(sources(&csp, "font-src"), ["'self'"]);
        assert_eq!(sources(&csp, "object-src"), ["'none'"]);
        assert_eq!(sources(&csp, "frame-ancestors"), ["'none'"]);
    }
}

//! A Linger server on the phone's own network, such as one run at home
//! (#842, SPEC §4.15).
//!
//! From Android 17, an app that targets it can't reach an address on the
//! Wi-Fi or Ethernet the phone is on until the person allows it (one of the
//! "Nearby devices" permissions), and a connection there doesn't fail: it
//! waits until it gives up. That holds for the page's requests as much as
//! the gateway's, since the web view goes by the app's permission. So before
//! the page reaches a server (`src/lib/localNetwork.ts`), it asks here, and
//! this asks the person only when that server's address is on the phone's
//! network as Android counts it. A server on the internet never asks.
//!
//! An iPhone asks by itself the first time Linger reaches one
//! (`Info.ios.plist`), and an Android before 17 doesn't ask at all, so both
//! answer `allowed` straight away. On Android the permission is Kotlin's
//! (`LocalNetwork.kt`), reached through one method (`scripts/android-jni.mjs`).

use std::net::IpAddr;
use std::time::Duration;

/// How long a server's name may take to look up before the page goes on
/// without knowing. The request it's about to make looks the name up too,
/// and says so if it can't.
const LOOKUP: Duration = Duration::from_secs(5);

/// Whether Linger may reach `server` from this phone: a server's base
/// address (`https://linger.example`), or an address its voice call reaches
/// (`udp://10.0.2.2:3479`, `turn://relay.example:3478`, from
/// `voiceAddresses` in `localNetwork.ts`). Asks the person, with `ask`, when
/// it's on their network and they haven't allowed it:
///
/// - `allowed`: it may, and so may every server, since the permission is the
///   app's.
/// - `public`: the server's address isn't on the phone's network, so there's
///   nothing to allow.
/// - `unresolved`: its name doesn't look up just now.
/// - `asking`: it's on the phone's network and the dialog is up. The answer
///   comes as `linger:local-network` on the page (`MainActivity.kt`).
/// - `denied`: it's on the phone's network, isn't allowed, and wasn't asked
///   about (`ask` was false, or there was no screen to ask from).
#[cfg(mobile)]
#[tauri::command]
pub async fn phone_local_network(server: String, ask: bool) -> String {
    let now = crate::off_thread(|| platform::state(false), || None).await;
    if now.as_deref() == Some("granted") {
        return "allowed".to_string();
    }
    match on_this_network(&server).await {
        None => "unresolved",
        Some(false) => "public",
        Some(true) if !ask => "denied",
        Some(true) => match crate::off_thread(|| platform::state(true), || None)
            .await
            .as_deref()
        {
            Some("granted") => "allowed",
            Some("asking") => "asking",
            _ => "denied",
        },
    }
    .to_string()
}

/// Whether `server`'s address is on the phone's own network: `None` when it
/// can't tell (not a web address, or a name that doesn't look up now).
async fn on_this_network(server: &str) -> Option<bool> {
    let url = tauri::Url::parse(server).ok()?;
    let host = url.host_str()?;
    let literal = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = literal.parse::<IpAddr>() {
        return Some(local(ip));
    }
    // A `.local` name is found by asking the network itself (mDNS), which
    // is the local network however it answers.
    if host.trim_end_matches('.').ends_with(".local") {
        return Some(true);
    }
    let port = url.port_or_known_default()?;
    let found = tokio::time::timeout(LOOKUP, tokio::net::lookup_host((host, port)))
        .await
        .ok()?
        .ok()?;
    let mut any = false;
    for address in found {
        if local(address.ip()) {
            return Some(true);
        }
        any = true;
    }
    any.then_some(false)
}

/// Whether Android counts `ip` as the local network: Google's "Local
/// network definition" (developer.android.com/privacy-and-security/
/// local-network-definition). The private ranges, link-local, the shared
/// 100.64/10 (carrier NAT, and Tailscale's), multicast and broadcast; on
/// IPv6, link-local, unique local and multicast.
///
/// Android counts these only on Wi-Fi or Ethernet, not over mobile data or
/// a VPN, so a server reached through Tailscale asks once when it needn't,
/// and still works when the answer is no. A global IPv6 address on the
/// phone's own subnet is local to Android too, and isn't caught here: a
/// server at one waits until the request gives up.
fn local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [first, second, ..] = v4.octets();
            v4.is_private()
                || v4.is_link_local()
                || (first == 100 && second & 0b1100_0000 == 0b0100_0000)
                || v4.is_multicast()
                || v4.is_broadcast()
        }
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => local(IpAddr::V4(v4)),
            None => {
                let first = v6.segments()[0];
                first & 0xffc0 == 0xfe80 || first & 0xfe00 == 0xfc00 || v6.is_multicast()
            }
        },
    }
}

#[cfg(target_os = "android")]
mod platform {
    use jni::objects::{JString, JValue};

    use crate::phone_sound::android::{app_class, with_env};

    /// `LocalNetwork.state(context, ask)`: `granted`, `asking` or `denied`.
    pub fn state(ask: bool) -> Option<String> {
        with_env(|env, app| {
            let class = app_class(env, app, "io.github.itsmattguenther.linger.LocalNetwork")?;
            let answer = env
                .call_static_method(
                    &class,
                    "state",
                    "(Landroid/content/Context;Z)Ljava/lang/String;",
                    &[JValue::Object(app), JValue::Bool(u8::from(ask))],
                )
                .ok()?
                .l()
                .ok()?;
            let answer: String = env.get_string(&JString::from(answer)).ok()?.into();
            Some(answer)
        })
    }
}

#[cfg(all(mobile, not(target_os = "android")))]
mod platform {
    //! An iPhone asks by itself the first time Linger reaches its network
    //! (`Info.ios.plist`), so there's nothing to ask here.

    pub fn state(_ask: bool) -> Option<String> {
        Some("granted".to_string())
    }
}

#[cfg(test)]
mod tests {
    use std::net::IpAddr;

    use super::{local, on_this_network};

    fn ip(text: &str) -> IpAddr {
        text.parse().expect("an address")
    }

    #[test]
    fn the_local_network_is_what_android_counts() {
        for each in [
            "10.0.2.2",
            "10.255.255.255",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.1.50",
            "169.254.10.1",
            "100.64.0.1",
            "100.127.255.254",
            "224.0.0.251",
            "239.255.255.250",
            "255.255.255.255",
            "fe80::1",
            "fc00::1",
            "fd12:3456::1",
            "ff02::fb",
            "::ffff:192.168.1.50",
        ] {
            assert!(local(ip(each)), "{each} is on the phone's network");
        }
        for each in [
            "127.0.0.1",
            "8.8.8.8",
            "167.99.152.132",
            "172.15.255.255",
            "172.32.0.1",
            "100.63.255.255",
            "100.128.0.1",
            "192.169.0.1",
            "::1",
            "2001:db8::1",
            "2606:4700::1111",
            "::ffff:8.8.8.8",
        ] {
            assert!(!local(ip(each)), "{each} isn't on the phone's network");
        }
    }

    #[tokio::test]
    async fn a_server_is_judged_by_where_its_address_is() {
        assert_eq!(on_this_network("https://192.168.1.50").await, Some(true));
        assert_eq!(on_this_network("http://10.0.2.2:8420").await, Some(true));
        assert_eq!(on_this_network("https://[fd00::5]:8443").await, Some(true));
        assert_eq!(on_this_network("https://linger.local").await, Some(true));
        assert_eq!(on_this_network("https://167.99.152.132").await, Some(false));
        // The phone itself (`adb reverse` in development) isn't its network.
        assert_eq!(on_this_network("http://localhost:8420").await, Some(false));
        // A voice call's addresses, as the page writes them (#900 review).
        assert_eq!(on_this_network("udp://10.0.2.2:3479").await, Some(true));
        assert_eq!(on_this_network("udp://[fd00::5]:3479").await, Some(true));
        assert_eq!(
            on_this_network("tcp://167.99.152.132:3479").await,
            Some(false)
        );
        assert_eq!(on_this_network("turn://localhost:3478").await, Some(false));
        assert_eq!(on_this_network("not an address").await, None);
        assert_eq!(on_this_network("https://nothing.invalid").await, None);
    }
}

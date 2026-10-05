//! The server's entry point: read env config, open the database, serve — or run
//! the one maintenance subcommand and exit.

use std::io::BufRead;

use linger_server::{db, display, expiry, reset};
use tracing_subscriber::EnvFilter;

const USAGE: &str = "\
linger-server — one binary, one data directory.

  linger-server
      Serve. Configured by the LINGER_* environment variables.

  linger-server reset-password <username>
      Set a new password for that account, and print it.

  linger-server reset-password <username> --stdin
      Same, but read the new password from stdin instead of making one up.

Stop the server before resetting a password — one SQLite file has one writer:

  docker compose stop linger
  docker compose run --rm linger reset-password <username>
  docker compose start linger
";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        None => serve().await,
        Some("reset-password") => reset_password(&args[1..]).await,
        Some("help" | "--help" | "-h") => {
            print!("{USAGE}");
            Ok(())
        }
        Some(other) => {
            eprint!("{USAGE}");
            anyhow::bail!("Don't know what to do with {other:?}.");
        }
    }
}

/// `reset-password <username> [--stdin]`.
///
/// Hand-parsed on purpose: the workspace has no argument-parsing dependency and
/// one subcommand does not justify adding one.
async fn reset_password(args: &[String]) -> anyhow::Result<()> {
    let mut username: Option<&str> = None;
    let mut from_stdin = false;
    for arg in args {
        match arg.as_str() {
            "--stdin" => from_stdin = true,
            other if other.starts_with('-') => {
                eprint!("{USAGE}");
                anyhow::bail!("Don't know the option {other:?}.");
            }
            other if username.is_none() => username = Some(other),
            other => {
                eprint!("{USAGE}");
                anyhow::bail!(
                    "Didn't expect {other:?}. The new password is never passed on the \
                     command line — it would be left in your shell history and readable \
                     in `ps`. Leave it off and one gets made for you, or pass --stdin \
                     and pipe it in."
                );
            }
        }
    }
    let Some(username) = username else {
        eprint!("{USAGE}");
        anyhow::bail!("Which account? Give it a username.");
    };

    let config = linger_server::config::Config::from_env()?;
    let db = db::open_writer(&config.db_path()).await?;

    let password = if from_stdin {
        let mut typed = String::new();
        std::io::stdin().lock().read_line(&mut typed)?;
        // Only the line ending goes: a password is allowed to end in a space,
        // and quietly trimming one would lock somebody out a second time.
        typed.trim_end_matches(['\n', '\r']).to_string()
    } else {
        reset::generate_password()
    };

    let done = reset::reset_password(&db, username, &password).await?;
    db.close().await;

    let who = &done.username;
    println!("\n  Password reset for {who} ({}).", done.display_name);
    if !from_stdin {
        println!("\n  New password:  {password}");
    }
    println!("\n  Everything signed in as {who} has been signed out. Sign in with this");
    println!("  password, then change it in the app under your own name.");
    if done.removed {
        println!("\n  Note: {who} is currently removed from this server, so the new password");
        println!("  won't get them in until the host lets them back in.");
    }
    println!();
    Ok(())
}

async fn serve() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let mut config = linger_server::config::Config::from_env()?;
    tracing::info!(data_dir = %config.data_dir.display(), bind = %config.bind, "starting linger-server");

    // No voice address set: the domain already points at this machine, so
    // its address is where clients send voice (#440).
    if let (Some(bind), Some(domain)) = (config.voice_from_domain, config.domain.clone()) {
        config.voice_forwarding = linger_server::config::voice_from_domain(&domain, bind).await;
    }

    // Said at every start, not only the first one: a server with no name runs
    // perfectly well and is unreachable from every installed client, and the
    // gap between those two facts is where a host loses an evening. It is a
    // warning rather than a refusal because a bare bind address is a real
    // deployment — it is what every test server and every `pnpm tauri dev`
    // session runs as.
    if config.domain.is_none() {
        tracing::warn!(
            "LINGER_DOMAIN is not set, so this server has no name and no certificate. \
             An installed Linger client only talks to https addresses and cannot reach \
             it — only a development build can. Uploads are also served from the same \
             origin as the app, without the split that keeps somebody's file from \
             impersonating it. See docs/host-guide.md."
        );
    }

    // Same idea for voice: a server without forwarding carries none at all
    // since the mesh was taken out (#306). The app says so to everybody, and
    // the host should hear it first, here.
    // A domain that couldn't give an address has said why already.
    if config.voice_forwarding.is_none() && config.voice_from_domain.is_none() {
        tracing::warn!(
            "This server carries no voice: LINGER_VOICE_ADDRESS is off, or it isn't set \
             and there's no LINGER_DOMAIN to work it out from. Nobody can join a voice \
             room, and the app says voice isn't set up here. Point LINGER_DOMAIN at this \
             machine (or set LINGER_VOICE_ADDRESS to its public IP address) and open UDP \
             port 3479 — see docs/host-guide.md."
        );
    } else if config.voice_forwarding.is_some() && config.turn.is_none() {
        // The relay is for the people voice can't reach otherwise: a network
        // that blocks the voice port fails looking exactly like a bug in the
        // app, the first time somebody tries from one.
        tracing::warn!(
            "LINGER_TURN_SECRET is not set, so there is no voice relay. Voice goes through \
             this server on UDP port 3479; anybody on a network that blocks it (some offices \
             and public wifi) can't join a call. Run the coturn container from \
             deploy/compose.yaml and set the same secret in both — see docs/host-guide.md."
        );
    }

    let db = db::init(&config.db_path()).await?;
    tokio::fs::create_dir_all(config.objects_dir()).await?;

    let bind = config.bind;
    let setup_origin = config.setup_origin();
    let state = linger_server::AppState::build(db, config).await?;

    // First run: no users yet, so hand the host their one-time setup URL.
    // Printed to stdout on purpose — `docker compose logs linger` is the flow.
    if let Some(token) = state.setup.peek() {
        // Scheme matters: the client keeps whatever it is handed, for the REST
        // base URL and the gateway socket alike. A configured LINGER_DOMAIN
        // means the documented deployment has Caddy terminating TLS in front
        // (ARCHITECTURE §9), so the reachable address is https — printing http
        // there would pin the host's own session to plaintext on their first
        // action. `Config::setup_origin` works the address out, and says
        // whether an installed client can reach it at all.
        println!("\n  ┌─────────────────────────────────────────────────");
        println!("  │  This server isn't set up yet.");
        println!("  │  Open:  {}/setup?token={token}", setup_origin.url);
        println!("  │  (the link works once, then never again)");
        println!("  │  Paste it into the Linger app, not a browser.");
        if !setup_origin.reachable {
            println!("  │");
            println!("  │  That address is http, and an installed Linger");
            println!("  │  app only talks https — it cannot reach this");
            println!("  │  server. Only a development build can. Set");
            println!("  │  LINGER_DOMAIN and put a name in front of it:");
            println!("  │  see docs/host-guide.md.");
        }
        println!("  └─────────────────────────────────────────────────\n");
    }

    // The one *scheduled* background job (ARCHITECTURE §1): files age out
    // at LINGER_FILE_EXPIRY_DAYS unless they are starred or on a pinned
    // message. It sweeps once now and then every few hours, and it lives here
    // rather than in `AppState` so that building the state — which every
    // integration test does — never starts a task nobody asked for. Exports
    // (T-801) are the other background work, but one is spawned per request
    // rather than running on a clock.
    let _sweeper = expiry::spawn(state.clone());
    // Display copies for images uploaded before the server made them (#382):
    // once, at startup, newest first, until every image has one.
    let _copies = display::spawn(state.clone());

    let app = linger_server::app(state);
    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!("listening on {bind}");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}

async fn shutdown_signal() {
    // SIGINT or SIGTERM: finish in-flight requests, then stop. Docker sends
    // SIGTERM on `compose down`; without this, every restart looks like a crash.
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            sig.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    tracing::info!("shutting down");
}

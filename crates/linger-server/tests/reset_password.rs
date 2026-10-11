//! `linger-server reset-password` — the locked-out host's way back in (T-414).
//!
//! These drive the real binary against the real database of a running test
//! server, because the thing being tested is a command somebody types on a box
//! at a bad moment: the argument parsing, the printed password and the exit code
//! are the feature, not implementation detail behind it.

mod common;

use std::io::Write;
use std::process::{Command, Stdio};

use common::{bootstrap_host, join_member, spawn_server, TestServer};

/// Run the server binary as a subcommand against this test server's data dir.
fn run(server: &TestServer, args: &[&str], stdin_line: Option<&str>) -> std::process::Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_linger-server"))
        .args(args)
        .env("LINGER_DATA_DIR", &server.state.config.data_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("run linger-server");
    if let Some(line) = stdin_line {
        let mut stdin = child.stdin.take().expect("piped stdin");
        writeln!(stdin, "{line}").unwrap();
    }
    child.wait_with_output().expect("wait for linger-server")
}

/// The password out of the command's own output, the way a host reads it.
fn printed_password(stdout: &str) -> String {
    stdout
        .lines()
        .find_map(|line| line.split_once("New password:"))
        .map(|(_, password)| password.trim().to_string())
        .unwrap_or_else(|| panic!("no password in output:\n{stdout}"))
}

async fn login(server: &TestServer, username: &str, password: &str) -> reqwest::StatusCode {
    reqwest::Client::new()
        .post(server.url("/auth/login"))
        .json(&serde_json::json!({ "username": username, "password": password }))
        .send()
        .await
        .unwrap()
        .status()
}

#[tokio::test]
async fn the_generated_password_gets_the_host_back_in_and_kills_the_old_one() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;

    let out = run(&server, &["reset-password", "matt"], None);
    assert!(
        out.status.success(),
        "reset-password failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    let password = printed_password(&stdout);

    assert_eq!(login(&server, "matt", &password).await, 200);
    assert_eq!(
        login(&server, "matt", "correct horse battery").await,
        401,
        "the old password must stop working"
    );

    // Signed out everywhere: the refresh token the host was holding is dead, so
    // a client that never noticed is not quietly kept alive by rotation.
    let refreshed = reqwest::Client::new()
        .post(server.url("/auth/refresh"))
        .json(&serde_json::json!({ "refresh_token": host.refresh_token }))
        .send()
        .await
        .unwrap();
    assert_eq!(refreshed.status(), 401);

    // And the access token it was holding, which used to have up to fifteen
    // minutes left in it (#496).
    let me = reqwest::Client::new()
        .get(server.url("/me"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(me.status(), 401, "an access token from before the reset");
}

#[tokio::test]
async fn stdin_sets_the_password_it_was_given_and_prints_nothing() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    join_member(&server, &host.access_token, "nadia").await;

    let out = run(
        &server,
        &["reset-password", "NADIA", "--stdin"],
        Some("a password nadia picked"),
    );
    assert!(
        out.status.success(),
        "reset-password failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        !stdout.contains("New password:"),
        "a password that was piped in must not be echoed back: {stdout}"
    );

    // The username was shouted; usernames are stored lowercase and login
    // lowercases what it is given, so the reset has to as well.
    assert_eq!(
        login(&server, "nadia", "a password nadia picked").await,
        200
    );
}

#[tokio::test]
async fn a_wrong_username_is_a_plain_sentence_and_a_non_zero_exit() {
    let server = spawn_server().await;
    bootstrap_host(&server).await;

    let out = run(&server, &["reset-password", "mat"], None);
    assert!(!out.status.success(), "a typo must not exit 0");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("There is no account called \"mat\" on this server."),
        "unhelpful error: {stderr}"
    );

    // And it changed nothing on the way out.
    assert_eq!(login(&server, "matt", "correct horse battery").await, 200);
}

#[tokio::test]
async fn the_password_is_never_an_argument() {
    let server = spawn_server().await;
    bootstrap_host(&server).await;

    let out = run(&server, &["reset-password", "matt", "hunter2hunter2"], None);
    assert!(!out.status.success());
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("shell history"),
        "unhelpful error: {stderr}"
    );
    assert_eq!(login(&server, "matt", "hunter2hunter2").await, 401);
}

#[tokio::test]
async fn a_too_short_password_is_refused_before_anything_is_written() {
    let server = spawn_server().await;
    bootstrap_host(&server).await;

    let err = linger_server::reset::reset_password(&server.state.db.write, "matt", "short")
        .await
        .expect_err("five characters is under the floor");
    assert!(err.to_string().contains("at least"), "{err}");
    assert_eq!(login(&server, "matt", "correct horse battery").await, 200);
}

#[tokio::test]
async fn a_missing_database_says_so_instead_of_making_one() {
    let dir = tempfile::tempdir().unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_linger-server"))
        .args(["reset-password", "matt"])
        .env("LINGER_DATA_DIR", dir.path())
        .output()
        .expect("run linger-server");

    assert!(!out.status.success());
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("no Linger database"), "unhelpful: {stderr}");
    assert!(
        !dir.path().join("linger.db").exists(),
        "a typo in LINGER_DATA_DIR must not leave an empty server behind"
    );
}

//! Users, styling, statuses (PROTOCOL §5). The heart of it: every closed-set key
//! is validated server-side — the AGENTS.md hard rule.

mod common;

use linger_core::wire::User;

#[tokio::test]
async fn patch_me_round_trips_style_and_status() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let client = reqwest::Client::new();

    let updated: User = client
        .patch(server.url("/me"))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({
            "display_name": "Matt 💾",
            "style": {
                "font_key": "departure-mono",
                "weight": 700,
                "italic": false,
                "fill": { "kind": "gradient", "from": "teal", "to": "violet" },
                "effect": "shimmer",
                "msg_font_key": "newsreader"
            },
            "status": {
                "line": "mounting the drive",
                "reading": null, "listening": "Bill Evans", "working_on": "the media grid",
                "image_id": null, "image_url": null,
                "away_message": null, "away_since": null
            },
            "entrance_sound": "screen-door"
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    assert_eq!(updated.display_name, "Matt 💾");
    assert_eq!(updated.style.font_key, "departure-mono");
    assert_eq!(updated.style.weight, 700);
    assert_eq!(updated.entrance_sound.as_deref(), Some("screen-door"));
    let status = updated.status.expect("status saved");
    assert_eq!(status.listening.as_deref(), Some("Bill Evans"));

    // Everyone else sees the styled name through GET /users.
    let users: Vec<User> = client
        .get(server.url("/users"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(users[0].style.font_key, "departure-mono");

    // Clearing the entrance sound with "".
    let cleared: User = client
        .patch(server.url("/me"))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "entrance_sound": "" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(cleared.entrance_sound.is_none());
}

#[tokio::test]
async fn server_rejects_every_off_list_key() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let client = reqwest::Client::new();

    let base_style = serde_json::json!({
        "font_key": "geist-sans", "weight": 500, "italic": false,
        "fill": { "kind": "solid", "color": "slate" },
        "effect": "none", "msg_font_key": null
    });

    let mut cases: Vec<serde_json::Value> = Vec::new();
    let mut with = |patch: serde_json::Value| {
        let mut style = base_style.clone();
        style
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        cases.push(serde_json::json!({ "style": style }));
    };
    with(serde_json::json!({ "font_key": "comic-sans" }));
    with(serde_json::json!({ "msg_font_key": "papyrus" }));
    with(serde_json::json!({ "weight": 600 }));
    with(serde_json::json!({ "fill": { "kind": "solid", "color": "#ff00ff" } }));
    with(serde_json::json!({ "fill": { "kind": "gradient", "from": "teal", "to": "hotpink" } }));
    cases.push(serde_json::json!({ "entrance_sound": "airhorn" }));
    cases.push(serde_json::json!({ "status": { "line": "x".repeat(241) } }));
    cases.push(serde_json::json!({ "display_name": "" }));

    for case in cases {
        let resp = client
            .patch(server.url("/me"))
            .bearer_auth(&host.access_token)
            .json(&case)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 422, "should reject {case}");
    }
}

#[tokio::test]
async fn away_message_stamps_away_since_server_side() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let client = reqwest::Client::new();

    // Client-sent away_since is ignored; the server stamps it.
    let user: User = client
        .patch(server.url("/me"))
        .bearer_auth(&host.access_token)
        .json(
            &serde_json::json!({ "status": { "away_message": "back after work", "away_since": 1 } }),
        )
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let since = user
        .status
        .unwrap()
        .away_since
        .expect("server stamps away_since");
    assert!(
        since > 1_600_000_000_000,
        "must be a real timestamp, not the client's value"
    );

    // Same message ⇒ stamp is stable; clearing ⇒ stamp clears.
    let user: User = client
        .patch(server.url("/me"))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "status": { "away_message": "back after work" } }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(user.status.unwrap().away_since, Some(since));

    let user: User = client
        .patch(server.url("/me"))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "status": { "away_message": null } }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(user.status.unwrap().away_since.is_none());
}

#[tokio::test]
async fn password_change_verifies_current_and_revokes_refresh_tokens() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let client = reqwest::Client::new();

    let wrong = client
        .patch(server.url("/me/password"))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({
            "current_password": "not it", "new_password": "a brand new passphrase"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), 403);

    let ok = client
        .patch(server.url("/me/password"))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({
            "current_password": "correct horse battery", "new_password": "a brand new passphrase"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status(), 204);

    // Old refresh token is dead; new password logs in.
    let refresh = client
        .post(server.url("/auth/refresh"))
        .json(&serde_json::json!({ "refresh_token": host.refresh_token }))
        .send()
        .await
        .unwrap();
    assert_eq!(refresh.status(), 401);

    let login = client
        .post(server.url("/auth/login"))
        .json(&serde_json::json!({ "username": "matt", "password": "a brand new passphrase" }))
        .send()
        .await
        .unwrap();
    assert_eq!(login.status(), 200);
}

#[tokio::test]
async fn notify_rules_upsert_and_delete_including_all_rooms() {
    let (server, host, room) = common::server_with_room("garage").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let client = reqwest::Client::new();

    // All-rooms rule (room_id null), twice — must not duplicate.
    for _ in 0..2 {
        let resp = client
            .put(server.url("/me/notify-rules"))
            .bearer_auth(&host.access_token)
            .json(&serde_json::json!({ "target_user_id": member.user.id, "room_id": null }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 204);
    }
    // Plus a per-room rule.
    let resp = client
        .put(server.url("/me/notify-rules"))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "target_user_id": member.user.id, "room_id": room.id }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 204);

    let rules: Vec<serde_json::Value> = client
        .get(server.url("/me/notify-rules"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(rules.len(), 2);

    let resp = client
        .delete(server.url("/me/notify-rules"))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "target_user_id": member.user.id, "room_id": null }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 204);

    let rules: Vec<serde_json::Value> = client
        .get(server.url("/me/notify-rules"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(rules.len(), 1);
}

/// T-413. Setting `deactivated_at` is about a quarter of removing somebody; the
/// rest is the three doors that do not read that column on their own. This
/// walks every one of them, plus the two things removal must *not* touch.
#[tokio::test]
async fn removing_a_member_shuts_every_door_and_restore_reopens_them() {
    let (server, host, room) = common::server_with_room("garage").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let client = reqwest::Client::new();

    // Something of theirs to leave behind, and an invite of theirs to kill.
    let message: serde_json::Value = client
        .post(server.url(&format!("/rooms/{}/messages", room.id)))
        .bearer_auth(&member.access_token)
        .json(&serde_json::json!({ "body": "anyone around?" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let their_invite: linger_core::wire::Invite = client
        .post(server.url("/invites"))
        .bearer_auth(&member.access_token)
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    // Host-only, and the host cannot remove themselves.
    let by_member = client
        .post(server.url(&format!("/users/{}/remove", host.user.id)))
        .bearer_auth(&member.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(by_member.status(), 403, "only the host removes people");
    let self_removal = client
        .post(server.url(&format!("/users/{}/remove", host.user.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(
        self_removal.status(),
        403,
        "the host cannot remove the host"
    );

    let removed = client
        .post(server.url(&format!("/users/{}/remove", member.user.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(removed.status(), 204);

    // Off the roster.
    let users: Vec<User> = client
        .get(server.url("/users"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        users.iter().all(|u| u.id != member.user.id),
        "a removed member is gone from GET /users"
    );

    // Their access token stops working now, not in fifteen minutes.
    let with_old_token = client
        .get(server.url("/me"))
        .bearer_auth(&member.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(with_old_token.status(), 401);

    // And they cannot mint a new one.
    let refresh = client
        .post(server.url("/auth/refresh"))
        .json(&serde_json::json!({ "refresh_token": member.refresh_token }))
        .send()
        .await
        .unwrap();
    assert_eq!(refresh.status(), 401);

    // Nor sign in again with a password that is still correct.
    let login = client
        .post(server.url("/auth/login"))
        .json(&serde_json::json!({
            "username": "callie", "password": "a perfectly fine password"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(login.status(), 401);

    // Their own invite link is not a way back in.
    let preview: serde_json::Value = client
        .get(server.url(&format!("/auth/invite/{}", their_invite.code)))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(preview["valid"], false);

    // What they wrote stays (SPEC principle 3).
    let page: Vec<serde_json::Value> = client
        .get(server.url(&format!("/rooms/{}/messages", room.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        page.iter().any(|m| m["id"] == message["id"]),
        "removing a person is not deleting what they wrote"
    );

    // The host can find them again, which is what makes restore reachable.
    let gone: Vec<User> = client
        .get(server.url("/users/removed"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(gone.len(), 1);
    assert_eq!(gone[0].id, member.user.id);

    // Back in, and able to sign in with the password they always had.
    let restore = client
        .post(server.url(&format!("/users/{}/restore", member.user.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(restore.status(), 204);

    let users: Vec<User> = client
        .get(server.url("/users"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(users.iter().any(|u| u.id == member.user.id));

    let login = client
        .post(server.url("/auth/login"))
        .json(&serde_json::json!({
            "username": "callie", "password": "a perfectly fine password"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(login.status(), 200, "restore is a way back in");

    // Restore is not an undo: the invite they had made stays revoked.
    let preview: serde_json::Value = client
        .get(server.url(&format!("/auth/invite/{}", their_invite.code)))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(preview["valid"], false);
}

#[tokio::test]
async fn remove_and_restore_answer_not_found_for_a_stranger() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let client = reqwest::Client::new();
    let nobody = linger_core::UserId::new();

    for path in [
        format!("/users/{nobody}/remove"),
        format!("/users/{nobody}/restore"),
    ] {
        let resp = client
            .post(server.url(&path))
            .bearer_auth(&host.access_token)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 404, "{path}");
    }
}

/// Where a person's dot takes its color from: the first color of their name.
fn dot(user: &User) -> String {
    match &user.style.fill {
        linger_core::wire::Fill::Solid { color } => color.0.clone(),
        linger_core::wire::Fill::Gradient { from, .. } => from.0.clone(),
    }
}

#[tokio::test]
async fn newcomers_start_on_the_least_worn_color_not_everyone_gray() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    // The host sets the server up and starts on the first color in line.
    assert_eq!(dot(&host.user), "ember");
    // Everyone after gets a color nobody wears yet, far from the last one's.
    let mut seen = vec![dot(&host.user)];
    for name in ["eli", "jules", "dave", "callie"] {
        let member = common::join_member(&server, &host.access_token, name).await;
        seen.push(dot(&member.user));
    }
    assert_eq!(seen, ["ember", "teal", "rose", "mint", "orchid"]);
    // Only the color is chosen; the rest of the name is the default.
    let fresh = common::join_member(&server, &host.access_token, "sam").await;
    assert_eq!(fresh.user.style.font_key, "geist-sans");
    assert_eq!(fresh.user.style.weight, 500);
    assert!(!fresh.user.style.italic);
}

#[tokio::test]
async fn a_color_somebody_chose_counts_and_somebody_removed_doesnt() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let client = reqwest::Client::new();
    // The host moves off ember onto teal, the next color in line.
    let resp = client
        .patch(server.url("/me"))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({
            "style": {
                "font_key": "geist-sans", "weight": 500, "italic": false,
                "fill": { "kind": "solid", "color": "teal" },
                "effect": "none", "msg_font_key": null
            }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    // So the first newcomer gets ember back, and teal is skipped.
    let eli = common::join_member(&server, &host.access_token, "eli").await;
    assert_eq!(dot(&eli.user), "ember");
    let jules = common::join_member(&server, &host.access_token, "jules").await;
    assert_eq!(dot(&jules.user), "rose");
    // Somebody removed no longer wears their color.
    let resp = client
        .post(server.url(&format!("/users/{}/remove", jules.user.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success(), "remove: {}", resp.status());
    let dave = common::join_member(&server, &host.access_token, "dave").await;
    assert_eq!(dot(&dave.user), "rose");
}

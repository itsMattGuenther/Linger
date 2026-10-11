//! Server + rooms (PROTOCOL §3): host-only mutations, slug validation,
//! palette-key validation, ordering.

mod common;

use linger_core::wire::{ErrorCode, ErrorEnvelope, Room, ServerInfo};

#[tokio::test]
async fn host_creates_rooms_members_do_not() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let client = reqwest::Client::new();

    let created: Room = client
        .post(server.url("/rooms"))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "slug": "garage", "name": "#garage", "topic": "projects" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(created.slug, "garage");
    assert_eq!(created.position, 0);
    assert!(created.last_message_id.is_none());

    let denied = client
        .post(server.url("/rooms"))
        .bearer_auth(&member.access_token)
        .json(&serde_json::json!({ "slug": "shed", "name": "#shed" }))
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), 403);
    let env: ErrorEnvelope = denied.json().await.unwrap();
    assert_eq!(env.error.code, ErrorCode::Forbidden);

    // Members can still see the rooms.
    let rooms: Vec<Room> = client
        .get(server.url("/rooms"))
        .bearer_auth(&member.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(rooms.len(), 1);
}

#[tokio::test]
async fn slug_rules_and_uniqueness() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let client = reqwest::Client::new();

    for bad_slug in [
        "",
        "Garage",
        "the garage",
        "way-too-long-for-a-slug-way-too-long",
    ] {
        let resp = client
            .post(server.url("/rooms"))
            .bearer_auth(&host.access_token)
            .json(&serde_json::json!({ "slug": bad_slug, "name": "x" }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 422, "slug {bad_slug:?} should be rejected");
    }

    let ok = client
        .post(server.url("/rooms"))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "slug": "porch", "name": "#porch" }))
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status(), 200);

    let dup = client
        .post(server.url("/rooms"))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "slug": "porch", "name": "#porch again" }))
        .send()
        .await
        .unwrap();
    assert_eq!(dup.status(), 409);
}

#[tokio::test]
async fn patch_and_archive() {
    let (server, host, room) = common::server_with_room("garage").await;
    let client = reqwest::Client::new();

    let updated: Room = client
        .patch(server.url(&format!("/rooms/{}", room.id)))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "topic": "drives and drivers", "position": 3 }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(updated.topic.as_deref(), Some("drives and drivers"));
    assert_eq!(updated.position, 3);

    let archived: Room = client
        .post(server.url(&format!("/rooms/{}/archive", room.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(archived.archived_at.is_some());
}

#[tokio::test]
async fn server_patch_validates_the_palette_key() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let client = reqwest::Client::new();

    // Hex is exactly what the palette rule forbids on the wire.
    let bad = client
        .patch(server.url("/server"))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "accent_key": "#6E9BFF" }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), 422);

    let good: ServerInfo = client
        .patch(server.url("/server"))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "accent_key": "azure", "name": "the garage" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(good.accent_key.map(|c| c.0), Some("azure".to_string()));
    assert_eq!(good.name, "the garage");
}

/// A room's name and topic, and the server's name, can't turn themselves or
/// the words beside them around (#488): the characters that change the
/// direction of text are taken out, on the way in, whether the room is being
/// made or changed.
#[tokio::test]
async fn names_and_topics_lose_the_characters_that_turn_text_around() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let client = reqwest::Client::new();

    let created: Room = client
        .post(server.url("/rooms"))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({
            "slug": "garage", "name": "\u{202E}egarag", "topic": "drives\u{2066} and drivers"
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(created.name, "egarag");
    assert_eq!(created.topic.as_deref(), Some("drives and drivers"));

    let updated: Room = client
        .patch(server.url(&format!("/rooms/{}", created.id)))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "name": " garage\u{202C} ", "topic": "\u{200F}שלום" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(updated.name, "garage");
    assert_eq!(updated.topic.as_deref(), Some("שלום"));

    // A name of nothing but them is no name.
    let empty = client
        .patch(server.url(&format!("/rooms/{}", created.id)))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "name": "\u{202E}" }))
        .send()
        .await
        .unwrap();
    assert_eq!(empty.status(), 422);

    let named: ServerInfo = client
        .patch(server.url("/server"))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "name": "the \u{202D}porch" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(named.name, "the porch");
}

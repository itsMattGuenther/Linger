//! A server's own emoji (#359, PROTOCOL §5 "Custom emoji"): pictures the host
//! or a co-host adds for everybody on the server, written `:name:` in a
//! message. Anybody signed in reads the set; only the host's powers change it,
//! and every change goes to everybody as the whole set in `emoji.update`.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, patch};
use axum::{Json, Router};
use linger_core::gateway::ServerEvent;
use linger_core::EmojiId;
use linger_core::limits::{
    emoji_name_ok, EMOJI_MIMES, MAX_CUSTOM_EMOJI, MAX_EMOJI_BYTES, MAX_EMOJI_EDGE,
};
use linger_core::wire::{CreateEmojiRequest, CustomEmoji, RenameEmojiRequest};

use crate::auth::{AuthedUser, HostOrCohost};
use crate::db::now_ms;
use crate::error::ApiError;
use crate::repo;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/emoji", get(list).post(create))
        .route("/emoji/{id}", patch(rename).delete(remove))
}

const NAME_RULE: &str = "An emoji's name is 2 to 32 lowercase letters, digits or underscores.";

fn check_name(name: &str) -> Result<(), ApiError> {
    if emoji_name_ok(name) {
        Ok(())
    } else {
        Err(ApiError::validation(NAME_RULE))
    }
}

fn taken(name: &str) -> ApiError {
    ApiError::conflict(format!("There's already an emoji called :{name}:."))
}

/// Tell everybody the set as it now is.
async fn announce(state: &AppState) -> Result<(), ApiError> {
    let emoji = repo::emoji::all(&state.db.read, &state.config).await?;
    state.gateway.publish(ServerEvent::EmojiUpdate { emoji });
    Ok(())
}

/// `GET /emoji` — the whole set, by name, for anybody signed in.
async fn list(
    State(state): State<AppState>,
    _auth: AuthedUser,
) -> Result<Json<Vec<CustomEmoji>>, ApiError> {
    repo::emoji::all(&state.db.read, &state.config)
        .await
        .map(Json)
}

/// `POST /emoji` — a finished upload of the caller's, never posted, made into
/// an emoji. The picture went through the upload pipeline like any image, so
/// its type is what its bytes say and nothing hidden in it survived.
async fn create(
    State(state): State<AppState>,
    auth: HostOrCohost,
    Json(req): Json<CreateEmojiRequest>,
) -> Result<Json<CustomEmoji>, ApiError> {
    check_name(&req.name)?;
    if repo::emoji::count(&state.db.read).await? >= MAX_CUSTOM_EMOJI {
        return Err(ApiError::validation(format!(
            "A server has room for {MAX_CUSTOM_EMOJI} emoji. Remove one to add another."
        )));
    }

    let record = repo::attachments::record(&state.db.read, req.attachment_id)
        .await?
        .filter(|record| record.state == "complete" && record.uploader_id == auth.id)
        .ok_or_else(|| ApiError::not_found("No such upload."))?;
    if record.message_id.is_some() {
        return Err(ApiError::conflict(
            "That picture is on a message. Upload it again to make it an emoji.",
        ));
    }
    if repo::emoji::is_picture(&state.db.read, record.id).await? {
        return Err(ApiError::conflict("That picture is already an emoji."));
    }
    if !EMOJI_MIMES.contains(&record.mime.as_str()) {
        return Err(ApiError::unsupported_media(
            "An emoji is a PNG, GIF, WebP or JPEG picture.",
        ));
    }
    let (width, height): (Option<i64>, Option<i64>) =
        sqlx::query_as("SELECT width, height FROM attachments WHERE id = ?")
            .bind(record.id.to_vec())
            .fetch_one(&state.db.read)
            .await?;
    let edge = i64::from(MAX_EMOJI_EDGE);
    if record.size_bytes > MAX_EMOJI_BYTES
        || width.unwrap_or(0) > edge
        || height.unwrap_or(0) > edge
    {
        return Err(ApiError::validation(format!(
            "An emoji's picture can be at most {} KB and {MAX_EMOJI_EDGE} pixels wide or tall.",
            MAX_EMOJI_BYTES / 1024
        )));
    }
    if repo::emoji::name_taken(&state.db.read, &req.name, None).await? {
        return Err(taken(&req.name));
    }

    let id = EmojiId::new();
    let inserted = sqlx::query(
        "INSERT INTO custom_emoji (id, name, attachment_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id.to_vec())
    .bind(&req.name)
    .bind(record.id.to_vec())
    .bind(auth.id.to_vec())
    .bind(now_ms())
    .execute(&state.db.write)
    .await;
    match inserted {
        Ok(_) => {}
        // Two hosts at once: whichever came second hears why.
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            return Err(
                if repo::emoji::name_taken(&state.db.read, &req.name, None).await? {
                    taken(&req.name)
                } else {
                    ApiError::conflict("That picture is already an emoji.")
                },
            );
        }
        Err(e) => return Err(e.into()),
    }

    let emoji = repo::emoji::by_id(&state.db.read, &state.config, id)
        .await?
        .ok_or_else(ApiError::internal)?;
    announce(&state).await?;
    Ok(Json(emoji))
}

/// `PATCH /emoji/:id` — a new name. Messages keep the text they were sent
/// with, so ones that said the old name now read as that name.
async fn rename(
    State(state): State<AppState>,
    _auth: HostOrCohost,
    Path(id): Path<EmojiId>,
    Json(req): Json<RenameEmojiRequest>,
) -> Result<Json<CustomEmoji>, ApiError> {
    check_name(&req.name)?;
    if repo::emoji::by_id(&state.db.read, &state.config, id)
        .await?
        .is_none()
    {
        return Err(ApiError::not_found("No such emoji."));
    }
    if repo::emoji::name_taken(&state.db.read, &req.name, Some(id)).await? {
        return Err(taken(&req.name));
    }
    let updated = sqlx::query("UPDATE custom_emoji SET name = ? WHERE id = ?")
        .bind(&req.name)
        .bind(id.to_vec())
        .execute(&state.db.write)
        .await;
    match updated {
        Ok(_) => {}
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => return Err(taken(&req.name)),
        Err(e) => return Err(e.into()),
    }
    let emoji = repo::emoji::by_id(&state.db.read, &state.config, id)
        .await?
        .ok_or_else(|| ApiError::not_found("No such emoji."))?;
    announce(&state).await?;
    Ok(Json(emoji))
}

/// `DELETE /emoji/:id` — gone, picture and all. Messages that used it keep
/// the text `:name:`, which is what they then show.
async fn remove(
    State(state): State<AppState>,
    _auth: HostOrCohost,
    Path(id): Path<EmojiId>,
) -> Result<StatusCode, ApiError> {
    let picture = repo::emoji::picture_of(&state.db.read, id)
        .await?
        .ok_or_else(|| ApiError::not_found("No such emoji."))?;
    sqlx::query("DELETE FROM custom_emoji WHERE id = ?")
        .bind(id.to_vec())
        .execute(&state.db.write)
        .await?;

    // The picture goes with it, as a thrown-away upload does. A store that
    // can't delete right now leaves an unposted upload, which the expiry
    // sweeper takes in time now that it is no emoji's.
    if let Some(record) = repo::attachments::record(&state.db.read, picture).await? {
        let deleted = state.storage.delete_object(&record.object_key).await;
        if let Some(key) = &record.poster_key {
            let _ = state.storage.delete_object(key).await;
        }
        if let Some(key) = record
            .display_key
            .as_ref()
            .filter(|key| **key != record.object_key)
        {
            let _ = state.storage.delete_object(key).await;
        }
        if deleted.is_ok() {
            sqlx::query("DELETE FROM attachments WHERE id = ?")
                .bind(picture.to_vec())
                .execute(&state.db.write)
                .await?;
        }
    }

    announce(&state).await?;
    Ok(StatusCode::NO_CONTENT)
}

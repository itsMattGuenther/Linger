//! Users, styling, statuses, notify rules (PROTOCOL §5).

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use linger_core::gateway::ServerEvent;
use linger_core::wire::{ChangePasswordRequest, Fill, NotifyRule, UpdateMeRequest, User};
use linger_core::UserId;

use crate::auth::{self, AuthedUser, HostOrCohost, HostUser, Standing};
use crate::db::now_ms;
use crate::error::ApiError;
use crate::state::AppState;
use crate::{repo, status_fields, validate};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/users", get(list_users))
        // Static before dynamic on purpose: this reads as `/users/{id}` at a
        // glance, and only the router's static-segment precedence keeps
        // `removed` from being parsed as somebody's id.
        .route("/users/removed", get(list_removed))
        .route("/users/{id}", get(get_user))
        .route("/users/{id}/remove", post(remove_user))
        .route("/users/{id}/restore", post(restore_user))
        .route("/users/{id}/cohost", put(make_cohost).delete(clear_cohost))
        .route("/me", get(me).patch(patch_me))
        .route("/me/password", patch(change_password))
        .route(
            "/me/notify-rules",
            get(list_notify_rules)
                .put(put_notify_rule)
                .delete(delete_notify_rule),
        )
}

async fn list_users(
    State(state): State<AppState>,
    _auth: AuthedUser,
) -> Result<Json<Vec<User>>, ApiError> {
    repo::users::all(&state.db.read).await.map(Json)
}

async fn get_user(
    State(state): State<AppState>,
    _auth: AuthedUser,
    Path(id): Path<UserId>,
) -> Result<Json<User>, ApiError> {
    repo::users::expect(&state.db.read, id).await.map(Json)
}

/// The list of everybody who has been removed, for the host and the
/// co-hosts. Restore is useless if the people you could restore are not
/// written down anywhere (T-413).
async fn list_removed(
    State(state): State<AppState>,
    _host: HostOrCohost,
) -> Result<Json<Vec<User>>, ApiError> {
    repo::users::removed(&state.db.read).await.map(Json)
}

/// Take somebody off the server (PROTOCOL §5, T-413).
///
/// Setting the column is about a quarter of it. A removed member has to *stop
/// being in the room*, and there are three other doors: their refresh families
/// keep minting access tokens for 30 days, their live gateway socket keeps
/// receiving fan-out forever, and the invites they made are a way back in. All
/// four are shut here, the first three in one transaction.
///
/// Their messages are untouched. Removing a person is not deleting what they
/// wrote (SPEC principle 3).
///
/// The host or a co-host may remove anybody but themselves, and a co-host
/// may not remove the host (#424). Removing a co-host ends their being one:
/// a restore brings them back as a member, and only the host can make them a
/// co-host again. That gives a co-host no new power over another, since
/// removing somebody already does more than that.
async fn remove_user(
    State(state): State<AppState>,
    host: HostOrCohost,
    Path(id): Path<UserId>,
) -> Result<StatusCode, ApiError> {
    // `is_host` is a boolean nobody can hand on (`docs/decisions.md`, *the
    // host's side*), so a host who removed themselves would leave a server no
    // one could ever add a room to again.
    if id == host.id {
        return Err(ApiError::forbidden(if host.standing == Standing::Host {
            "You can't remove yourself from your own server."
        } else {
            "You can't remove yourself."
        }));
    }
    host.not_on_the_host(&state.db.read, id, "A co-host can't remove the host.")
        .await?;
    expect_account(&state, id).await?;

    let now = now_ms();
    let mut tx = state.db.write.begin().await.map_err(ApiError::from)?;
    sqlx::query(
        "UPDATE users SET deactivated_at = ?, is_cohost = 0 WHERE id = ? AND deactivated_at IS NULL",
    )
    .bind(now)
    .bind(id.to_vec())
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
    )
    .bind(now)
    .bind(id.to_vec())
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE invites SET revoked_at = ? WHERE created_by = ? AND revoked_at IS NULL")
        .bind(now)
        .bind(id.to_vec())
        .execute(&mut *tx)
        .await?;
    tx.commit().await.map_err(ApiError::from)?;

    // Written first, then enforced: a socket closed before the column is
    // committed could reconnect into an account that is still live.
    state.gateway.close_sessions_for(id).await;
    // A removed member stops being in the DMs they were in (SPEC §4.13). The
    // membership rows survive on purpose — `restore_user` puts them back
    // without anything having had to remember what they were — so it is the
    // deactivation that ends it, and the gateway's audience index has to be
    // told, because it is a snapshot rather than a query.
    state.gateway.reload_dms(&state.db.read).await?;
    state
        .gateway
        .publish(ServerEvent::UserRemove { user_id: id });
    Ok(StatusCode::NO_CONTENT)
}

/// Let somebody back in. The reverse of [`remove_user`], and deliberately not
/// its exact undo: the invites they had made stay revoked, and their sign-ins
/// stay dead, so they come back through the front door with their password.
async fn restore_user(
    State(state): State<AppState>,
    _host: HostOrCohost,
    Path(id): Path<UserId>,
) -> Result<StatusCode, ApiError> {
    expect_account(&state, id).await?;
    sqlx::query("UPDATE users SET deactivated_at = NULL WHERE id = ?")
        .bind(id.to_vec())
        .execute(&state.db.write)
        .await?;

    // Back into the DMs they were in, which is the other half of the rows
    // having survived removal.
    state.gateway.reload_dms(&state.db.read).await?;

    // `user.update` is "here is this person, whether or not you had them"
    // (PROTOCOL §8), so every connected client grows the card back on its own.
    let user = repo::users::expect(&state.db.read, id).await?;
    state.gateway.publish(ServerEvent::UserUpdate(user));
    Ok(StatusCode::NO_CONTENT)
}

/// `PUT /users/:id/cohost` — the host makes somebody a co-host (#424).
async fn make_cohost(
    State(state): State<AppState>,
    host: HostUser,
    Path(id): Path<UserId>,
) -> Result<Json<User>, ApiError> {
    set_cohost(&state, host, id, true).await.map(Json)
}

/// `DELETE /users/:id/cohost` — they stop being a co-host.
async fn clear_cohost(
    State(state): State<AppState>,
    host: HostUser,
    Path(id): Path<UserId>,
) -> Result<Json<User>, ApiError> {
    set_cohost(&state, host, id, false).await.map(Json)
}

/// The one switch (#424): only the host turns it on or off, never on
/// themselves, and only for somebody on the server now. Setting it to what it
/// already is changes nothing and answers the same.
///
/// Everybody hears the person as they are now, in `user.update`: that is how
/// their own app learns to show them the host's controls, or stop, and how
/// everybody else's card says "co-host". The reports reach them from the
/// next `reports.changed`, which asks the database who to tell
/// (`routes/reports.rs`).
async fn set_cohost(
    state: &AppState,
    host: HostUser,
    id: UserId,
    on: bool,
) -> Result<User, ApiError> {
    if id == host.id {
        return Err(ApiError::validation(
            "You're the host. A co-host is somebody else.",
        ));
    }
    // Members only: somebody removed is not found, as everywhere else.
    repo::users::expect(&state.db.read, id).await?;
    sqlx::query(
        "UPDATE users SET is_cohost = ? WHERE id = ? AND is_host = 0 AND deactivated_at IS NULL",
    )
    .bind(i64::from(on))
    .bind(id.to_vec())
    .execute(&state.db.write)
    .await?;
    let user = repo::users::expect(&state.db.read, id).await?;
    state.gateway.publish(ServerEvent::UserUpdate(user.clone()));
    Ok(user)
}

/// An account row, removed or not. `repo::users` only ever sees active members,
/// which is right everywhere except the two endpoints that act on removed ones.
async fn expect_account(state: &AppState, id: UserId) -> Result<(), ApiError> {
    let found: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM users WHERE id = ?")
        .bind(id.to_vec())
        .fetch_optional(&state.db.read)
        .await?;
    found
        .map(|_| ())
        .ok_or_else(|| ApiError::not_found("No such person on this server."))
}

async fn me(State(state): State<AppState>, auth: AuthedUser) -> Result<Json<User>, ApiError> {
    repo::users::expect(&state.db.read, auth.id).await.map(Json)
}

async fn patch_me(
    State(state): State<AppState>,
    auth: AuthedUser,
    Json(req): Json<UpdateMeRequest>,
) -> Result<Json<User>, ApiError> {
    // Validate everything before writing anything — a PATCH is all-or-nothing.
    //
    // The name rules apply when a name is set or changed (#296). A name saved
    // before them stays, and sending it back as it is changes nothing, so it
    // is not held to them.
    if let Some(name) = &req.display_name {
        let held = repo::users::expect(&state.db.read, auth.id).await?;
        if name.trim() != held.display_name {
            validate::display_name(name)?;
        }
    }
    if let Some(style) = &req.style {
        validate::style(style)?;
    }
    // A status has no picture any more (#269). An older app still sends
    // `image_id`, so it is accepted and ignored: nothing is checked or stored
    // for it, and saving the rest of the status is never refused over it.
    if let Some(status) = &req.status {
        validate::status(status)?;
    }
    if let Some(sound) = &req.entrance_sound {
        if !sound.is_empty() && !linger_core::is_valid_entrance_sound_key(sound) {
            return Err(ApiError::validation(
                "That entrance sound isn't in the bundled set.",
            ));
        }
    }

    let mut tx = state.db.write.begin().await.map_err(ApiError::from)?;

    if let Some(name) = &req.display_name {
        sqlx::query("UPDATE users SET display_name = ? WHERE id = ?")
            .bind(name.trim())
            .bind(auth.id.to_vec())
            .execute(&mut *tx)
            .await?;
    }

    if let Some(style) = &req.style {
        let (fill_kind, fill_from, fill_to) = match &style.fill {
            Fill::Solid { color } => ("solid", color.0.clone(), None),
            Fill::Gradient { from, to } => ("gradient", from.0.clone(), Some(to.0.clone())),
        };
        let effect = match style.effect {
            linger_core::wire::NameEffect::None => "none",
            linger_core::wire::NameEffect::Shimmer => "shimmer",
            linger_core::wire::NameEffect::Glow => "glow",
        };
        sqlx::query(
            "INSERT INTO user_style
               (user_id, font_key, weight, italic, fill_kind, fill_from, fill_to, effect, msg_font_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET
               font_key = excluded.font_key, weight = excluded.weight,
               italic = excluded.italic, fill_kind = excluded.fill_kind,
               fill_from = excluded.fill_from, fill_to = excluded.fill_to,
               effect = excluded.effect, msg_font_key = excluded.msg_font_key",
        )
        .bind(auth.id.to_vec())
        .bind(&style.font_key)
        .bind(i64::from(style.weight))
        .bind(i64::from(style.italic))
        .bind(fill_kind)
        .bind(&fill_from)
        .bind(&fill_to)
        .bind(effect)
        .bind(&style.msg_font_key)
        .execute(&mut *tx)
        .await?;
    }

    if let Some(status) = &req.status {
        // `away_since` is server-owned: stamped when an away message appears or
        // changes, cleared with it.
        let prev_away: Option<(Option<String>, Option<i64>)> =
            sqlx::query_as("SELECT away_message, away_since FROM user_status WHERE user_id = ?")
                .bind(auth.id.to_vec())
                .fetch_optional(&mut *tx)
                .await?;
        let away_since = match (&status.away_message, prev_away) {
            (None, _) => None,
            (Some(new), Some((Some(old), Some(since)))) if new == &old => Some(since),
            (Some(_), _) => Some(now_ms()),
        };
        // The fields (#270). A list is the whole set, trimmed. No list is a
        // save from an app that predates them: its three keys change the
        // fields with those labels and every other field stays. Read on the
        // writer, inside this transaction, so two saves can't interleave.
        let fields = match &status.fields {
            Some(fields) => validate::status_fields(fields)?,
            None => {
                let held = repo::users::status_fields(&mut *tx, auth.id).await?;
                status_fields::apply_classic(held, status)?
            }
        };
        repo::users::set_status_fields(&mut tx, auth.id, &fields).await?;
        // The three old columns are kept in step with the fields, and never
        // read: statuses are built from the fields (`repo::users`).
        let classic = status_fields::classic_of(&fields);
        // `image_key` is not written: migration 0006 cleared it and it stays
        // empty (#269).
        sqlx::query(
            "INSERT INTO user_status
               (user_id, line, reading, listening, working_on,
                away_message, away_since, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET
               line = excluded.line, reading = excluded.reading,
               listening = excluded.listening, working_on = excluded.working_on,
               away_message = excluded.away_message,
               away_since = excluded.away_since, updated_at = excluded.updated_at",
        )
        .bind(auth.id.to_vec())
        .bind(&status.line)
        .bind(&classic.reading)
        .bind(&classic.listening)
        .bind(&classic.working_on)
        .bind(&status.away_message)
        .bind(away_since)
        .bind(now_ms())
        .execute(&mut *tx)
        .await?;
    }

    if let Some(sound) = &req.entrance_sound {
        if sound.is_empty() {
            sqlx::query("DELETE FROM entrance_sounds WHERE user_id = ?")
                .bind(auth.id.to_vec())
                .execute(&mut *tx)
                .await?;
        } else {
            sqlx::query(
                "INSERT INTO entrance_sounds (user_id, sound_key) VALUES (?, ?)
                 ON CONFLICT(user_id) DO UPDATE SET sound_key = excluded.sound_key",
            )
            .bind(auth.id.to_vec())
            .bind(sound)
            .execute(&mut *tx)
            .await?;
        }
    }

    tx.commit().await.map_err(ApiError::from)?;

    let user = repo::users::expect(&state.db.read, auth.id).await?;
    state.gateway.publish(ServerEvent::UserUpdate(user.clone()));
    Ok(Json(user))
}

async fn change_password(
    State(state): State<AppState>,
    auth: AuthedUser,
    Json(req): Json<ChangePasswordRequest>,
) -> Result<StatusCode, ApiError> {
    validate::password(&req.new_password)?;

    let hash: Option<String> = sqlx::query_scalar(
        "SELECT password_hash FROM users WHERE id = ? AND deactivated_at IS NULL",
    )
    .bind(auth.id.to_vec())
    .fetch_optional(&state.db.read)
    .await?;
    let Some(hash) = hash else {
        return Err(ApiError::unauthenticated());
    };

    if !state.passwords.verify(req.current_password, hash).await? {
        return Err(ApiError::forbidden("Current password doesn't match."));
    }

    let new_hash = state.passwords.hash(req.new_password).await?;
    sqlx::query("UPDATE users SET password_hash = ? WHERE id = ?")
        .bind(new_hash)
        .bind(auth.id.to_vec())
        .execute(&state.db.write)
        .await?;

    // Anyone holding an old refresh token (including a thief) re-logs-in.
    auth::revoke_all_for_user(&state.db.write, auth.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_notify_rules(
    State(state): State<AppState>,
    auth: AuthedUser,
) -> Result<Json<Vec<NotifyRule>>, ApiError> {
    let rows: Vec<(Vec<u8>, Option<Vec<u8>>)> =
        sqlx::query_as("SELECT target_user_id, room_id FROM notify_rules WHERE user_id = ?")
            .bind(auth.id.to_vec())
            .fetch_all(&state.db.read)
            .await?;
    let rules = rows
        .into_iter()
        .map(|(target, room)| {
            Ok(NotifyRule {
                target_user_id: UserId::from_slice(&target).map_err(anyhow::Error::from)?,
                room_id: room
                    .map(|r| linger_core::RoomId::from_slice(&r))
                    .transpose()
                    .map_err(anyhow::Error::from)?,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    Ok(Json(rules))
}

async fn put_notify_rule(
    State(state): State<AppState>,
    auth: AuthedUser,
    Json(rule): Json<NotifyRule>,
) -> Result<StatusCode, ApiError> {
    repo::users::expect(&state.db.read, rule.target_user_id).await?;
    if let Some(room) = rule.room_id {
        // A rule naming a DM you are not in is a way to ask whether that DM
        // exists, one guessed id at a time. It answers like any other room you
        // cannot see: not found.
        repo::rooms::visible_to(&state.db.read, room, auth.id).await?;
    }
    // SQLite treats NULLs as distinct in primary keys, so "delete then insert"
    // is the only reliable upsert for the all-rooms (NULL) rule.
    let mut tx = state.db.write.begin().await.map_err(ApiError::from)?;
    sqlx::query(
        "DELETE FROM notify_rules WHERE user_id = ? AND target_user_id = ? AND room_id IS ?",
    )
    .bind(auth.id.to_vec())
    .bind(rule.target_user_id.to_vec())
    .bind(rule.room_id.map(|r| r.to_vec()))
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO notify_rules (user_id, target_user_id, room_id) VALUES (?, ?, ?)")
        .bind(auth.id.to_vec())
        .bind(rule.target_user_id.to_vec())
        .bind(rule.room_id.map(|r| r.to_vec()))
        .execute(&mut *tx)
        .await?;
    tx.commit().await.map_err(ApiError::from)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_notify_rule(
    State(state): State<AppState>,
    auth: AuthedUser,
    Json(rule): Json<NotifyRule>,
) -> Result<StatusCode, ApiError> {
    sqlx::query(
        "DELETE FROM notify_rules WHERE user_id = ? AND target_user_id = ? AND room_id IS ?",
    )
    .bind(auth.id.to_vec())
    .bind(rule.target_user_id.to_vec())
    .bind(rule.room_id.map(|r| r.to_vec()))
    .execute(&state.db.write)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

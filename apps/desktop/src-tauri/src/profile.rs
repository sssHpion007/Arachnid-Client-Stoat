//! Профили, статус и отношения с пользователями.
//!
//! Всё, что открывается по клику на имя или аватар (карточка и полный
//! профиль, как `UserCard` и `UserProfile` браузерного клиента), а также
//! меню собственного аватара: присутствие и текст статуса (`UserMenu`).

use std::collections::HashMap;
use std::sync::Arc;

use revolt_models::v0;
use serde::Serialize;
use serde_json::json;
use tauri::State;

use crate::views::{self, Segments, UserView};
use crate::{AppState, CmdResult, CommandError, http_client};

/// Сколько символов допускает текст статуса (как в `CustomStatus.tsx`).
const STATUS_TEXT_LIMIT: usize = 128;

/// Роль участника в карточке профиля.
#[derive(Debug, Serialize)]
pub struct RoleChip {
    /// Id роли
    pub id: String,
    /// Название
    pub name: String,
    /// Цвет (CSS)
    pub colour: Option<String>,
}

/// Сведения об участнике сервера, открытом в профиле.
#[derive(Debug, Serialize)]
pub struct MemberInfo {
    /// Id сервера
    pub server_id: String,
    /// Название сервера
    pub server_name: String,
    /// Ник на сервере
    pub nickname: Option<String>,
    /// Местоимения на сервере
    pub pronouns: Option<String>,
    /// Когда вступил (ISO-8601)
    pub joined_at: Option<String>,
    /// Роли сверху вниз
    pub roles: Vec<RoleChip>,
    /// Владелец ли сервера
    pub owner: bool,
}

/// Профиль пользователя для карточки и полного окна.
#[derive(Debug, Serialize)]
pub struct ProfileView {
    /// Id пользователя
    pub id: String,
    /// Имя пользователя
    pub username: String,
    /// Дискриминатор (`0001`)
    pub discriminator: String,
    /// Отображаемое имя профиля
    pub display_name: Option<String>,
    /// Имя для показа: ник на сервере, иначе отображаемое, иначе имя пользователя
    pub name: String,
    /// Аватар: свой у участника или из профиля
    pub avatar: Option<String>,
    /// Присутствие: `Online`, `Idle`, `Focus`, `Busy`, `Offline` (для себя — выбранное)
    pub presence: String,
    /// Текст статуса
    pub status: Option<String>,
    /// Местоимения: серверные важнее профильных
    pub pronouns: Option<String>,
    /// Значки (битовая маска API)
    pub badges: u32,
    /// Отношение: `None`, `User`, `Friend`, `Outgoing`, `Incoming`, `Blocked`, `BlockedOther`
    pub relationship: String,
    /// Это бот
    pub bot: bool,
    /// Владелец бота
    pub bot_owner: Option<UserView>,
    /// Когда создан аккаунт (ISO-8601, из ULID)
    pub created_at: Option<String>,
    /// Это я
    pub is_me: bool,
    /// «Обо мне»
    pub bio: Option<String>,
    /// «Обо мне» с разметкой
    pub bio_segments: Segments,
    /// Свои эмодзи из «обо мне»: id → адрес
    pub bio_emoji: HashMap<String, String>,
    /// Фон профиля
    pub background: Option<String>,
    /// Сведения об участнике, если профиль открыт на сервере
    pub member: Option<MemberInfo>,
}

/// Общие с пользователем серверы и друзья.
#[derive(Debug, Serialize)]
pub struct MutualView {
    /// Общие серверы
    pub servers: Vec<MutualServer>,
    /// Общие друзья
    pub friends: Vec<UserView>,
}

/// Общий сервер.
#[derive(Debug, Serialize)]
pub struct MutualServer {
    /// Id
    pub id: String,
    /// Название
    pub name: String,
    /// Значок
    pub icon: Option<String>,
}

/// Присутствие, которое пользователь выбрал сам (`Invisible` тоже).
///
/// Остальные видят невидимого как «не в сети», но в своём меню и на своём
/// аватаре браузерный клиент показывает именно выбранное.
pub fn chosen_presence(user: &v0::User) -> &'static str {
    match user
        .status
        .as_ref()
        .and_then(|status| status.presence.as_ref())
    {
        Some(v0::Presence::Idle) => "Idle",
        Some(v0::Presence::Focus) => "Focus",
        Some(v0::Presence::Busy) => "Busy",
        Some(v0::Presence::Invisible) => "Invisible",
        Some(v0::Presence::Online) | None => "Online",
    }
}

/// Своё представление: с выбранным присутствием вместо видимого другим.
pub fn own_view(user: v0::User, cdn: Option<&str>) -> UserView {
    let presence = chosen_presence(&user).to_string();
    UserView {
        presence,
        ..UserView::build(user, cdn)
    }
}

/// Имя варианта перечисления так, как его пишет API (`Friend`, `Blocked`).
fn variant_name<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// Время из API как строка ISO-8601.
fn timestamp_text<T: Serialize>(value: &T) -> Option<String> {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
}

/// Пользователь из кэша, иначе из API (и тогда он попадает в кэш).
async fn user_by_id(state: &AppState, user_id: &str) -> CmdResult<v0::User> {
    if let Some(user) = state.cache.user(user_id).await {
        return Ok(user);
    }
    let user = http_client(state).await?.fetch_user(user_id).await?;
    state.cache.insert_user(user.clone()).await;
    Ok(user)
}

/// Карточка участника сервера: ник, роли, дата вступления.
async fn member_info(
    state: &AppState,
    server_id: &str,
    user_id: &str,
) -> CmdResult<Option<(MemberInfo, Option<v0::File>)>> {
    let Some(server) = state.cache.server(server_id).await else {
        return Ok(None);
    };
    let member = match state.cache.member(server_id, user_id).await {
        Some(member) => member,
        // участник мог выйти — тогда профиль показывается без серверной части
        None => match http_client(state)
            .await?
            .fetch_member(server_id, user_id)
            .await
        {
            Ok(member) => member,
            Err(_) => return Ok(None),
        },
    };

    let mut roles: Vec<&v0::Role> = member
        .roles
        .iter()
        .filter_map(|id| server.roles.get(id))
        .collect();
    // у старшей роли меньший `rank`
    roles.sort_by_key(|role| role.rank);

    let info = MemberInfo {
        server_id: server.id.clone(),
        server_name: server.name.clone(),
        nickname: member
            .nickname
            .clone()
            .filter(|name| !name.trim().is_empty()),
        pronouns: member
            .pronouns
            .clone()
            .filter(|text| !text.trim().is_empty()),
        joined_at: timestamp_text(&member.joined_at),
        roles: roles
            .into_iter()
            .map(|role| RoleChip {
                id: role.id.clone(),
                name: role.name.clone(),
                colour: role.colour.clone(),
            })
            .collect(),
        owner: server.owner == user_id,
    };
    Ok(Some((info, member.avatar)))
}

/// Профиль пользователя; с `server_id` — вместе с ником и ролями на сервере.
#[tauri::command]
pub async fn user_profile(
    user_id: String,
    server_id: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<ProfileView> {
    let user = user_by_id(&state, &user_id).await?;
    let cdn = state.cdn_url.read().await.clone();
    let cdn = cdn.as_deref();
    let me = state.cache.me_id().await;
    let is_me = me.as_deref() == Some(user.id.as_str());

    let member = match server_id.as_deref() {
        Some(server) => member_info(&state, server, &user.id).await?,
        None => None,
    };

    // «обо мне» скрыт от заблокированных — это не ошибка профиля
    let http = http_client(&state).await?;
    let profile = http.fetch_profile(&user.id).await.ok();

    let bot_owner = match user.bot.as_ref() {
        Some(bot) => user_by_id(&state, &bot.owner_id)
            .await
            .ok()
            .map(|owner| UserView::build(owner, cdn)),
        None => None,
    };

    let bio = profile
        .as_ref()
        .and_then(|profile| profile.content.clone())
        .filter(|text| !text.trim().is_empty());
    let background = profile
        .as_ref()
        .and_then(|profile| profile.background.as_ref())
        .and_then(|file| views::file_url(file, cdn));

    let (member, member_avatar) = match member {
        Some((info, avatar)) => (Some(info), avatar),
        None => (None, None),
    };
    let avatar = member_avatar
        .as_ref()
        .and_then(|file| views::file_url(file, cdn))
        .or_else(|| {
            user.avatar
                .as_ref()
                .and_then(|file| views::file_url(file, cdn))
        });
    let name = member
        .as_ref()
        .and_then(|member| member.nickname.clone())
        .unwrap_or_else(|| views::display_name(&user));
    let pronouns = member
        .as_ref()
        .and_then(|member| member.pronouns.clone())
        .or_else(|| user.pronouns.clone().filter(|text| !text.trim().is_empty()));

    Ok(ProfileView {
        presence: if is_me {
            chosen_presence(&user)
        } else {
            views::presence_of(&user)
        }
        .to_string(),
        status: views::status_text(&user),
        relationship: variant_name(&user.relationship),
        created_at: views::ulid_time_ms(&user.id).map(views::iso_from_ms),
        bio_segments: bio.as_deref().map(views::segments).unwrap_or_default(),
        bio_emoji: bio
            .as_deref()
            .map(|text| views::custom_emojis(text, cdn))
            .unwrap_or_default(),
        bio,
        background,
        bot: user.bot.is_some(),
        bot_owner,
        badges: user.badges,
        id: user.id,
        username: user.username,
        discriminator: user.discriminator,
        display_name: user.display_name.filter(|name| !name.trim().is_empty()),
        name,
        avatar,
        pronouns,
        is_me,
        member,
    })
}

/// Общие серверы и друзья — для полного профиля.
#[tauri::command]
pub async fn user_mutual(
    user_id: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<MutualView> {
    let http = http_client(&state).await?;
    let mutual = http.fetch_mutual(&user_id).await?;
    let cdn = state.cdn_url.read().await.clone();
    let cdn = cdn.as_deref();

    let mut servers = Vec::new();
    for id in &mutual.servers {
        if let Some(server) = state.cache.server(id).await {
            servers.push(MutualServer {
                icon: server
                    .icon
                    .as_ref()
                    .and_then(|file| views::file_url(file, cdn)),
                id: server.id,
                name: server.name,
            });
        }
    }
    let mut friends = Vec::new();
    for id in &mutual.users {
        if let Ok(user) = user_by_id(&state, id).await {
            friends.push(UserView::build(user, cdn));
        }
    }
    Ok(MutualView { servers, friends })
}

/// Записать обновлённого себя в кэш и вернуть своё представление.
pub(crate) async fn store_me(state: &AppState, mut user: v0::User) -> UserView {
    // `PATCH /users/@me` отвечает «как видят другие», без отметки «в сети»;
    // себя мы видим подключённым, иначе аватар на миг становился серым
    user.online = true;
    state.cache.insert_user(user.clone()).await;
    let cdn = state.cdn_url.read().await.clone();
    own_view(user, cdn.as_deref())
}

/// Выбрать присутствие: `Online`, `Idle`, `Focus`, `Busy`, `Invisible`.
#[tauri::command]
pub async fn set_presence(
    presence: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<UserView> {
    let parsed: v0::Presence = serde_json::from_value(json!(presence))
        .map_err(|_| CommandError::new("invalid", format!("неизвестный статус: {presence}")))?;
    let http = http_client(&state).await?;
    let user = http
        .edit_self(&json!({ "status": { "presence": parsed } }))
        .await?;
    Ok(store_me(&state, user).await)
}

/// Текст статуса; пустой текст убирает статус (как «Очистить статус»).
#[tauri::command]
pub async fn set_status_text(
    text: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<UserView> {
    let text = text
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());
    let body = match &text {
        Some(text) if text.chars().count() > STATUS_TEXT_LIMIT => {
            return Err(CommandError::new(
                "invalid",
                format!("статус длиннее {STATUS_TEXT_LIMIT} символов"),
            ));
        }
        Some(text) => json!({ "status": { "text": text } }),
        None => json!({ "remove": ["StatusText"] }),
    };
    let http = http_client(&state).await?;
    let user = http.edit_self(&body).await?;
    Ok(store_me(&state, user).await)
}

/// Открыть личную переписку и вернуть id канала.
#[tauri::command]
pub async fn open_dm(user_id: String, state: State<'_, Arc<AppState>>) -> CmdResult<String> {
    let http = http_client(&state).await?;
    let channel = http.open_dm(&user_id).await?;
    let id = stoat_core::cache::channel_id(&channel).to_string();
    state.cache.insert_channel(channel).await;
    Ok(id)
}

/// Изменить отношение: `add` (запрос или принятие), `remove`, `block`, `unblock`.
///
/// Возвращает новое отношение (`Friend`, `Outgoing`, `None`, `Blocked`, …).
#[tauri::command]
pub async fn set_relationship(
    user_id: String,
    action: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<String> {
    let http = http_client(&state).await?;
    let user = match action.as_str() {
        "add" => http.add_friend(&user_id).await?,
        "remove" => http.remove_friend(&user_id).await?,
        "block" => http.block_user(&user_id).await?,
        "unblock" => http.unblock_user(&user_id).await?,
        other => {
            return Err(CommandError::new(
                "invalid",
                format!("неизвестное действие: {other}"),
            ));
        }
    };
    let relationship = variant_name(&user.relationship);
    state.cache.insert_user(user).await;
    Ok(relationship)
}

/// Отправить запрос дружбы по имени `имя#0000`.
#[tauri::command]
pub async fn send_friend_request(
    username: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<String> {
    let username = username.trim();
    if username.is_empty() {
        return Err(CommandError::new("invalid", "укажите имя пользователя"));
    }
    let http = http_client(&state).await?;
    let user = http.send_friend_request(username).await?;
    let relationship = variant_name(&user.relationship);
    state.cache.insert_user(user).await;
    Ok(relationship)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(json: &str) -> v0::User {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn invisible_is_shown_to_self() {
        let me = user(
            r#"{"_id":"u1","username":"me","discriminator":"0001","relationship":"User",
                "online":false,"status":{"presence":"Invisible","text":"тут"}}"#,
        );
        assert_eq!(chosen_presence(&me), "Invisible");
        assert_eq!(
            views::presence_of(&me),
            "Offline",
            "другие видят «не в сети»"
        );
        let view = own_view(me, None);
        assert_eq!(view.presence, "Invisible");
        assert_eq!(view.status.as_deref(), Some("тут"));
    }

    #[test]
    fn missing_presence_means_online() {
        let me = user(
            r#"{"_id":"u1","username":"me","discriminator":"0001","relationship":"User","online":true}"#,
        );
        assert_eq!(chosen_presence(&me), "Online");
    }

    #[test]
    fn enum_names_match_api() {
        assert_eq!(variant_name(&v0::RelationshipStatus::Friend), "Friend");
        assert_eq!(variant_name(&v0::RelationshipStatus::Incoming), "Incoming");
        let presence: v0::Presence = serde_json::from_value(json!("Busy")).unwrap();
        assert_eq!(variant_name(&presence), "Busy");
        assert!(serde_json::from_value::<v0::Presence>(json!("Sleeping")).is_err());
    }
}

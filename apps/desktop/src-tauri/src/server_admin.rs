//! Управление сервером: обзор, роли, участники, баны, приглашения, эмодзи
//! и каналы — разделы «Настройки сервера» браузерного клиента
//! (`settings/server/*`), а также создание сервера и вход по приглашению.

use std::sync::Arc;

use revolt_models::v0;
use serde::Serialize;
use serde_json::{Map, Value, json};
use tauri::State;

use crate::views::{self, UserView};
use crate::{AppState, CmdResult, CommandError, http_client, permissions};

/// Роль в настройках сервера.
#[derive(Debug, Serialize)]
pub struct RoleView {
    /// Id
    pub id: String,
    /// Название
    pub name: String,
    /// Цвет (CSS)
    pub colour: Option<String>,
    /// Показывать участников отдельной группой
    pub hoist: bool,
    /// Позиция: чем меньше, тем старше
    pub rank: i64,
    /// Разрешённые права
    pub allow: u64,
    /// Запрещённые права
    pub deny: u64,
}

/// Канал сервера (для приглашений и системных сообщений).
#[derive(Debug, Serialize)]
pub struct ChannelRef {
    /// Id
    pub id: String,
    /// Название
    pub name: String,
}

/// Всё, что нужно разделам настроек сервера.
#[derive(Debug, Serialize)]
pub struct ServerSettingsView {
    /// Id
    pub id: String,
    /// Название
    pub name: String,
    /// Описание
    pub description: Option<String>,
    /// Значок
    pub icon: Option<String>,
    /// Баннер
    pub banner: Option<String>,
    /// Я владелец
    pub is_owner: bool,
    /// Мои права на сервере
    pub permissions: u64,
    /// Ранг моей старшей роли (менять можно только роли ниже)
    pub top_rank: i64,
    /// Права роли «все»
    pub default_permissions: u64,
    /// Роли от старшей к младшей
    pub roles: Vec<RoleView>,
    /// Текстовые каналы
    pub channels: Vec<ChannelRef>,
    /// Куда писать системные сообщения: вход, выход, исключение, бан
    pub system_messages: SystemChannels,
    /// Сколько участников (примерно)
    pub member_count: usize,
}

/// Каналы системных сообщений.
#[derive(Debug, Default, Serialize)]
pub struct SystemChannels {
    /// Вступил
    pub user_joined: Option<String>,
    /// Вышел
    pub user_left: Option<String>,
    /// Исключён
    pub user_kicked: Option<String>,
    /// Забанен
    pub user_banned: Option<String>,
}

/// Забаненный пользователь.
#[derive(Debug, Serialize)]
pub struct BanView {
    /// Id пользователя
    pub id: String,
    /// Имя пользователя
    pub username: String,
    /// Дискриминатор
    pub discriminator: String,
    /// Аватар
    pub avatar: Option<String>,
    /// Причина
    pub reason: Option<String>,
}

/// Приглашение на сервер.
#[derive(Debug, Serialize)]
pub struct InviteView {
    /// Код
    pub code: String,
    /// Канал
    pub channel: String,
    /// Кто создал
    pub creator: Option<UserView>,
}

/// Участник в разделе «Участники».
#[derive(Debug, Serialize)]
pub struct MemberAdminView {
    /// Id пользователя
    pub id: String,
    /// Имя для показа
    pub name: String,
    /// `имя#0000`
    pub username: String,
    /// Аватар
    pub avatar: Option<String>,
    /// Ник на сервере
    pub nickname: Option<String>,
    /// Id ролей
    pub roles: Vec<String>,
    /// Когда вступил
    pub joined_at: Option<String>,
}

/// Собрать представление настроек из сервера в кэше.
async fn settings_view(state: &AppState, server: v0::Server) -> ServerSettingsView {
    let cdn = state.cdn_url.read().await.clone();
    let cdn = cdn.as_deref();
    let me = state.cache.me_id().await.unwrap_or_default();
    let member = state.cache.member(&server.id, &me).await;

    let mut roles: Vec<RoleView> = server
        .roles
        .values()
        .map(|role| RoleView {
            id: role.id.clone(),
            name: role.name.clone(),
            colour: role.colour.clone(),
            hoist: role.hoist,
            rank: role.rank,
            allow: role.permissions.a as u64,
            deny: role.permissions.d as u64,
        })
        .collect();
    roles.sort_by_key(|role| role.rank);

    let mut channels = Vec::new();
    for id in &server.channels {
        if let Some(v0::Channel::TextChannel { id, name, .. }) = state.cache.channel(id).await {
            channels.push(ChannelRef { id, name });
        }
    }

    let system = server
        .system_messages
        .clone()
        .map(|system| SystemChannels {
            user_joined: system.user_joined,
            user_left: system.user_left,
            user_kicked: system.user_kicked,
            user_banned: system.user_banned,
        })
        .unwrap_or_default();
    ServerSettingsView {
        is_owner: server.owner == me,
        permissions: permissions::server(&server, Some(&me), member.as_ref()),
        top_rank: permissions::top_rank(&server, &me, member.as_ref()),
        icon: server
            .icon
            .as_ref()
            .and_then(|file| views::file_url(file, cdn)),
        banner: server
            .banner
            .as_ref()
            .and_then(|file| views::file_url(file, cdn)),
        default_permissions: server.default_permissions as u64,
        member_count: server.approximate_member_count,
        system_messages: system,
        roles,
        channels,
        id: server.id,
        name: server.name,
        description: server.description.filter(|text| !text.trim().is_empty()),
    }
}

/// Перечитать сервер из API, записать в кэш и вернуть настройки.
///
/// После изменения ролей и прав ответ API — единственный надёжный источник:
/// события шлюза приходят позже и частями.
async fn refresh(state: &AppState, server_id: &str) -> CmdResult<ServerSettingsView> {
    let http = http_client(state).await?;
    let server = http.fetch_server(server_id).await?;
    state.cache.insert_server(server.clone()).await;
    Ok(settings_view(state, server).await)
}

/// Настройки сервера.
#[tauri::command]
pub async fn server_settings(
    server_id: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<ServerSettingsView> {
    match state.cache.server(&server_id).await {
        Some(server) => Ok(settings_view(&state, server).await),
        None => refresh(&state, &server_id).await,
    }
}

/// Поля сервера, которые можно очистить (`FieldsServer`).
const SERVER_REMOVABLE: [&str; 4] = ["Description", "SystemMessages", "Icon", "Banner"];

/// Изменить обзор сервера: название, описание, значок, баннер, системные каналы.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn edit_server(
    server_id: String,
    name: Option<String>,
    description: Option<String>,
    icon: Option<String>,
    banner: Option<String>,
    system_messages: Option<Value>,
    remove: Option<Vec<String>>,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<ServerSettingsView> {
    let mut body = Map::new();
    let mut remove = remove.unwrap_or_default();
    if let Some(field) = remove
        .iter()
        .find(|field| !SERVER_REMOVABLE.contains(&field.as_str()))
    {
        return Err(CommandError::new(
            "invalid",
            format!("это поле нельзя очистить: {field}"),
        ));
    }
    if let Some(name) = name {
        let name = name.trim();
        if name.is_empty() {
            return Err(CommandError::new(
                "invalid",
                "у сервера должно быть название",
            ));
        }
        body.insert("name".into(), json!(name));
    }
    match description {
        Some(text) if text.trim().is_empty() => remove.push("Description".into()),
        Some(text) => {
            body.insert("description".into(), json!(text));
        }
        None => {}
    }
    if let Some(icon) = icon {
        body.insert("icon".into(), json!(icon));
    }
    if let Some(banner) = banner {
        body.insert("banner".into(), json!(banner));
    }
    if let Some(system) = system_messages {
        // пустые каналы не отправляем: сервер ждёт id или отсутствие поля
        let cleaned: Map<String, Value> = system
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(_, value)| value.as_str().is_some_and(|id| !id.is_empty()))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        body.insert("system_messages".into(), Value::Object(cleaned));
    }
    remove.sort();
    remove.dedup();
    if !remove.is_empty() {
        body.insert("remove".into(), json!(remove));
    }

    let http = http_client(&state).await?;
    let server = http.edit_server(&server_id, &Value::Object(body)).await?;
    state.cache.insert_server(server.clone()).await;
    Ok(settings_view(&state, server).await)
}

/// Выйти с сервера (владелец так удаляет сервер).
#[tauri::command]
pub async fn leave_server(
    server_id: String,
    silently: Option<bool>,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<()> {
    let http = http_client(&state).await?;
    http.leave_server(&server_id, silently.unwrap_or(false))
        .await?;
    Ok(())
}

// ─────────────────────────────── роли ────────────────────────────────

/// Новая роль.
#[tauri::command]
pub async fn create_role(
    server_id: String,
    name: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<ServerSettingsView> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CommandError::new("invalid", "укажите название роли"));
    }
    let http = http_client(&state).await?;
    http.create_role(&server_id, name).await?;
    refresh(&state, &server_id).await
}

/// Изменить роль: название, цвет (пустой — убрать), отдельная группа.
#[tauri::command]
pub async fn edit_role(
    server_id: String,
    role_id: String,
    name: Option<String>,
    colour: Option<String>,
    hoist: Option<bool>,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<ServerSettingsView> {
    let mut body = Map::new();
    if let Some(name) = name {
        let name = name.trim();
        if name.is_empty() {
            return Err(CommandError::new("invalid", "у роли должно быть название"));
        }
        body.insert("name".into(), json!(name));
    }
    match colour {
        Some(colour) if colour.trim().is_empty() => {
            body.insert("remove".into(), json!(["Colour"]));
        }
        Some(colour) => {
            body.insert("colour".into(), json!(colour.trim()));
        }
        None => {}
    }
    if let Some(hoist) = hoist {
        body.insert("hoist".into(), json!(hoist));
    }
    let http = http_client(&state).await?;
    http.edit_role(&server_id, &role_id, &Value::Object(body))
        .await?;
    refresh(&state, &server_id).await
}

/// Удалить роль.
#[tauri::command]
pub async fn delete_role(
    server_id: String,
    role_id: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<ServerSettingsView> {
    let http = http_client(&state).await?;
    http.delete_role(&server_id, &role_id).await?;
    refresh(&state, &server_id).await
}

/// Права роли; без `role_id` — права роли «все».
#[tauri::command]
pub async fn set_permissions(
    server_id: String,
    role_id: Option<String>,
    allow: u64,
    deny: Option<u64>,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<ServerSettingsView> {
    let http = http_client(&state).await?;
    let server = match role_id {
        Some(role) => {
            let deny = deny.unwrap_or(0);
            if allow & deny != 0 {
                return Err(CommandError::new(
                    "invalid",
                    "право не может быть и разрешено, и запрещено",
                ));
            }
            http.set_role_permissions(&server_id, &role, allow, deny)
                .await?
        }
        None => http.set_default_permissions(&server_id, allow).await?,
    };
    state.cache.insert_server(server.clone()).await;
    Ok(settings_view(&state, server).await)
}

// ───────────────────────────── участники ─────────────────────────────

/// Участники для раздела «Участники»: с ролями и ником.
#[tauri::command]
pub async fn server_member_list(
    server_id: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<Vec<MemberAdminView>> {
    let http = http_client(&state).await?;
    let all = http.fetch_members(&server_id, false).await?;
    let cdn = state.cdn_url.read().await.clone();
    let cdn = cdn.as_deref();
    let users: std::collections::HashMap<&str, &v0::User> = all
        .users
        .iter()
        .map(|user| (user.id.as_str(), user))
        .collect();

    let mut list: Vec<MemberAdminView> = all
        .members
        .iter()
        .filter_map(|member| {
            let user = users.get(member.id.user.as_str())?;
            Some(MemberAdminView {
                id: member.id.user.clone(),
                name: views::user_label_with(user, Some(member)),
                username: format!("{}#{}", user.username, user.discriminator),
                avatar: member
                    .avatar
                    .as_ref()
                    .or(user.avatar.as_ref())
                    .and_then(|file| views::file_url(file, cdn)),
                nickname: member.nickname.clone(),
                roles: member.roles.clone(),
                joined_at: serde_json::to_value(&member.joined_at)
                    .ok()
                    .and_then(|value| value.as_str().map(str::to_string)),
            })
        })
        .collect();
    list.sort_by_key(|member| member.name.to_lowercase());

    state
        .cache
        .insert_members(&server_id, all.members, all.users)
        .await;
    Ok(list)
}

/// Изменить участника: ник (пустой — убрать) и роли.
#[tauri::command]
pub async fn edit_member(
    server_id: String,
    user_id: String,
    nickname: Option<String>,
    roles: Option<Vec<String>>,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<()> {
    let mut body = Map::new();
    let mut remove = Vec::new();
    match nickname {
        Some(nickname) if nickname.trim().is_empty() => remove.push("Nickname"),
        Some(nickname) => {
            body.insert("nickname".into(), json!(nickname.trim()));
        }
        None => {}
    }
    match roles {
        Some(roles) if roles.is_empty() => remove.push("Roles"),
        Some(roles) => {
            body.insert("roles".into(), json!(roles));
        }
        None => {}
    }
    if !remove.is_empty() {
        body.insert("remove".into(), json!(remove));
    }
    let http = http_client(&state).await?;
    let member = http
        .edit_member(&server_id, &user_id, &Value::Object(body))
        .await?;
    state
        .cache
        .insert_members(&server_id, vec![member], Vec::new())
        .await;
    Ok(())
}

/// Исключить участника.
#[tauri::command]
pub async fn kick_member(
    server_id: String,
    user_id: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<()> {
    let http = http_client(&state).await?;
    http.kick_member(&server_id, &user_id).await?;
    Ok(())
}

/// Забанить участника.
#[tauri::command]
pub async fn ban_member(
    server_id: String,
    user_id: String,
    reason: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<()> {
    let reason = reason
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());
    let http = http_client(&state).await?;
    http.ban_member(&server_id, &user_id, reason.as_deref())
        .await?;
    Ok(())
}

/// Список банов.
#[tauri::command]
pub async fn server_bans(
    server_id: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<Vec<BanView>> {
    let http = http_client(&state).await?;
    let result = http.fetch_bans(&server_id).await?;
    let cdn = state.cdn_url.read().await.clone();
    let cdn = cdn.as_deref();
    Ok(result
        .users
        .into_iter()
        .map(|user| BanView {
            reason: result
                .bans
                .iter()
                .find(|ban| ban.id.user == user.id)
                .and_then(|ban| ban.reason.clone()),
            avatar: user
                .avatar
                .as_ref()
                .and_then(|file| views::file_url(file, cdn)),
            id: user.id,
            username: user.username,
            discriminator: user.discriminator,
        })
        .collect())
}

/// Снять бан.
#[tauri::command]
pub async fn unban_member(
    server_id: String,
    user_id: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<()> {
    let http = http_client(&state).await?;
    http.unban_member(&server_id, &user_id).await?;
    Ok(())
}

// ──────────────────────────── приглашения ────────────────────────────

/// Приглашения сервера.
#[tauri::command]
pub async fn server_invites(
    server_id: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<Vec<InviteView>> {
    let http = http_client(&state).await?;
    let invites = http.fetch_invites(&server_id).await?;
    let cdn = state.cdn_url.read().await.clone();
    let cdn = cdn.as_deref();
    let mut list = Vec::new();
    for invite in invites {
        let (code, channel, creator) = match invite {
            v0::Invite::Server {
                code,
                channel,
                creator,
                ..
            }
            | v0::Invite::Group {
                code,
                channel,
                creator,
                ..
            } => (code, channel, creator),
        };
        let channel = match state.cache.channel(&channel).await {
            Some(v0::Channel::TextChannel { name, .. }) => name,
            _ => channel,
        };
        let creator = match state.cache.user(&creator).await {
            Some(user) => Some(user),
            None => http.fetch_user(&creator).await.ok(),
        }
        .map(|user| UserView::build(user, cdn));
        list.push(InviteView {
            code,
            channel,
            creator,
        });
    }
    Ok(list)
}

/// Новое приглашение в канал; возвращает код.
#[tauri::command]
pub async fn create_invite(
    channel_id: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<String> {
    let http = http_client(&state).await?;
    let code = match http.create_invite(&channel_id).await? {
        v0::Invite::Server { code, .. } | v0::Invite::Group { code, .. } => code,
    };
    Ok(code)
}

/// Удалить приглашение.
#[tauri::command]
pub async fn delete_invite(code: String, state: State<'_, Arc<AppState>>) -> CmdResult<()> {
    let http = http_client(&state).await?;
    http.delete_invite(&code).await?;
    Ok(())
}

/// Код из ссылки вида `https://stoat.chat/invite/КОД` или сам код.
fn invite_code(input: &str) -> Option<String> {
    let trimmed = input.trim().trim_end_matches('/');
    let code = trimmed.rsplit('/').next().unwrap_or(trimmed);
    let valid = !code.is_empty() && code.chars().all(|c| c.is_ascii_alphanumeric());
    valid.then(|| code.to_string())
}

/// Что за приглашение: название сервера, канал, число участников.
#[tauri::command]
pub async fn preview_invite(code: String, state: State<'_, Arc<AppState>>) -> CmdResult<Value> {
    let code = invite_code(&code)
        .ok_or_else(|| CommandError::new("invalid", "это не похоже на приглашение"))?;
    let http = http_client(&state).await?;
    let mut preview = http.fetch_invite(&code).await?;
    let cdn = state.cdn_url.read().await.clone();
    // значок приходит файлом — отдаём адрес, как везде в интерфейсе
    if let Some(object) = preview.as_object_mut() {
        object.insert("code".into(), json!(code));
        let icon = object
            .get("server_icon")
            .and_then(|file| serde_json::from_value::<v0::File>(file.clone()).ok())
            .and_then(|file| views::file_url(&file, cdn.as_deref()));
        object.insert("icon".into(), json!(icon));
    }
    Ok(preview)
}

/// Вступить по приглашению; возвращает id сервера (или группы).
#[tauri::command]
pub async fn join_invite(code: String, state: State<'_, Arc<AppState>>) -> CmdResult<String> {
    let code = invite_code(&code)
        .ok_or_else(|| CommandError::new("invalid", "это не похоже на приглашение"))?;
    let http = http_client(&state).await?;
    let response = http.join_invite(&code).await?;
    store_joined(&state, response).await
}

/// Создать сервер; возвращает его id.
#[tauri::command]
pub async fn create_server(name: String, state: State<'_, Arc<AppState>>) -> CmdResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CommandError::new("invalid", "укажите название сервера"));
    }
    let http = http_client(&state).await?;
    let response = http.create_server(name).await?;
    store_joined(&state, response).await
}

/// Сразу положить новый сервер и его каналы в кэш, чтобы он появился в рельсе.
async fn store_joined(state: &AppState, response: Value) -> CmdResult<String> {
    if let Some(server) = response
        .get("server")
        .and_then(|value| serde_json::from_value::<v0::Server>(value.clone()).ok())
    {
        let id = server.id.clone();
        state.cache.insert_server(server).await;
        let channels: Vec<v0::Channel> = response
            .get("channels")
            .and_then(|value| serde_json::from_value(value.clone()).ok())
            .unwrap_or_default();
        for channel in channels {
            state.cache.insert_channel(channel).await;
        }
        return Ok(id);
    }
    if let Some(channel) = response
        .get("channel")
        .and_then(|value| serde_json::from_value::<v0::Channel>(value.clone()).ok())
    {
        let id = stoat_core::cache::channel_id(&channel).to_string();
        state.cache.insert_channel(channel).await;
        return Ok(id);
    }
    Err(CommandError::new("internal", "сервер ответил непонятно"))
}

// ─────────────────────────────── каналы ───────────────────────────────

/// Новый канал: `Text` или `Voice`.
#[tauri::command]
pub async fn create_channel(
    server_id: String,
    name: String,
    kind: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CommandError::new("invalid", "укажите название канала"));
    }
    let kind = match kind.as_deref() {
        None | Some("Text") => "Text",
        Some("Voice") => "Voice",
        Some(other) => {
            return Err(CommandError::new(
                "invalid",
                format!("неизвестный тип канала: {other}"),
            ));
        }
    };
    let http = http_client(&state).await?;
    let channel = http
        .create_channel(&server_id, &json!({ "type": kind, "name": name }))
        .await?;
    let id = stoat_core::cache::channel_id(&channel).to_string();
    state.cache.insert_channel(channel).await;
    // сервер тоже поменялся: в нём новый канал
    if let Ok(server) = http.fetch_server(&server_id).await {
        state.cache.insert_server(server).await;
    }
    Ok(id)
}

/// Изменить канал: название и описание (пустое — убрать).
#[tauri::command]
pub async fn edit_channel(
    channel_id: String,
    name: Option<String>,
    description: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<()> {
    let mut body = Map::new();
    if let Some(name) = name {
        let name = name.trim();
        if name.is_empty() {
            return Err(CommandError::new(
                "invalid",
                "у канала должно быть название",
            ));
        }
        body.insert("name".into(), json!(name));
    }
    match description {
        Some(text) if text.trim().is_empty() => {
            body.insert("remove".into(), json!(["Description"]));
        }
        Some(text) => {
            body.insert("description".into(), json!(text));
        }
        None => {}
    }
    let http = http_client(&state).await?;
    let channel = http.edit_channel(&channel_id, &Value::Object(body)).await?;
    state.cache.insert_channel(channel).await;
    Ok(())
}

/// Удалить канал (или закрыть личную переписку).
#[tauri::command]
pub async fn delete_channel(channel_id: String, state: State<'_, Arc<AppState>>) -> CmdResult<()> {
    let http = http_client(&state).await?;
    http.delete_channel(&channel_id).await?;
    Ok(())
}

// ─────────────────────────────── эмодзи ───────────────────────────────

/// Свой эмодзи из загруженного файла.
#[tauri::command]
pub async fn create_emoji(
    server_id: String,
    name: String,
    file_id: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<()> {
    let name = name.trim().to_lowercase();
    let valid = (1..=32).contains(&name.chars().count())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    if !valid {
        return Err(CommandError::new(
            "invalid",
            "имя эмодзи: латиница, цифры и «_», до 32 символов",
        ));
    }
    let http = http_client(&state).await?;
    http.create_emoji(&file_id, &name, &server_id).await?;
    state.emojis.write().await.remove(&server_id);
    Ok(())
}

/// Удалить эмодзи.
#[tauri::command]
pub async fn delete_emoji(
    server_id: String,
    emoji_id: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<()> {
    let http = http_client(&state).await?;
    http.delete_emoji(&emoji_id).await?;
    state.emojis.write().await.remove(&server_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invite_codes_are_extracted() {
        assert_eq!(invite_code("Testers").as_deref(), Some("Testers"));
        assert_eq!(
            invite_code("https://stoat.chat/invite/Testers/").as_deref(),
            Some("Testers")
        );
        assert_eq!(invite_code(" rvlt.gg/abc123 ").as_deref(), Some("abc123"));
        assert_eq!(invite_code("не код"), None);
        assert_eq!(invite_code(""), None);
    }
}

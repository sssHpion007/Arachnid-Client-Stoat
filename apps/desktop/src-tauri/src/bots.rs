//! «Мои боты»: создание, настройки, приглашение и «Обзор».
//!
//! Повторяет `MyBots.tsx`, `ViewBot.tsx` и окна `create_bot`,
//! `reset_bot_token`, `edit_bot_username`, `delete_bot`, `add_bot`
//! браузерного клиента. Сетевая часть — в `stoat_core::http` (bots.rs).

use std::sync::Arc;

use revolt_models::v0;
use serde::Serialize;
use serde_json::{Map, Value, json};
use stoat_core::http::{BotInfo, BotWithUser, DiscoverStatus};
use tauri::State;

use crate::security::{MfaAnswer, ticket};
use crate::views::{self, UserView};
use crate::{AppState, CmdResult, CommandError, http_client};

/// Бот для списка и страницы бота.
#[derive(Debug, Serialize)]
pub struct BotView {
    /// Id бота (он же id его пользователя)
    pub id: String,
    /// Токен для подключения
    pub token: String,
    /// Другие могут приглашать бота
    pub public: bool,
    /// Бот уже в «Обзоре»
    pub discoverable: bool,
    /// Флаги: 1 — проверен, 2 — официальный
    pub flags: u32,
    /// Пользователь бота с адресом аватара
    pub user: UserView,
    /// Значки пользователя (битовая маска API)
    pub badges: u32,
}

impl BotView {
    fn build(bot: BotInfo, user: v0::User, cdn: Option<&str>) -> Self {
        let badges = user.badges;
        Self {
            id: bot.id,
            token: bot.token,
            public: bot.public,
            discoverable: bot.discoverable,
            flags: bot.flags,
            badges,
            user: UserView::build(user, cdn),
        }
    }

    fn from_pair(pair: BotWithUser, cdn: Option<&str>) -> Self {
        Self::build(pair.bot, pair.user, cdn)
    }
}

/// Публичная карточка бота для окна «Пригласить бота».
#[derive(Debug, Serialize)]
pub struct PublicBotView {
    /// Id бота
    pub id: String,
    /// Имя пользователя
    pub username: String,
    /// Аватар
    pub avatar: Option<String>,
    /// Описание из профиля
    pub description: String,
    /// Описание с разметкой
    pub description_segments: views::Segments,
    /// Когда зарегистрирован (ISO-8601, из ULID)
    pub created_at: Option<String>,
}

/// Состояние заявки в «Обзор» (`Discoverable.tsx`).
#[derive(Debug, Serialize)]
#[serde(tag = "status", content = "reason")]
pub enum DiscoverView {
    /// Заявки нет — можно подать
    None,
    /// Ждёт рассмотрения
    Pending,
    /// Рассматривается
    UnderReview,
    /// Отклонена
    Denied(Option<String>),
    /// Убрана из «Обзора»
    Removed(Option<String>),
    /// Одобрена
    Approved(Option<String>),
}

impl From<Option<DiscoverStatus>> for DiscoverView {
    fn from(status: Option<DiscoverStatus>) -> Self {
        match status {
            None => Self::None,
            Some(DiscoverStatus::Pending) => Self::Pending,
            Some(DiscoverStatus::UnderReview) => Self::UnderReview,
            Some(DiscoverStatus::Denied(reason)) => Self::Denied(reason),
            Some(DiscoverStatus::Removed(reason)) => Self::Removed(reason),
            Some(DiscoverStatus::Approved(reason)) => Self::Approved(reason),
        }
    }
}

async fn cdn(state: &AppState) -> Option<String> {
    state.cdn_url.read().await.clone()
}

/// Боты пользователя.
#[tauri::command]
pub async fn owned_bots(state: State<'_, Arc<AppState>>) -> CmdResult<Vec<BotView>> {
    let http = http_client(&state).await?;
    let owned = http.fetch_owned_bots().await?;
    let cdn = cdn(&state).await;
    let mut users = owned.users;
    let mut list: Vec<BotView> = owned
        .bots
        .into_iter()
        .filter_map(|bot| {
            let index = users.iter().position(|user| user.id == bot.id)?;
            let user = users.swap_remove(index);
            Some(BotView::build(bot, user, cdn.as_deref()))
        })
        .collect();
    list.sort_by_key(|bot| bot.user.label().to_lowercase());
    Ok(list)
}

/// Один бот со своим пользователем.
#[tauri::command]
pub async fn bot_info(bot_id: String, state: State<'_, Arc<AppState>>) -> CmdResult<BotView> {
    let http = http_client(&state).await?;
    let pair = http.fetch_bot(&bot_id).await?;
    Ok(BotView::from_pair(pair, cdn(&state).await.as_deref()))
}

/// Новый бот (окно «Создать нового бота»).
#[tauri::command]
pub async fn create_bot(name: String, state: State<'_, Arc<AppState>>) -> CmdResult<BotView> {
    let name = name.trim();
    if name.chars().count() < 2 || name.chars().count() > 32 {
        return Err(CommandError::new(
            "invalid",
            "имя бота — от 2 до 32 символов",
        ));
    }
    let http = http_client(&state).await?;
    let pair = http.create_bot(name).await?;
    Ok(BotView::from_pair(pair, cdn(&state).await.as_deref()))
}

/// Изменить бота: имя пользователя, публичность или сбросить токен.
#[tauri::command]
pub async fn edit_bot(
    bot_id: String,
    name: Option<String>,
    public: Option<bool>,
    reset_token: Option<bool>,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<BotView> {
    let mut body = Map::new();
    if let Some(name) = name {
        let name = name.trim();
        if name.is_empty() {
            return Err(CommandError::new("invalid", "укажите имя пользователя"));
        }
        body.insert("name".into(), json!(name));
    }
    if let Some(public) = public {
        body.insert("public".into(), json!(public));
    }
    if reset_token == Some(true) {
        body.insert("remove".into(), json!(["Token"]));
    }
    let http = http_client(&state).await?;
    if !body.is_empty() {
        http.edit_bot(&bot_id, &Value::Object(body)).await?;
    }
    // ответ PATCH без пользователя бота — берём бота целиком
    let pair = http.fetch_bot(&bot_id).await?;
    Ok(BotView::from_pair(pair, cdn(&state).await.as_deref()))
}

/// Удалить бота.
///
/// Браузерный клиент перед удалением проводит подтверждение личности
/// (`mfaFlow`), хотя API тикет не требует; повторяем это: без верного
/// пароля или кода бот не удаляется.
#[tauri::command]
pub async fn delete_bot(
    bot_id: String,
    mfa: MfaAnswer,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<()> {
    let http = http_client(&state).await?;
    ticket(&http, mfa).await?;
    http.delete_bot(&bot_id).await?;
    Ok(())
}

/// Публичная карточка бота для приглашения.
#[tauri::command]
pub async fn public_bot(
    bot_id: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<PublicBotView> {
    let http = http_client(&state).await?;
    let bot = http.fetch_public_bot(&bot_id).await?;
    let cdn = cdn(&state).await;
    // у карточки только id файла аватара
    let avatar = match (bot.avatar.is_empty(), cdn.as_deref()) {
        (false, Some(base)) => Some(format!(
            "{}/avatars/{}",
            base.trim_end_matches('/'),
            bot.avatar
        )),
        _ => None,
    };
    let description = bot.description.trim().to_string();
    Ok(PublicBotView {
        created_at: views::ulid_time_ms(&bot.id).map(views::iso_from_ms),
        description_segments: views::segments(&description),
        description,
        avatar,
        username: bot.username,
        id: bot.id,
    })
}

/// Добавить бота на сервер или в группу.
#[tauri::command]
pub async fn invite_bot(
    bot_id: String,
    server_id: Option<String>,
    group_id: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<()> {
    let http = http_client(&state).await?;
    match (server_id, group_id) {
        (Some(server), _) => http.invite_bot_to_server(&bot_id, &server).await?,
        (None, Some(group)) => http.invite_bot_to_group(&bot_id, &group).await?,
        (None, None) => {
            return Err(CommandError::new("invalid", "выберите сервер или группу"));
        }
    }
    Ok(())
}

/// Состояние заявки бота в «Обзор».
#[tauri::command]
pub async fn bot_discover_status(
    bot_id: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<DiscoverView> {
    let http = http_client(&state).await?;
    Ok(http.bot_discover_status(&bot_id).await?.into())
}

/// Подать заявку в «Обзор».
#[tauri::command]
pub async fn request_bot_discover(
    bot_id: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<DiscoverView> {
    let http = http_client(&state).await?;
    http.request_bot_discover(&bot_id).await?;
    Ok(http.bot_discover_status(&bot_id).await?.into())
}

/// Отозвать заявку в «Обзор».
#[tauri::command]
pub async fn cancel_bot_discover(
    bot_id: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<DiscoverView> {
    let http = http_client(&state).await?;
    http.cancel_bot_discover(&bot_id).await?;
    Ok(http.bot_discover_status(&bot_id).await?.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discover_view_is_tagged_for_ui() {
        let pending =
            serde_json::to_value(DiscoverView::from(Some(DiscoverStatus::Pending))).unwrap();
        assert_eq!(pending, json!({ "status": "Pending" }));

        let denied = serde_json::to_value(DiscoverView::from(Some(DiscoverStatus::Denied(Some(
            "spam".into(),
        )))))
        .unwrap();
        assert_eq!(denied, json!({ "status": "Denied", "reason": "spam" }));

        let none = serde_json::to_value(DiscoverView::from(None)).unwrap();
        assert_eq!(none, json!({ "status": "None" }));
    }
}

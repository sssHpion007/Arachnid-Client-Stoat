//! Боты пользователя: создание, настройки, приглашение и «Обзор».
//!
//! Повторяет `BotCollection`, `Bot` и `PublicBot` из stoat.js. Модели
//! описаны здесь же, а не взяты из `revolt_models`: поля ботов менялись
//! между версиями сервера, и все необязательные поля читаются с
//! умолчаниями, чтобы ответ старого или нового сервера не ломал разбор.

use reqwest::Method;
use revolt_models::v0;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::HttpClient;
use super::endpoints::segment;
use crate::error::{Error, Result};

/// Бот (`Bot` в API).
#[derive(Debug, Clone, Deserialize)]
pub struct BotInfo {
    /// Id бота (совпадает с id его пользователя)
    #[serde(rename = "_id")]
    pub id: String,
    /// Владелец
    #[serde(rename = "owner")]
    pub owner_id: String,
    /// Токен для подключения бота
    pub token: String,
    /// Другие могут приглашать бота
    #[serde(default)]
    pub public: bool,
    /// Бот попал в «Обзор»
    #[serde(default)]
    pub discoverable: bool,
    /// Флаги: 1 — проверен, 2 — официальный
    #[serde(default)]
    pub flags: u32,
}

/// Бот вместе с пользователем (`BotWithUserResponse`, `FetchBotResponse`).
#[derive(Debug, Clone, Deserialize)]
pub struct BotWithUser {
    /// Бот
    pub bot: BotInfo,
    /// Его пользователь
    pub user: v0::User,
}

/// Ответ `POST /bots/create`: поля бота на верхнем уровне и пользователь.
#[derive(Debug, Deserialize)]
struct CreatedBot {
    #[serde(flatten)]
    bot: BotInfo,
    user: v0::User,
}

/// Ответ `GET /bots/@me`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct OwnedBots {
    /// Боты пользователя
    #[serde(default)]
    pub bots: Vec<BotInfo>,
    /// Их пользователи
    #[serde(default)]
    pub users: Vec<v0::User>,
}

/// Публичная карточка бота для приглашения (`PublicBot`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicBot {
    /// Id бота
    #[serde(rename = "_id")]
    pub id: String,
    /// Имя пользователя бота
    pub username: String,
    /// Id файла аватара
    #[serde(default)]
    pub avatar: String,
    /// Описание из профиля
    #[serde(default)]
    pub description: String,
}

/// Состояние заявки в «Обзор» (`DiscoverRequestStatus`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub enum DiscoverStatus {
    /// Ждёт рассмотрения
    Pending,
    /// Рассматривается
    UnderReview,
    /// Убран из «Обзора», с причиной
    Removed(Option<String>),
    /// Отклонён, с причиной
    Denied(Option<String>),
    /// Одобрен
    Approved(Option<String>),
}

/// Заявка в «Обзор» (`DiscoverRequest`).
#[derive(Debug, Clone, Deserialize)]
struct DiscoverRequest {
    status: DiscoverStatus,
}

impl HttpClient {
    /// `GET /bots/@me` — боты пользователя.
    pub async fn fetch_owned_bots(&self) -> Result<OwnedBots> {
        self.get_json("/bots/@me").await
    }

    /// `GET /bots/{id}` — свой бот с пользователем.
    pub async fn fetch_bot(&self, bot_id: &str) -> Result<BotWithUser> {
        self.get_json(&format!("/bots/{}", segment(bot_id))).await
    }

    /// `POST /bots/create` — новый бот.
    pub async fn create_bot(&self, name: &str) -> Result<BotWithUser> {
        let created: CreatedBot = self
            .send_json(Method::POST, "/bots/create", &json!({ "name": name }))
            .await?;
        Ok(BotWithUser {
            bot: created.bot,
            user: created.user,
        })
    }

    /// `PATCH /bots/{id}` — имя, публичность, сброс токена (`remove: ["Token"]`).
    pub async fn edit_bot(&self, bot_id: &str, data: &Value) -> Result<BotInfo> {
        self.send_json(Method::PATCH, &format!("/bots/{}", segment(bot_id)), data)
            .await
    }

    /// `DELETE /bots/{id}` — удалить бота.
    pub async fn delete_bot(&self, bot_id: &str) -> Result<()> {
        self.send_empty(Method::DELETE, &format!("/bots/{}", segment(bot_id)), None)
            .await
    }

    /// `GET /bots/{id}/invite` — публичная карточка бота.
    pub async fn fetch_public_bot(&self, bot_id: &str) -> Result<PublicBot> {
        self.get_json(&format!("/bots/{}/invite", segment(bot_id)))
            .await
    }

    /// `POST /bots/{id}/invite` — добавить бота на сервер.
    pub async fn invite_bot_to_server(&self, bot_id: &str, server_id: &str) -> Result<()> {
        let body = json!({ "server": server_id });
        self.send_empty(
            Method::POST,
            &format!("/bots/{}/invite", segment(bot_id)),
            Some(&body),
        )
        .await
    }

    /// `POST /bots/{id}/invite` — добавить бота в группу.
    pub async fn invite_bot_to_group(&self, bot_id: &str, group_id: &str) -> Result<()> {
        let body = json!({ "group": group_id });
        self.send_empty(
            Method::POST,
            &format!("/bots/{}/invite", segment(bot_id)),
            Some(&body),
        )
        .await
    }

    /// `PATCH /users/{id}` — профиль своего бота (имя, аватар, баннер, описание).
    pub async fn edit_user(&self, user_id: &str, data: &Value) -> Result<v0::User> {
        self.send_json(Method::PATCH, &format!("/users/{}", segment(user_id)), data)
            .await
    }

    /// `GET /bots/{id}/discover` — заявка в «Обзор»; `None`, если её нет.
    pub async fn bot_discover_status(&self, bot_id: &str) -> Result<Option<DiscoverStatus>> {
        let path = format!("/bots/{}/discover", segment(bot_id));
        match self.get_json::<DiscoverRequest>(&path).await {
            Ok(request) => Ok(Some(request.status)),
            Err(Error::Api { kind, .. }) if kind == "NotFound" => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// `PUT /bots/{id}/discover` — подать заявку в «Обзор».
    pub async fn request_bot_discover(&self, bot_id: &str) -> Result<()> {
        self.send_empty(
            Method::PUT,
            &format!("/bots/{}/discover", segment(bot_id)),
            None,
        )
        .await
    }

    /// `DELETE /bots/{id}/discover` — отозвать заявку.
    pub async fn cancel_bot_discover(&self, bot_id: &str) -> Result<()> {
        self.send_empty(
            Method::DELETE,
            &format!("/bots/{}/discover", segment(bot_id)),
            None,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bot_reads_with_defaults() {
        let bot: BotInfo =
            serde_json::from_str(r#"{"_id":"01B","owner":"01U","token":"t","public":true}"#)
                .unwrap();
        assert_eq!(bot.id, "01B");
        assert_eq!(bot.owner_id, "01U");
        assert!(bot.public);
        assert!(!bot.discoverable);
        assert_eq!(bot.flags, 0);
    }

    #[test]
    fn discover_status_variants() {
        let pending: DiscoverRequest =
            serde_json::from_str(r#"{"type":"Bot","id":"1","status":"Pending"}"#).unwrap();
        assert_eq!(pending.status, DiscoverStatus::Pending);
        let denied: DiscoverRequest =
            serde_json::from_str(r#"{"type":"Bot","id":"1","status":{"Denied":"спам"}}"#).unwrap();
        assert_eq!(denied.status, DiscoverStatus::Denied(Some("спам".into())));
        let removed: DiscoverRequest =
            serde_json::from_str(r#"{"type":"Bot","id":"1","status":{"Removed":null}}"#).unwrap();
        assert_eq!(removed.status, DiscoverStatus::Removed(None));
    }

    #[test]
    fn public_bot_without_avatar() {
        let bot: PublicBot = serde_json::from_str(r#"{"_id":"01B","username":"bot"}"#).unwrap();
        assert!(bot.avatar.is_empty());
        assert!(bot.description.is_empty());
    }
}

//! Запросы API для профилей, статуса, настроек аккаунта и управления сервером.
//!
//! Тела запросов на изменение собираются вызывающим кодом как JSON: в Stoat
//! это частичные обновления (`PATCH` меняет только присланные поля, а
//! очистка идёт отдельным списком `remove`), и явный JSON точнее всего
//! передаёт, что именно пользователь поменял. Ответы разбираются в модели
//! из [`revolt_models`].

use reqwest::Method;
use revolt_models::v0;
use serde::Deserialize;
use serde_json::{Value, json};
use url::Url;

use super::{HttpClient, request_headers};
use crate::error::{Error, Result};

/// Ответ `GET /auth/account/`.
#[derive(Debug, Clone, Deserialize)]
pub struct AccountInfo {
    /// Id аккаунта (совпадает с id пользователя)
    #[serde(rename = "_id")]
    pub id: String,
    /// Почта
    pub email: String,
}

/// Сессия из `GET /auth/session/all`.
#[derive(Debug, Clone, Deserialize)]
pub struct SessionInfo {
    /// Id сессии
    #[serde(rename = "_id")]
    pub id: String,
    /// Имя, которое клиент дал сессии при входе
    pub name: String,
}

/// Ответ `GET /users/{id}/mutual`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct MutualResponse {
    /// Общие друзья
    #[serde(default)]
    pub users: Vec<String>,
    /// Общие серверы
    #[serde(default)]
    pub servers: Vec<String>,
    /// Общие группы
    #[serde(default)]
    pub channels: Vec<String>,
}

/// Ответ файлового сервиса на загрузку.
#[derive(Debug, Deserialize)]
struct UploadResponse {
    id: String,
}

/// Куда загружается файл (тег Autumn определяет ограничения по размеру и типу).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadTag {
    /// Вложение сообщения
    Attachments,
    /// Аватар пользователя или участника
    Avatars,
    /// Фон профиля
    Backgrounds,
    /// Значок сервера, канала или роли
    Icons,
    /// Баннер сервера
    Banners,
    /// Свой эмодзи
    Emojis,
}

impl UploadTag {
    /// Имя тега в адресе Autumn.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Attachments => "attachments",
            Self::Avatars => "avatars",
            Self::Backgrounds => "backgrounds",
            Self::Icons => "icons",
            Self::Banners => "banners",
            Self::Emojis => "emojis",
        }
    }

    /// Тег по имени из интерфейса.
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "attachments" => Self::Attachments,
            "avatars" => Self::Avatars,
            "backgrounds" => Self::Backgrounds,
            "icons" => Self::Icons,
            "banners" => Self::Banners,
            "emojis" => Self::Emojis,
            _ => return None,
        })
    }
}

/// Часть пути: id и коды из API — ULID и латиница, но имя пользователя или
/// эмодзи-символ нужно экранировать, чтобы не сломать адрес.
pub(super) fn segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes())
        .collect::<String>()
        // в пути пробел — это %20, а не «+», как в формах
        .replace('+', "%20")
}

/// Путь реакции; `remove_all` уходит параметром запроса, как в stoat.js.
fn reaction_path(channel_id: &str, message_id: &str, emoji: &str, remove_all: bool) -> String {
    let path = format!(
        "/channels/{}/messages/{}/reactions/{}",
        segment(channel_id),
        segment(message_id),
        segment(emoji)
    );
    if remove_all {
        path + "?remove_all=true"
    } else {
        path
    }
}

impl HttpClient {
    pub(super) async fn get_json<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T> {
        let url = self.endpoint(path)?;
        self.request::<T, ()>(Method::GET, url, None, None, None)
            .await
    }

    pub(super) async fn send_json<T: serde::de::DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: &Value,
    ) -> Result<T> {
        let url = self.endpoint(path)?;
        self.request(method, url, Some(body), None, None).await
    }

    pub(super) async fn send_empty(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<()> {
        let url = self.endpoint(path)?;
        self.request_empty(method, url, body, None).await
    }

    // ───────────────────────────── пользователь ─────────────────────────────

    /// `PATCH /users/@me` — статус, имя, аватар, профиль.
    pub async fn edit_self(&self, data: &Value) -> Result<v0::User> {
        self.send_json(Method::PATCH, "/users/@me", data).await
    }

    /// `PATCH /users/@me/username` — смена имени пользователя (нужен пароль).
    pub async fn change_username(&self, username: &str, password: &str) -> Result<v0::User> {
        let body = json!({ "username": username, "password": password });
        self.send_json(Method::PATCH, "/users/@me/username", &body)
            .await
    }

    /// `GET /users/{id}/profile` — «обо мне» и фон профиля.
    pub async fn fetch_profile(&self, user_id: &str) -> Result<v0::UserProfile> {
        self.get_json(&format!("/users/{}/profile", segment(user_id)))
            .await
    }

    /// `GET /users/{id}/mutual` — общие друзья, серверы и группы.
    pub async fn fetch_mutual(&self, user_id: &str) -> Result<MutualResponse> {
        self.get_json(&format!("/users/{}/mutual", segment(user_id)))
            .await
    }

    /// `GET /users/{id}/dm` — открыть (или создать) личную переписку.
    pub async fn open_dm(&self, user_id: &str) -> Result<v0::Channel> {
        self.get_json(&format!("/users/{}/dm", segment(user_id)))
            .await
    }

    /// `POST /users/friend` — запрос дружбы по `имя#0000`.
    pub async fn send_friend_request(&self, username: &str) -> Result<v0::User> {
        self.send_json(
            Method::POST,
            "/users/friend",
            &json!({ "username": username }),
        )
        .await
    }

    /// `PUT /users/{id}/friend` — принять запрос дружбы (или отправить по id).
    pub async fn add_friend(&self, user_id: &str) -> Result<v0::User> {
        self.send_json(
            Method::PUT,
            &format!("/users/{}/friend", segment(user_id)),
            &json!({}),
        )
        .await
    }

    /// `DELETE /users/{id}/friend` — убрать из друзей или отклонить запрос.
    pub async fn remove_friend(&self, user_id: &str) -> Result<v0::User> {
        let url = self.endpoint(&format!("/users/{}/friend", segment(user_id)))?;
        self.request::<v0::User, ()>(Method::DELETE, url, None, None, None)
            .await
    }

    /// `PUT /users/{id}/block` — заблокировать.
    pub async fn block_user(&self, user_id: &str) -> Result<v0::User> {
        self.send_json(
            Method::PUT,
            &format!("/users/{}/block", segment(user_id)),
            &json!({}),
        )
        .await
    }

    /// `DELETE /users/{id}/block` — разблокировать.
    pub async fn unblock_user(&self, user_id: &str) -> Result<v0::User> {
        let url = self.endpoint(&format!("/users/{}/block", segment(user_id)))?;
        self.request::<v0::User, ()>(Method::DELETE, url, None, None, None)
            .await
    }

    // ─────────────────────────────── аккаунт ────────────────────────────────

    /// `GET /auth/account/` — почта аккаунта.
    pub async fn fetch_account(&self) -> Result<AccountInfo> {
        self.get_json("/auth/account/").await
    }

    /// `PATCH /auth/account/change/password`.
    pub async fn change_password(&self, password: &str, current_password: &str) -> Result<()> {
        let body = json!({ "password": password, "current_password": current_password });
        self.send_empty(Method::PATCH, "/auth/account/change/password", Some(&body))
            .await
    }

    /// `GET /auth/session/all` — все сессии аккаунта.
    pub async fn fetch_sessions(&self) -> Result<Vec<SessionInfo>> {
        self.get_json("/auth/session/all").await
    }

    /// `PATCH /auth/session/{id}` — переименовать сессию.
    pub async fn rename_session(&self, session_id: &str, name: &str) -> Result<SessionInfo> {
        self.send_json(
            Method::PATCH,
            &format!("/auth/session/{}", segment(session_id)),
            &json!({ "friendly_name": name }),
        )
        .await
    }

    // ─────────────────────────────── серверы ────────────────────────────────

    /// `GET /servers/{id}/members` — все участники вместе с профилями.
    ///
    /// На больших серверах браузер просит только тех, кто в сети.
    pub async fn fetch_members(
        &self,
        server_id: &str,
        exclude_offline: bool,
    ) -> Result<v0::AllMemberResponse> {
        self.get_json(&format!(
            "/servers/{}/members?exclude_offline={exclude_offline}",
            segment(server_id)
        ))
        .await
    }

    /// `GET /servers/{id}/members/{user}` — один участник.
    pub async fn fetch_member(&self, server_id: &str, user_id: &str) -> Result<v0::Member> {
        self.get_json(&format!(
            "/servers/{}/members/{}",
            segment(server_id),
            segment(user_id)
        ))
        .await
    }

    /// `PATCH /servers/{id}` — название, описание, значок, категории.
    pub async fn edit_server(&self, server_id: &str, data: &Value) -> Result<v0::Server> {
        self.send_json(
            Method::PATCH,
            &format!("/servers/{}", segment(server_id)),
            data,
        )
        .await
    }

    /// `DELETE /servers/{id}` — удалить свой сервер или выйти из чужого.
    pub async fn leave_server(&self, server_id: &str, silently: bool) -> Result<()> {
        self.send_empty(
            Method::DELETE,
            &format!("/servers/{}?leave_silently={silently}", segment(server_id)),
            None,
        )
        .await
    }

    /// `POST /servers/create`.
    pub async fn create_server(&self, name: &str) -> Result<Value> {
        self.send_json(Method::POST, "/servers/create", &json!({ "name": name }))
            .await
    }

    /// `PATCH /servers/{id}/members/{user}` — ник, роли, аватар, тайм-аут.
    pub async fn edit_member(
        &self,
        server_id: &str,
        user_id: &str,
        data: &Value,
    ) -> Result<v0::Member> {
        self.send_json(
            Method::PATCH,
            &format!(
                "/servers/{}/members/{}",
                segment(server_id),
                segment(user_id)
            ),
            data,
        )
        .await
    }

    /// `DELETE /servers/{id}/members/{user}` — исключить участника.
    pub async fn kick_member(&self, server_id: &str, user_id: &str) -> Result<()> {
        self.send_empty(
            Method::DELETE,
            &format!(
                "/servers/{}/members/{}",
                segment(server_id),
                segment(user_id)
            ),
            None,
        )
        .await
    }

    /// `PUT /servers/{id}/bans/{user}`.
    pub async fn ban_member(
        &self,
        server_id: &str,
        user_id: &str,
        reason: Option<&str>,
    ) -> Result<Value> {
        self.send_json(
            Method::PUT,
            &format!("/servers/{}/bans/{}", segment(server_id), segment(user_id)),
            &json!({ "reason": reason }),
        )
        .await
    }

    /// `DELETE /servers/{id}/bans/{user}`.
    pub async fn unban_member(&self, server_id: &str, user_id: &str) -> Result<()> {
        self.send_empty(
            Method::DELETE,
            &format!("/servers/{}/bans/{}", segment(server_id), segment(user_id)),
            None,
        )
        .await
    }

    /// `GET /servers/{id}/bans`.
    pub async fn fetch_bans(&self, server_id: &str) -> Result<v0::BanListResult> {
        self.get_json(&format!("/servers/{}/bans", segment(server_id)))
            .await
    }

    /// `GET /servers/{id}/invites`.
    pub async fn fetch_invites(&self, server_id: &str) -> Result<Vec<v0::Invite>> {
        self.get_json(&format!("/servers/{}/invites", segment(server_id)))
            .await
    }

    /// `POST /channels/{id}/invites` — новое приглашение в канал.
    pub async fn create_invite(&self, channel_id: &str) -> Result<v0::Invite> {
        self.send_json(
            Method::POST,
            &format!("/channels/{}/invites", segment(channel_id)),
            &json!({}),
        )
        .await
    }

    /// `DELETE /invites/{code}`.
    pub async fn delete_invite(&self, code: &str) -> Result<()> {
        self.send_empty(Method::DELETE, &format!("/invites/{}", segment(code)), None)
            .await
    }

    /// `GET /invites/{code}` — что за приглашение (сервер, канал, автор).
    pub async fn fetch_invite(&self, code: &str) -> Result<Value> {
        self.get_json(&format!("/invites/{}", segment(code))).await
    }

    /// `POST /invites/{code}` — вступить по приглашению.
    pub async fn join_invite(&self, code: &str) -> Result<Value> {
        self.send_json(
            Method::POST,
            &format!("/invites/{}", segment(code)),
            &json!({}),
        )
        .await
    }

    /// `POST /servers/{id}/roles`.
    pub async fn create_role(&self, server_id: &str, name: &str) -> Result<v0::NewRoleResponse> {
        self.send_json(
            Method::POST,
            &format!("/servers/{}/roles", segment(server_id)),
            &json!({ "name": name }),
        )
        .await
    }

    /// `PATCH /servers/{id}/roles/{role}` — имя, цвет, отдельная группа.
    pub async fn edit_role(
        &self,
        server_id: &str,
        role_id: &str,
        data: &Value,
    ) -> Result<v0::Role> {
        self.send_json(
            Method::PATCH,
            &format!("/servers/{}/roles/{}", segment(server_id), segment(role_id)),
            data,
        )
        .await
    }

    /// `DELETE /servers/{id}/roles/{role}`.
    pub async fn delete_role(&self, server_id: &str, role_id: &str) -> Result<()> {
        self.send_empty(
            Method::DELETE,
            &format!("/servers/{}/roles/{}", segment(server_id), segment(role_id)),
            None,
        )
        .await
    }

    /// `PUT /servers/{id}/permissions/{role}` — права роли на сервере.
    pub async fn set_role_permissions(
        &self,
        server_id: &str,
        role_id: &str,
        allow: u64,
        deny: u64,
    ) -> Result<v0::Server> {
        self.send_json(
            Method::PUT,
            &format!(
                "/servers/{}/permissions/{}",
                segment(server_id),
                segment(role_id)
            ),
            &json!({ "permissions": { "allow": allow, "deny": deny } }),
        )
        .await
    }

    /// `PUT /servers/{id}/permissions/default` — права роли «все».
    pub async fn set_default_permissions(&self, server_id: &str, allow: u64) -> Result<v0::Server> {
        self.send_json(
            Method::PUT,
            &format!("/servers/{}/permissions/default", segment(server_id)),
            &json!({ "permissions": allow }),
        )
        .await
    }

    /// `POST /servers/{id}/channels` — новый текстовый или голосовой канал.
    pub async fn create_channel(&self, server_id: &str, data: &Value) -> Result<v0::Channel> {
        self.send_json(
            Method::POST,
            &format!("/servers/{}/channels", segment(server_id)),
            data,
        )
        .await
    }

    /// `PATCH /channels/{id}` — название, описание, значок.
    pub async fn edit_channel(&self, channel_id: &str, data: &Value) -> Result<v0::Channel> {
        self.send_json(
            Method::PATCH,
            &format!("/channels/{}", segment(channel_id)),
            data,
        )
        .await
    }

    /// `DELETE /channels/{id}` — удалить канал или закрыть личную переписку.
    pub async fn delete_channel(&self, channel_id: &str) -> Result<()> {
        self.send_empty(
            Method::DELETE,
            &format!("/channels/{}", segment(channel_id)),
            None,
        )
        .await
    }

    /// `PUT /custom/emoji/{id}` — свой эмодзи из загруженного файла.
    pub async fn create_emoji(
        &self,
        file_id: &str,
        name: &str,
        server_id: &str,
    ) -> Result<v0::Emoji> {
        self.send_json(
            Method::PUT,
            &format!("/custom/emoji/{}", segment(file_id)),
            &json!({ "name": name, "parent": { "type": "Server", "id": server_id } }),
        )
        .await
    }

    /// `DELETE /custom/emoji/{id}`.
    pub async fn delete_emoji(&self, emoji_id: &str) -> Result<()> {
        self.send_empty(
            Method::DELETE,
            &format!("/custom/emoji/{}", segment(emoji_id)),
            None,
        )
        .await
    }

    // ────────────────────────────── сообщения ───────────────────────────────

    /// `PUT /channels/{id}/messages/{msg}/reactions/{emoji}`.
    pub async fn react(&self, channel_id: &str, message_id: &str, emoji: &str) -> Result<()> {
        self.send_empty(
            Method::PUT,
            &format!(
                "/channels/{}/messages/{}/reactions/{}",
                segment(channel_id),
                segment(message_id),
                segment(emoji)
            ),
            None,
        )
        .await
    }

    /// `DELETE /channels/{id}/messages/{msg}/reactions/{emoji}` — убрать реакцию.
    ///
    /// Со `remove_all` снимается этот эмодзи у всех (нужно право `ManageMessages`).
    pub async fn unreact(
        &self,
        channel_id: &str,
        message_id: &str,
        emoji: &str,
        remove_all: bool,
    ) -> Result<()> {
        self.send_empty(
            Method::DELETE,
            &reaction_path(channel_id, message_id, emoji, remove_all),
            None,
        )
        .await
    }

    /// `DELETE /channels/{id}/messages/{msg}/reactions` — снять все реакции.
    pub async fn clear_reactions(&self, channel_id: &str, message_id: &str) -> Result<()> {
        self.send_empty(
            Method::DELETE,
            &format!(
                "/channels/{}/messages/{}/reactions",
                segment(channel_id),
                segment(message_id)
            ),
            None,
        )
        .await
    }

    /// `POST` / `DELETE /channels/{id}/messages/{msg}/pin`.
    pub async fn set_pinned(&self, channel_id: &str, message_id: &str, pinned: bool) -> Result<()> {
        let method = if pinned { Method::POST } else { Method::DELETE };
        self.send_empty(
            method,
            &format!(
                "/channels/{}/messages/{}/pin",
                segment(channel_id),
                segment(message_id)
            ),
            None,
        )
        .await
    }

    /// `POST /channels/{id}/search` — поиск сообщений в канале.
    ///
    /// `query` — тело `DataMessageSearch`: строка поиска или `pinned`,
    /// порядок `sort` (`Relevance`, `Latest`, `Oldest`), `limit`.
    pub async fn search_messages(
        &self,
        channel_id: &str,
        query: &Value,
    ) -> Result<v0::BulkMessageResponse> {
        let mut body = query.clone();
        if let Some(fields) = body.as_object_mut() {
            fields.insert("include_users".into(), Value::Bool(true));
        }
        self.send_json(
            Method::POST,
            &format!("/channels/{}/search", segment(channel_id)),
            &body,
        )
        .await
    }

    /// `POST /channels/create` — новая группа с выбранными друзьями.
    pub async fn create_group(&self, name: &str, users: &[String]) -> Result<v0::Channel> {
        self.send_json(
            Method::POST,
            "/channels/create",
            &json!({ "name": name, "users": users }),
        )
        .await
    }

    /// `PUT /channels/{group}/recipients/{user}` — добавить друга в группу.
    pub async fn add_group_member(&self, group_id: &str, user_id: &str) -> Result<()> {
        self.send_empty(
            Method::PUT,
            &format!(
                "/channels/{}/recipients/{}",
                segment(group_id),
                segment(user_id)
            ),
            None,
        )
        .await
    }

    /// `POST /safety/report` — пожаловаться модераторам Stoat.
    ///
    /// `content` — что именно: `{"type": "Message" | "Server" | "User", "id", "report_reason", …}`.
    pub async fn report_content(&self, content: &Value, additional_context: &str) -> Result<()> {
        let body = json!({
            "content": content,
            "additional_context": additional_context,
        });
        self.send_empty(Method::POST, "/safety/report", Some(&body))
            .await
    }

    // ──────────────────────────────── файлы ─────────────────────────────────

    /// Загрузить файл в Autumn и получить его id для сообщения, профиля и т.п.
    pub async fn upload(
        &self,
        autumn: &str,
        tag: UploadTag,
        filename: &str,
        content_type: Option<&str>,
        bytes: Vec<u8>,
    ) -> Result<String> {
        let base = autumn.trim_end_matches('/');
        let url = Url::parse(&format!("{base}/{}", tag.as_str()))?;

        let mut part = reqwest::multipart::Part::bytes(bytes).file_name(filename.to_string());
        if let Some(mime) = content_type.filter(|mime| !mime.is_empty()) {
            part = part.mime_str(mime)?;
        }
        let form = reqwest::multipart::Form::new().part("file", part);

        let bucket = "autumn".to_string();
        self.limiter.acquire(&bucket).await;
        let headers = request_headers(self.token.as_ref(), None, &self.app_name);
        let response = self
            .http
            .post(url)
            .headers(headers)
            .multipart(form)
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(Self::parse_error(response).await);
        }
        let bytes = response.bytes().await?;
        let parsed: UploadResponse = serde_json::from_slice(&bytes).map_err(Error::from)?;
        Ok(parsed.id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_segments_are_escaped() {
        assert_eq!(
            segment("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
            "01ARZ3NDEKTSV4RRFFQ69G5FAV"
        );
        assert_eq!(segment("👍"), "%F0%9F%91%8D");
        assert_eq!(segment("a b/c"), "a%20b%2Fc");
    }

    #[test]
    fn reaction_paths_escape_emoji() {
        assert_eq!(
            reaction_path("c1", "m1", "👍", false),
            "/channels/c1/messages/m1/reactions/%F0%9F%91%8D"
        );
        assert_eq!(
            reaction_path("c1", "m1", "01GZ8K1WZ6J0X8Y4V3T2R1Q0PN", true),
            "/channels/c1/messages/m1/reactions/01GZ8K1WZ6J0X8Y4V3T2R1Q0PN?remove_all=true"
        );
    }

    #[test]
    fn endpoint_keeps_base_path() {
        let own = HttpClient::new(Url::parse("https://host.example/api").unwrap());
        assert_eq!(
            own.endpoint("/users/@me").unwrap().as_str(),
            "https://host.example/api/users/@me"
        );
        assert_eq!(
            own.bucket_of(&own.endpoint("/users/@me").unwrap()),
            "users/@me"
        );

        let official = HttpClient::new(Url::parse("https://api.stoat.chat").unwrap());
        assert_eq!(
            official
                .endpoint("/servers/s1/members?exclude_offline=true")
                .unwrap()
                .as_str(),
            "https://api.stoat.chat/servers/s1/members?exclude_offline=true"
        );
        assert_eq!(
            official.endpoint("/").unwrap().as_str(),
            "https://api.stoat.chat/"
        );
    }

    #[test]
    fn upload_tags_round_trip() {
        for tag in [
            UploadTag::Attachments,
            UploadTag::Avatars,
            UploadTag::Backgrounds,
            UploadTag::Icons,
            UploadTag::Banners,
            UploadTag::Emojis,
        ] {
            assert_eq!(UploadTag::parse(tag.as_str()), Some(tag));
        }
        assert_eq!(UploadTag::parse("nope"), None);
    }
}

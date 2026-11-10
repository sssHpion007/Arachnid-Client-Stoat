//! REST-транспорт Stoat.
//!
//! Тонкий, но полный слой над API 0.16.x: типы берутся из официального крейта
//! [`revolt_models`], поэтому модели не приходится переобъявлять руками.
//! Здесь же живёт вся аккуратность с заголовками: `x-session-token` для
//! пользовательских сессий, `x-bot-token` для ботов, `Idempotency-Key` при
//! отправке сообщений и разбор ошибок вида `{"type": "NotFound"}`.

use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{Method, StatusCode};
use revolt_models::v0;
use serde::de::DeserializeOwned;
use url::Url;

use crate::error::{Error, Result};
use crate::ratelimit::RateLimiter;

const HEADER_SESSION: &str = "x-session-token";
const HEADER_BOT: &str = "x-bot-token";
const HEADER_USER_AGENT: &str = "user-agent"; // HeaderName::from_static требует нижний регистр
const HEADER_IDEMPOTENCY: &str = "Idempotency-Key";

/// Кто именно обращается к API.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Token {
    /// Пользовательская сессия
    Session(String),
    /// Токен бота
    Bot(String),
}

impl Token {
    fn header(&self) -> HeaderName {
        match self {
            Self::Session(_) => HeaderName::from_static(HEADER_SESSION),
            Self::Bot(_) => HeaderName::from_static(HEADER_BOT),
        }
    }

    fn value(&self) -> HeaderValue {
        let raw = match self {
            Self::Session(value) | Self::Bot(value) => value,
        };
        // токен приходит от пользователя — не паникуем на непечатаемых символах
        HeaderValue::from_str(raw).unwrap_or_else(|_| HeaderValue::from_static(""))
    }
}

/// HTTP-клиент одного инстанса.
///
/// Дешево клонируется: внутри `reqwest::Client` (Arc) и общий [`RateLimiter`].
#[derive(Debug, Clone)]
pub struct HttpClient {
    http: reqwest::Client,
    base: Url,
    token: Option<Token>,
    app_name: String,
    limiter: RateLimiter,
}

impl HttpClient {
    /// Клиент без токена: нужен для `GET /` и логина.
    pub fn new(base: Url) -> Self {
        install_crypto_provider();
        let http = reqwest::Client::builder()
            .user_agent(format!(
                "{}/{}",
                crate::DEFAULT_APP_NAME,
                env!("CARGO_PKG_VERSION")
            ))
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("сборка reqwest::Client с валидным конфигом");

        Self {
            http,
            base,
            token: None,
            app_name: crate::DEFAULT_APP_NAME.to_string(),
            limiter: RateLimiter::new(),
        }
    }

    /// Установить или сбросить токен.
    pub fn set_token(&mut self, token: Option<Token>) {
        self.token = token;
    }

    /// Текущий токен (для проверки «залогинены ли мы»).
    pub fn token(&self) -> Option<&Token> {
        self.token.as_ref()
    }

    /// Имя приложения, попадающее в поле `friendly_name` сессии.
    pub fn set_app_name(&mut self, name: impl Into<String>) {
        self.app_name = name.into();
    }

    /// Базовый адрес API.
    pub fn base_url(&self) -> &Url {
        &self.base
    }

    /// Общий rate-limiter (нужен, чтобы UI показывал состояние и плагины
    /// не обходили ограничения).
    pub fn rate_limiter(&self) -> &RateLimiter {
        &self.limiter
    }

    fn endpoint(&self, path: &str) -> Result<Url> {
        Ok(self.base.join(path)?)
    }

    /// `GET /` — конфигурация инстанса.
    pub async fn get_root(&self) -> Result<crate::ApiRoot> {
        let url = self.endpoint("/")?;
        self.request::<crate::ApiRoot, ()>(Method::GET, url, None::<&()>, None, None)
            .await
    }

    /// `POST /auth/session/login` — вход по email/паролю (или MFA-тикету).
    pub async fn login(&self, data: v0::DataLogin) -> Result<v0::ResponseLogin> {
        let url = self.endpoint("/auth/session/login")?;
        self.request(Method::POST, url, Some(&data), None, None)
            .await
    }

    /// `POST /auth/session/logout` — завершить текущую сессию.
    pub async fn logout(&self) -> Result<()> {
        let url = self.endpoint("/auth/session/logout")?;
        self.request_empty(Method::POST, url, None::<&()>, None)
            .await
    }

    /// `GET /users/@me` — текущий пользователь.
    pub async fn fetch_self(&self) -> Result<v0::User> {
        let url = self.endpoint("/users/@me")?;
        self.request(Method::GET, url, None::<&()>, None, None)
            .await
    }

    /// `GET /users/{id}` — пользователь по id.
    pub async fn fetch_user(&self, user_id: &str) -> Result<v0::User> {
        let url = self.endpoint(&format!("/users/{user_id}"))?;
        self.request(Method::GET, url, None::<&()>, None, None)
            .await
    }

    /// `GET /users/dms` — список ЛС-каналов.
    pub async fn fetch_dms(&self) -> Result<Vec<v0::Channel>> {
        let url = self.endpoint("/users/dms")?;
        self.request(Method::GET, url, None::<&()>, None, None)
            .await
    }

    /// `GET /servers/{id}` — сервер.
    pub async fn fetch_server(&self, server_id: &str) -> Result<v0::Server> {
        let url = self.endpoint(&format!("/servers/{server_id}"))?;
        self.request(Method::GET, url, None::<&()>, None, None)
            .await
    }

    /// `GET /channels/{id}` — канал.
    pub async fn fetch_channel(&self, channel_id: &str) -> Result<v0::Channel> {
        let url = self.endpoint(&format!("/channels/{channel_id}"))?;
        self.request(Method::GET, url, None::<&()>, None, None)
            .await
    }

    /// `POST /channels/{id}/messages` — отправить сообщение.
    ///
    /// Использует `Idempotency-Key`: повторная отправка того же ключа не создаёт
    /// дубликат сообщения — это важно, если сеть отвалилась после отправки.
    pub async fn send_message(
        &self,
        channel_id: &str,
        data: v0::DataMessageSend,
        idempotency_key: Option<String>,
    ) -> Result<v0::Message> {
        let url = self.endpoint(&format!("/channels/{channel_id}/messages"))?;
        self.request(Method::POST, url, Some(&data), idempotency_key, None)
            .await
    }

    /// `PATCH /channels/{id}/messages/{msg}` — изменить сообщение.
    pub async fn edit_message(
        &self,
        channel_id: &str,
        message_id: &str,
        data: v0::DataEditMessage,
    ) -> Result<v0::Message> {
        let url = self.endpoint(&format!("/channels/{channel_id}/messages/{message_id}"))?;
        self.request(Method::PATCH, url, Some(&data), None, None)
            .await
    }

    /// `DELETE /channels/{id}/messages/{msg}` — удалить сообщение.
    pub async fn delete_message(&self, channel_id: &str, message_id: &str) -> Result<()> {
        let url = self.endpoint(&format!("/channels/{channel_id}/messages/{message_id}"))?;
        self.request_empty(Method::DELETE, url, None::<&()>, None)
            .await
    }

    /// `GET /channels/{id}/messages` — история сообщений.
    ///
    /// `before` — курсор «загрузить более старые», `after` — «более новые»,
    /// `limit` — размер страницы (Stoat обычно ограничивает 100).
    pub async fn fetch_messages(
        &self,
        channel_id: &str,
        before: Option<&str>,
        after: Option<&str>,
        limit: Option<u32>,
    ) -> Result<v0::BulkMessageResponse> {
        let mut url = self.endpoint(&format!("/channels/{channel_id}/messages"))?;
        {
            let mut query = url.query_pairs_mut();
            if let Some(before) = before {
                query.append_pair("before", before);
            }
            if let Some(after) = after {
                query.append_pair("after", after);
            }
            if let Some(limit) = limit {
                query.append_pair("limit", &limit.to_string());
            }
            query.append_pair("include_users", "true");
        }
        self.request(Method::GET, url, None::<&()>, None, None)
            .await
    }

    /// Обобщённый запрос с JSON-телом и разбором JSON-ответа.
    async fn request<T, B>(
        &self,
        method: Method,
        url: Url,
        body: Option<&B>,
        idempotency_key: Option<String>,
        bucket: Option<String>,
    ) -> Result<T>
    where
        T: DeserializeOwned,
        B: serde::Serialize + ?Sized,
    {
        let response = self
            .send(method.clone(), url.clone(), body, idempotency_key, bucket)
            .await?;
        let status = response.status();

        if !status.is_success() {
            return Err(Self::parse_error(response).await);
        }

        let bytes = response.bytes().await?;
        serde_json::from_slice(&bytes).map_err(Error::from)
    }

    /// Обобщённый запрос, ответ которого не нужен.
    async fn request_empty<B>(
        &self,
        method: Method,
        url: Url,
        body: Option<&B>,
        idempotency_key: Option<String>,
    ) -> Result<()>
    where
        B: serde::Serialize + ?Sized,
    {
        let response = self.send(method, url, body, idempotency_key, None).await?;
        let status = response.status();

        if !status.is_success() {
            return Err(Self::parse_error(response).await);
        }
        Ok(())
    }

    async fn send<B>(
        &self,
        method: Method,
        url: Url,
        body: Option<&B>,
        idempotency_key: Option<String>,
        bucket: Option<String>,
    ) -> Result<reqwest::Response>
    where
        B: serde::Serialize + ?Sized,
    {
        let bucket = bucket.unwrap_or_else(|| Self::bucket_for(&url));
        self.limiter.acquire(&bucket).await;

        let mut headers = HeaderMap::new();
        if let Some(token) = &self.token {
            headers.insert(token.header(), token.value());
        }
        if let Some(value) = idempotency_key
            .as_deref()
            .and_then(|key| HeaderValue::from_str(key).ok())
        {
            headers.insert(HeaderName::from_static(HEADER_IDEMPOTENCY), value);
        }
        headers.insert(
            HeaderName::from_static(HEADER_USER_AGENT),
            HeaderValue::from_str(&format!("{}/{}", self.app_name, env!("CARGO_PKG_VERSION")))
                .unwrap_or_else(|_| HeaderValue::from_static("Tauri-Stoat")),
        );

        let mut request = self
            .http
            .request(method.clone(), url.clone())
            .headers(headers);

        if let Some(body) = body {
            request = request.json(body);
        }

        tracing::trace!(%method, %url, "→ запрос");
        let response = request.send().await?;
        tracing::trace!(%method, %url, status = %response.status(), "← ответ");

        self.observe_rate_limit(&bucket, &response);

        if response.status() == StatusCode::TOO_MANY_REQUESTS {
            let retry_after = Self::retry_after(&response);
            self.limiter.penalize(bucket, retry_after).await;
            return Err(Error::RateLimited(retry_after));
        }

        Ok(response)
    }

    /// Имя бакета по заголовку ответа, иначе — по шаблону пути.
    ///
    /// Второй вариант нужен на первом запросе, когда сервер ещё не сказал имя.
    fn bucket_for(url: &Url) -> String {
        let segments: Vec<&str> = url
            .path_segments()
            .map(|s| s.filter(|part| !part.is_empty()).collect())
            .unwrap_or_default();

        match segments.as_slice() {
            [] => "root".to_string(),
            ["auth", rest @ ..] => format!("auth/{}", rest.first().copied().unwrap_or("session")),
            ["users", "@me", ..] => "users/@me".to_string(),
            ["users", ..] => "users".to_string(),
            ["servers", ..] => "servers".to_string(),
            ["channels", id, "messages", ..] => format!("channels/{id}/messages"),
            ["channels", id, ..] => format!("channels/{id}"),
            [first, ..] => (*first).to_string(),
        }
    }

    fn observe_rate_limit(&self, bucket: &str, response: &reqwest::Response) {
        let header = |name: &str| {
            response
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
        };

        let name = header("x-ratelimit-bucket").unwrap_or(bucket).to_string();
        let limit = header("x-ratelimit-limit").and_then(|v| v.parse::<u32>().ok());
        let remaining = header("x-ratelimit-remaining").and_then(|v| v.parse::<u32>().ok());
        let reset_after = header("x-ratelimit-reset-after").and_then(|v| v.parse::<f64>().ok());

        if let (Some(limit), Some(remaining), Some(reset_after)) = (limit, remaining, reset_after) {
            let limiter = self.limiter.clone();
            let bucket = name.clone();
            let reset_after = Duration::from_secs_f64(reset_after.max(0.0));
            // состояние обновляем без блокировки вызывающего кода
            tokio::spawn(async move {
                limiter.update(bucket, limit, remaining, reset_after).await;
            });
        }
    }

    fn retry_after(response: &reqwest::Response) -> Duration {
        response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<f64>().ok())
            .map(Duration::from_secs_f64)
            .unwrap_or(Duration::from_secs(1))
    }

    /// Разобрать ошибку Stoat: `{"type": "NotFound"}` или `{"type":"…","location":"…"}`.
    async fn parse_error(response: reqwest::Response) -> Error {
        let status = response.status();
        let code = status.as_u16();

        if status == StatusCode::UNAUTHORIZED {
            return Error::Unauthorized;
        }

        let body = response.text().await.unwrap_or_default();
        let parsed: Option<serde_json::Value> = serde_json::from_str(&body).ok();

        let kind = parsed
            .as_ref()
            .and_then(|value| value.get("type"))
            .and_then(|value| value.as_str())
            .unwrap_or("Unknown")
            .to_string();

        let message = parsed
            .as_ref()
            .and_then(|value| value.get("location"))
            .and_then(|value| value.as_str())
            .map(|location| format!("location: {location}"))
            .unwrap_or_else(|| body.chars().take(300).collect());

        Error::Api {
            kind,
            message,
            status: code,
        }
    }
}

/// Поставить криптопровайдер rustls один раз на процесс.
///
/// `reqwest` собран с `rustls-no-provider`, поэтому выбор провайдера — на нас.
/// Идемпотентно: повторный вызов безопасен (ошибка «уже установлен» игнорируется).
fn install_crypto_provider() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        // ring выбран, чтобы сборка не требовала cmake/периферии под aws-lc
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// Заголовки, которые клиент выставляет сам (для тестов и диагностики).
pub fn default_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static(HEADER_USER_AGENT),
        HeaderValue::from_static(crate::DEFAULT_APP_NAME),
    );
    headers
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(path: &str) -> Url {
        Url::parse(&format!("https://api.stoat.chat{path}")).unwrap()
    }

    #[test]
    fn bucket_names_follow_api_shape() {
        assert_eq!(HttpClient::bucket_for(&url("/")), "root");
        assert_eq!(
            HttpClient::bucket_for(&url("/channels/01ABC/messages")),
            "channels/01ABC/messages"
        );
        assert_eq!(
            HttpClient::bucket_for(&url("/channels/01ABC/messages/01MSG")),
            "channels/01ABC/messages"
        );
        assert_eq!(HttpClient::bucket_for(&url("/users/@me")), "users/@me");
        assert_eq!(HttpClient::bucket_for(&url("/servers/01S")), "servers");
        assert_eq!(
            HttpClient::bucket_for(&url("/auth/session/login")),
            "auth/session"
        );
    }

    #[test]
    fn session_and_bot_use_different_headers() {
        assert_eq!(
            Token::Session("t".into()).header().as_str(),
            "x-session-token"
        );
        assert_eq!(Token::Bot("t".into()).header().as_str(), "x-bot-token");
    }

    #[test]
    fn gateway_url_carries_version_and_ready_fields() {
        let mut instance = crate::Instance::official();
        instance
            .apply_root(&crate::ApiRoot {
                stoat: None,
                revolt: None,
                ws: Some("wss://events.example.com".into()),
                app: None,
                vapid: None,
                features: serde_json::json!({}),
            })
            .unwrap();

        let url = instance.gateway_url(&[crate::ReadyField::Users, crate::ReadyField::Channels]);
        let raw = url.as_str();
        assert!(raw.starts_with("wss://events.example.com/"));
        assert!(raw.contains("version=1"));
        assert!(raw.contains("format=json"));
        assert!(raw.contains("ready=users"));
        assert!(raw.contains("ready=channels"));
        // токен не должен попадать в URL
        assert!(!raw.contains("token"));
    }
}

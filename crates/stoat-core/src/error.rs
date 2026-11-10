//! Ошибки ядра.

use thiserror::Error;

/// Результат операций ядра.
pub type Result<T> = std::result::Result<T, Error>;

/// Все ошибки, которые может вернуть `stoat-core`.
#[derive(Debug, Error)]
pub enum Error {
    /// Ошибка HTTP-транспорта
    #[error("сетевая ошибка: {0}")]
    Network(#[from] reqwest::Error),

    /// Ошибка WebSocket-транспорта
    #[error("ошибка websocket: {0}")]
    WebSocket(#[from] tokio_tungstenite::tungstenite::Error),

    /// Некорректный URL
    #[error("некорректный URL: {0}")]
    Url(#[from] url::ParseError),

    /// Ошибка сериализации/десериализации JSON
    #[error("ошибка JSON: {0}")]
    Json(#[from] serde_json::Error),

    /// Инстанс ответил ошибкой в формате Stoat (`{"type": "..."}`)
    #[error("API вернул ошибку {kind}: {message}")]
    Api {
        /// Тип ошибки из API (`NotFound`, `MissingPermission`, …)
        kind: String,
        /// Пояснение, если сервер его прислал
        message: String,
        /// HTTP-код ответа
        status: u16,
    },

    /// Не авторизованы: нет токена или сессия отклонена
    #[error("требуется авторизация")]
    Unauthorized,

    /// Сервер ограничил частоту запросов, повторите позже
    #[error("превышен лимит запросов, повтор через {0:?}")]
    RateLimited(std::time::Duration),

    /// Истёк срок действия MFA-тикета
    #[error("MFA-тикет недействителен: {0}")]
    MfaTicket(String),

    /// Gateway прислал событие `Error`
    #[error("gateway вернул ошибку: {0}")]
    Gateway(String),

    /// Соединение закрыто
    #[error("соединение закрыто")]
    ConnectionClosed,

    /// Внутреннее несоответствие (не должно встречаться в норме)
    #[error("внутренняя ошибка: {0}")]
    Internal(String),
}

impl Error {
    /// Стоит ли повторить запрос (сеть, лимит, временная ошибка сервера).
    pub fn is_retryable(&self) -> bool {
        match self {
            Self::Network(_) | Self::ConnectionClosed | Self::RateLimited(_) => true,
            Self::Api { status, .. } => *status == 429 || *status >= 500,
            _ => false,
        }
    }

    /// Ошибка означает, что сессию нужно пересоздать.
    pub fn is_auth_failure(&self) -> bool {
        matches!(self, Self::Unauthorized)
            || matches!(self, Self::Api { status, .. } if *status == 401)
    }
}

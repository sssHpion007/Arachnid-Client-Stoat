//! # stoat-core
//!
//! Ядро клиента Stoat (бывший Revolt): конфигурация инстанса, REST-транспорт,
//! gateway (WebSocket) и кэш состояния.
//!
//! Крейт не знает ничего про UI и про плагины — это фундамент, поверх которого
//! строятся и Tauri-команды, и plugin-host.
//!
//! ## Быстрый старт
//!
//! ```no_run
//! use stoat_core::{Instance, http::{HttpClient, Token}};
//!
//! # async fn run() -> Result<(), stoat_core::Error> {
//! // Конфигурация официального инстанса, можно переопределить URL для self-hosted
//! let instance = Instance::official();
//!
//! // Конфигурацию инстанса получаем из API-root (`GET /`)
//! let features = instance.discover().await?;
//! let mut http = HttpClient::new(instance.api_url.clone());
//!
//! // Авторизация по session-токену (рекомендуемый способ для сторонних клиентов)
//! http.set_token(Some(Token::Session("session-token".to_string())));
//! let me = http.fetch_self().await?;
//! println!("вошли как {}", me.username);
//! # Ok(())
//! # }
//! ```

pub mod cache;
pub mod error;
pub mod gateway;
pub mod http;
pub mod ratelimit;

pub use error::{Error, Result};

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use url::Url;

/// Описание инстанса Stoat: адреса API, gateway и файлового сервиса.
///
/// Создаётся через [`Instance::official`] либо [`Instance::custom`] для
/// self-hosted серверов. Поля `api_url` и `ws_url` можно переопределить
/// после [`Instance::discover`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Instance {
    /// Базовый URL REST API, например `https://api.stoat.chat`
    pub api_url: Url,
    /// URL gateway (WebSocket), например `wss://events.stoat.chat`
    pub ws_url: Url,
    /// Человекочитаемое имя инстанса (для UI и логов)
    pub name: String,
    /// Имя приложения, которое видит Stoat в списке сессий
    pub app_name: String,
}

impl Instance {
    /// Официальный инстанс `stoat.chat`.
    pub fn official() -> Self {
        Self {
            api_url: Url::parse("https://api.stoat.chat").expect("валидный URL"),
            ws_url: Url::parse("wss://events.stoat.chat").expect("валидный URL"),
            name: "stoat.chat".to_string(),
            app_name: DEFAULT_APP_NAME.to_string(),
        }
    }

    /// Свой инстанс: `api_url` — адрес API, `ws_url` — адрес gateway.
    pub fn custom(api_url: impl AsRef<str>, ws_url: impl AsRef<str>) -> Result<Self> {
        let api_url = Url::parse(api_url.as_ref())?;
        let ws_url = Url::parse(ws_url.as_ref())?;
        Ok(Self {
            name: api_url.host_str().unwrap_or("custom").to_string(),
            api_url,
            ws_url,
            app_name: DEFAULT_APP_NAME.to_string(),
        })
    }

    /// Запросить [`ApiRoot`] и, если инстанс отдал другие адреса, применить их.
    ///
    /// Многие self-hosted установки отдают `ws` отдельным адресом — его и
    /// используем, потому что угадывать путь к gateway ненадёжно.
    pub async fn discover(&self) -> Result<ApiRoot> {
        let http = http::HttpClient::new(self.api_url.clone());
        let root: ApiRoot = http.get_root().await?;
        Ok(root)
    }

    /// Дополнить инстанс после [`Instance::discover`].
    pub fn apply_root(&mut self, root: &ApiRoot) -> Result<()> {
        if let Some(ws) = &root.ws {
            self.ws_url = Url::parse(ws)?;
        }
        if let Some(app) = &root.app {
            tracing::debug!(app, "инстанс сообщил web-адрес");
        }
        Ok(())
    }

    /// URL gateway с параметрами `version=1&format=json` и списком полей `Ready`.
    ///
    /// Токен сюда не подставляется: авторизуемся отдельным событием
    /// [`gateway::ClientEvent::Authenticate`], чтобы он не попадал в логи URL.
    pub fn gateway_url(&self, ready: &[ReadyField]) -> Url {
        let mut url = self.ws_url.clone();
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("version", "1");
            query.append_pair("format", "json");
            for field in ready {
                query.append_pair("ready", field.as_str());
            }
        }
        url
    }
}

/// Имя приложения по умолчанию (видно в Stoat → Настройки → Сессии).
pub const DEFAULT_APP_NAME: &str = "Arachnid Client";

/// Поля, которые нужно прислать в событии `Ready`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadyField {
    Users,
    Servers,
    Channels,
    Members,
    Emojis,
    UserSettings,
    ChannelUnreads,
    PolicyChanges,
}

impl ReadyField {
    /// Строковое значение для query-параметра `ready`.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Users => "users",
            Self::Servers => "servers",
            Self::Channels => "channels",
            Self::Members => "members",
            Self::Emojis => "emojis",
            Self::UserSettings => "user_settings",
            Self::ChannelUnreads => "channel_unreads",
            Self::PolicyChanges => "policy_changes",
        }
    }
}

/// Ответ `GET /` — конфигурация инстанса.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiRoot {
    /// Версия Stoat
    #[serde(default)]
    pub stoat: Option<String>,
    /// Устаревшее имя версии (Revolt)
    #[serde(default)]
    pub revolt: Option<String>,
    /// Адрес gateway
    #[serde(default)]
    pub ws: Option<String>,
    /// Адрес web-клиента
    #[serde(default)]
    pub app: Option<String>,
    /// VAPID-ключ для web-push
    #[serde(default)]
    pub vapid: Option<String>,
    /// Возможности и лимиты инстанса
    #[serde(default)]
    pub features: serde_json::Value,
}

impl ApiRoot {
    /// Включены ли на инстансе голосовые каналы (LiveKit).
    pub fn voice_enabled(&self) -> bool {
        self.features
            .get("livekit")
            .and_then(|v| v.get("enabled"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }

    /// Разрешено ли видео (камера и демонстрация экрана) в звонках.
    ///
    /// Лимиты обычного пользователя — `features.limits.default`, у старых
    /// инстансов есть только лимиты новичка (`new_user`), как в
    /// `Instance.limits` браузерного клиента.
    pub fn video_enabled(&self) -> bool {
        let limits = self.features.get("limits");
        ["default", "new_user"]
            .iter()
            .find_map(|kind| {
                limits
                    .and_then(|limits| limits.get(kind))
                    .and_then(|limits| limits.get("video"))
                    .and_then(|video| video.as_bool())
            })
            .unwrap_or(false)
    }

    /// Наибольшее разрешение видео `[ширина, высота]` из ограничений
    /// инстанса (`limits.*.video_resolution`); `[0, 0]` — без ограничений.
    pub fn video_resolution(&self) -> [u64; 2] {
        let limits = self.features.get("limits");
        ["default", "new_user"]
            .iter()
            .find_map(|kind| {
                let pair = limits?.get(kind)?.get("video_resolution")?.as_array()?;
                Some([pair.first()?.as_u64()?, pair.get(1)?.as_u64()?])
            })
            .unwrap_or([0, 0])
    }

    /// URL файлового сервиса Autumn, если инстанс его объявил.
    pub fn autumn_url(&self) -> Option<&str> {
        self.features
            .get("autumn")
            .and_then(|v| v.get("url"))
            .and_then(|v| v.as_str())
    }

    /// URL прокси January для сторонних картинок и видео из встраиваний,
    /// если он включён на инстансе.
    pub fn january_url(&self) -> Option<&str> {
        let january = self.features.get("january")?;
        if january.get("enabled").and_then(|v| v.as_bool()) == Some(false) {
            return None;
        }
        january.get("url").and_then(|v| v.as_str())
    }

    /// Правовые документы инстанса (`features.legal_links`): ссылки внизу
    /// списка разделов в настройках.
    pub fn legal_links(&self) -> LegalLinks {
        self.features
            .get("legal_links")
            .cloned()
            .and_then(|links| serde_json::from_value(links).ok())
            .unwrap_or_default()
    }

    /// Предельные размеры загружаемых файлов по тегам Autumn
    /// (`features.limits.*.file_upload_size_limits`). Новым аккаунтам, моложе
    /// `global.new_user_hours`, действуют ограничения `new_user`.
    pub fn upload_limits(&self) -> UploadLimits {
        let limits = self.features.get("limits");
        let sizes = |kind: &str| -> BTreeMap<String, u64> {
            let mut sizes = UploadLimits::fallback_sizes();
            if let Some(map) = limits
                .and_then(|limits| limits.get(kind))
                .and_then(|limits| limits.get("file_upload_size_limits"))
                .and_then(|map| map.as_object())
            {
                for (tag, size) in map {
                    if let Some(size) = size.as_u64() {
                        sizes.insert(tag.clone(), size);
                    }
                }
            }
            sizes
        };
        UploadLimits {
            new_user_hours: limits
                .and_then(|limits| limits.get("global"))
                .and_then(|global| global.get("new_user_hours"))
                .and_then(|hours| hours.as_u64())
                .unwrap_or(72),
            new_user: sizes("new_user"),
            default: sizes("default"),
        }
    }
}

/// Предельные размеры файлов по тегам (`avatars`, `backgrounds`, `icons`,
/// `banners`, `emojis`, `attachments`) в байтах.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UploadLimits {
    /// Сколько часов аккаунт считается новым
    pub new_user_hours: u64,
    /// Ограничения нового аккаунта
    pub new_user: BTreeMap<String, u64>,
    /// Ограничения остальных аккаунтов
    pub default: BTreeMap<String, u64>,
}

impl Default for UploadLimits {
    /// Ограничения сервера Stoat по умолчанию — пока конфигурация не получена.
    fn default() -> Self {
        Self {
            new_user_hours: 72,
            new_user: Self::fallback_sizes(),
            default: Self::fallback_sizes(),
        }
    }
}

impl UploadLimits {
    /// Предельный размер файла с тегом `tag` для обычного (не нового) аккаунта.
    pub fn max_size(&self, tag: &str) -> u64 {
        self.default
            .get(tag)
            .copied()
            .or_else(|| Self::fallback_sizes().get(tag).copied())
            .unwrap_or(0)
    }

    /// Значения по умолчанию сервера Stoat, если инстанс их не прислал.
    fn fallback_sizes() -> BTreeMap<String, u64> {
        [
            ("attachments", 20_000_000),
            ("avatars", 4_000_000),
            ("backgrounds", 6_000_000),
            ("icons", 2_500_000),
            ("banners", 6_000_000),
            ("emojis", 500_000),
        ]
        .into_iter()
        .map(|(tag, size)| (tag.to_string(), size))
        .collect()
    }
}

/// Ссылки на правила инстанса; пустые поля сервер не присылает.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegalLinks {
    /// Условия использования
    #[serde(default)]
    pub terms_of_service: Option<String>,
    /// Политика конфиденциальности
    #[serde(default)]
    pub privacy_policy: Option<String>,
    /// Правила сообщества
    #[serde(default)]
    pub guidelines: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_limit_from_features() {
        let root: ApiRoot = serde_json::from_value(serde_json::json!({
            "features": { "limits": { "new_user": { "video": false }, "default": { "video": true } } }
        }))
        .unwrap();
        assert!(root.video_enabled());

        let old: ApiRoot = serde_json::from_value(serde_json::json!({
            "features": { "limits": { "new_user": { "video": true } } }
        }))
        .unwrap();
        assert!(old.video_enabled());

        let none: ApiRoot = serde_json::from_value(serde_json::json!({ "features": {} })).unwrap();
        assert!(!none.video_enabled());
    }

    #[test]
    fn upload_limit_falls_back_to_defaults() {
        let limits = UploadLimits::default();
        assert_eq!(limits.max_size("emojis"), 500_000);
        assert_eq!(limits.max_size("attachments"), 20_000_000);
        assert_eq!(limits.max_size("unknown"), 0);
    }

    #[test]
    fn upload_limits_from_features() {
        let root: ApiRoot = serde_json::from_value(serde_json::json!({
            "features": {
                "limits": {
                    "global": { "new_user_hours": 24 },
                    "new_user": { "file_upload_size_limits": { "avatars": 1000 } },
                    "default": { "file_upload_size_limits": { "emojis": 2000 } }
                }
            }
        }))
        .unwrap();
        let limits = root.upload_limits();
        assert_eq!(limits.new_user_hours, 24);
        assert_eq!(limits.new_user["avatars"], 1000);
        assert_eq!(limits.new_user["emojis"], 500_000);
        assert_eq!(limits.default["emojis"], 2000);
        assert_eq!(limits.default["avatars"], 4_000_000);

        let empty: ApiRoot = serde_json::from_value(serde_json::json!({ "features": {} })).unwrap();
        assert_eq!(empty.upload_limits().new_user_hours, 72);
        assert_eq!(empty.video_resolution(), [0, 0]);

        let video: ApiRoot = serde_json::from_value(serde_json::json!({
            "features": { "limits": { "new_user": { "video_resolution": [1080, 720] } } }
        }))
        .unwrap();
        assert_eq!(video.video_resolution(), [1080, 720]);
    }

    #[test]
    fn legal_links_from_features() {
        let root: ApiRoot = serde_json::from_value(serde_json::json!({
            "features": {
                "legal_links": {
                    "terms_of_service": "https://stoat.chat/terms",
                    "privacy_policy": "https://stoat.chat/privacy"
                }
            }
        }))
        .unwrap();
        let links = root.legal_links();
        assert_eq!(
            links.terms_of_service.as_deref(),
            Some("https://stoat.chat/terms")
        );
        assert_eq!(links.guidelines, None);

        let bare: ApiRoot = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(bare.legal_links(), LegalLinks::default());
    }
}

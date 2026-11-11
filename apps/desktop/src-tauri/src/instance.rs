//! Какой веб-клиент Stoat открывать: раздел `[instance]` файла `config.toml`.
//!
//! Как и Stoat for Desktop (`--force-server`), клиент по умолчанию открывает
//! официальный https://stoat.chat/app. Для своего инстанса в `config.toml`
//! указывается адрес его веб-клиента:
//!
//! ```toml
//! [instance]
//! app_url = "https://stoat.example.com"
//! ```
//!
//! Нативные команды доступны только страницам с этого адреса, и окно не
//! уходит с него на другие сайты.

use std::net::IpAddr;
use std::path::Path;

use serde::Deserialize;
use url::{Host, Url};

/// Веб-клиент официального инстанса.
pub const DEFAULT_APP_URL: &str = "https://stoat.chat/app";

/// Файл настроек в каталоге данных (его же ищет портативный режим).
pub const CONFIG_FILE: &str = "config.toml";

/// Содержимое `config.toml`; остальные разделы оболочке не нужны.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ConfigFile {
    instance: InstanceSection,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct InstanceSection {
    /// Адрес веб-клиента
    app_url: Option<String>,
}

/// Инстанс, веб-клиент которого открыт в окне.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Instance {
    /// Адрес, с которого загружается веб-клиент
    pub app_url: Url,
}

impl Default for Instance {
    fn default() -> Self {
        Self {
            app_url: Url::parse(DEFAULT_APP_URL).expect("адрес по умолчанию корректен"),
        }
    }
}

impl Instance {
    /// Прочитать `config.toml` из каталога данных. Без файла или с ошибкой в
    /// нём открывается официальный клиент, а причина пишется в журнал.
    pub fn load(dir: &Path) -> Self {
        match std::fs::read_to_string(dir.join(CONFIG_FILE)) {
            Ok(text) => Self::parse(&text),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Self::default(),
            Err(error) => {
                tracing::warn!(%error, "config.toml не читается, открываю {DEFAULT_APP_URL}");
                Self::default()
            }
        }
    }

    fn parse(text: &str) -> Self {
        // PowerShell 5 пишет UTF-8 с BOM
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        let file: ConfigFile = match toml::from_str(text) {
            Ok(file) => file,
            Err(error) => {
                tracing::warn!(%error, "ошибка в config.toml, открываю {DEFAULT_APP_URL}");
                return Self::default();
            }
        };
        let Some(raw) = file.instance.app_url else {
            return Self::default();
        };
        match parse_app_url(&raw) {
            Ok(app_url) => Self { app_url },
            Err(reason) => {
                tracing::warn!(%raw, reason, "app_url в config.toml не подходит, открываю {DEFAULT_APP_URL}");
                Self::default()
            }
        }
    }

    /// Origin веб-клиента, например `https://stoat.chat`.
    pub fn origin(&self) -> String {
        self.app_url.origin().ascii_serialization()
    }

    /// Шаблон адресов для прав доступа к нативным командам.
    pub fn capability_pattern(&self) -> String {
        format!("{}/*", self.origin())
    }

    /// Принадлежит ли адрес веб-клиенту (тот же origin).
    pub fn owns(&self, url: &Url) -> bool {
        url.origin() == self.app_url.origin()
    }
}

/// Проверить адрес веб-клиента: только https, http — лишь для своего
/// компьютера (разработка инстанса).
fn parse_app_url(raw: &str) -> Result<Url, &'static str> {
    let url = Url::parse(raw.trim()).map_err(|_| "это не адрес")?;
    match url.scheme() {
        "https" => {}
        "http" if is_loopback(&url) => {}
        "http" => return Err("нужен https: по http только localhost"),
        _ => return Err("нужен адрес https://"),
    }
    if url.host().is_none() {
        return Err("в адресе нет сервера");
    }
    Ok(url)
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(domain)) => domain == "localhost" || domain.ends_with(".localhost"),
        Some(Host::Ipv4(ip)) => IpAddr::V4(ip).is_loopback(),
        Some(Host::Ipv6(ip)) => IpAddr::V6(ip).is_loopback(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_client_by_default() {
        let instance = Instance::parse("");
        assert_eq!(instance.app_url.as_str(), DEFAULT_APP_URL);
        assert_eq!(instance.origin(), "https://stoat.chat");
        assert_eq!(instance.capability_pattern(), "https://stoat.chat/*");
    }

    #[test]
    fn old_config_without_app_url_still_works() {
        // config.toml от прежних версий бутстрапа
        let text = "\u{feff}[instance]\napi_url = \"https://api.stoat.chat\"\n\n[plugins]\nenabled = true\n";
        assert_eq!(Instance::parse(text), Instance::default());
    }

    #[test]
    fn own_instance_is_taken_from_config() {
        let instance = Instance::parse("[instance]\napp_url = \"https://chat.example.com/\"\n");
        assert_eq!(instance.origin(), "https://chat.example.com");
        assert!(instance.owns(&Url::parse("https://chat.example.com/channel/1").unwrap()));
        assert!(!instance.owns(&Url::parse("https://stoat.chat/app").unwrap()));
    }

    #[test]
    fn insecure_or_broken_address_is_rejected() {
        for raw in [
            "http://chat.example.com",
            "file:///C:/client/index.html",
            "javascript:alert(1)",
            "не адрес",
        ] {
            let text = format!("[instance]\napp_url = \"{raw}\"\n");
            assert_eq!(Instance::parse(&text), Instance::default(), "{raw}");
        }
        let local = Instance::parse("[instance]\napp_url = \"http://localhost:5173\"\n");
        assert_eq!(local.origin(), "http://localhost:5173");
    }

    #[test]
    fn navigation_stays_on_client_origin() {
        let instance = Instance::default();
        assert!(instance.owns(&Url::parse("https://stoat.chat/app/friends").unwrap()));
        assert!(instance.owns(&Url::parse("https://stoat.chat/login").unwrap()));
        assert!(!instance.owns(&Url::parse("https://evil.example/stoat.chat").unwrap()));
        assert!(!instance.owns(&Url::parse("http://stoat.chat/app").unwrap()));
        assert!(!instance.owns(&Url::parse("https://api.stoat.chat/").unwrap()));
    }
}

//! Подтверждение опасных действий (MFA) и действия, которые его требуют.
//!
//! В Stoat смена почты, завершение сессий, коды восстановления, приложение
//! для аутентификации, отключение и удаление аккаунта принимают только
//! «тикет»: его выдаёт `PUT /auth/mfa/ticket` в обмен на пароль, код из
//! приложения или код восстановления, а затем тикет передаётся заголовком
//! `X-MFA-Ticket` ровно в одном запросе.

use reqwest::Method;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::HttpClient;
use super::endpoints::segment;
use crate::error::{Error, Result};

/// Заголовок с тикетом подтверждения.
const HEADER_MFA_TICKET: &str = "x-mfa-ticket";

/// Состояние MFA аккаунта (`GET /auth/mfa/`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MfaStatus {
    /// Включено приложение для одноразовых паролей
    #[serde(default)]
    pub totp_mfa: bool,
    /// Созданы коды восстановления
    #[serde(default)]
    pub recovery_active: bool,
}

impl MfaStatus {
    /// Способы подтверждения, как их перечисляет браузерный клиент
    /// (`MFA.availableMethods` в stoat.js): с приложением — код из него и
    /// коды восстановления, без него — пароль.
    pub fn methods(&self) -> Vec<MfaMethod> {
        match (self.totp_mfa, self.recovery_active) {
            (true, true) => vec![MfaMethod::Totp, MfaMethod::Recovery],
            (true, false) => vec![MfaMethod::Totp],
            (false, _) => vec![MfaMethod::Password],
        }
    }

    /// Двухфакторная защита включена: тогда смена почты и удаление
    /// аккаунта без тикета невозможны.
    pub fn is_active(&self) -> bool {
        self.totp_mfa
    }
}

/// Способ подтверждения действия.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MfaMethod {
    /// Пароль аккаунта
    Password,
    /// Код из приложения для аутентификации
    Totp,
    /// Код восстановления
    Recovery,
}

/// Ответ пользователя на запрос подтверждения (`MFAResponse` в API).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MfaResponse {
    /// Пароль аккаунта
    Password {
        /// Пароль
        password: String,
    },
    /// Код восстановления
    Recovery {
        /// Код
        recovery_code: String,
    },
    /// Одноразовый код из приложения
    Totp {
        /// Код
        totp_code: String,
    },
}

impl MfaResponse {
    /// Ответ без значения не отправляем: сервер всё равно его отклонит.
    pub fn is_empty(&self) -> bool {
        match self {
            Self::Password { password } => password.is_empty(),
            Self::Recovery { recovery_code } => recovery_code.trim().is_empty(),
            Self::Totp { totp_code } => totp_code.trim().is_empty(),
        }
    }
}

/// Тикет подтверждения (`MFATicket` в API).
#[derive(Debug, Clone, Deserialize)]
pub struct MfaTicket {
    /// Id тикета
    #[serde(rename = "_id")]
    pub id: String,
    /// Значение для заголовка `X-MFA-Ticket`
    pub token: String,
}

/// Ответ `POST /auth/mfa/totp`.
#[derive(Debug, Deserialize)]
struct TotpSecret {
    secret: String,
}

/// Заголовки с тикетом; без тикета — пустые.
fn ticket_headers(ticket: Option<&MfaTicket>) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    if let Some(ticket) = ticket {
        let value = HeaderValue::from_str(&ticket.token)
            .map_err(|_| Error::MfaTicket("в тикете недопустимые символы".to_string()))?;
        headers.insert(HeaderName::from_static(HEADER_MFA_TICKET), value);
    }
    Ok(headers)
}

impl HttpClient {
    /// Запрос с тикетом и JSON-ответом.
    async fn ticketed<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        ticket: Option<&MfaTicket>,
    ) -> Result<T> {
        let url = self.endpoint(path)?;
        let headers = ticket_headers(ticket)?;
        let response = self
            .send_with(method, url, body, None, None, headers)
            .await?;
        if !response.status().is_success() {
            return Err(Self::parse_error(response).await);
        }
        let bytes = response.bytes().await?;
        serde_json::from_slice(&bytes).map_err(Error::from)
    }

    /// Запрос с тикетом, ответ которого не нужен.
    async fn ticketed_empty(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        ticket: Option<&MfaTicket>,
    ) -> Result<()> {
        let url = self.endpoint(path)?;
        let headers = ticket_headers(ticket)?;
        let response = self
            .send_with(method, url, body, None, None, headers)
            .await?;
        if !response.status().is_success() {
            return Err(Self::parse_error(response).await);
        }
        Ok(())
    }

    // ─────────────────────────────── MFA ────────────────────────────────

    /// `GET /auth/mfa/` — включены ли приложение и коды восстановления.
    pub async fn fetch_mfa_status(&self) -> Result<MfaStatus> {
        self.get_json("/auth/mfa/").await
    }

    /// `PUT /auth/mfa/ticket` — обменять пароль или код на тикет.
    pub async fn create_mfa_ticket(&self, response: &MfaResponse) -> Result<MfaTicket> {
        let body = serde_json::to_value(response)?;
        self.send_json(Method::PUT, "/auth/mfa/ticket", &body).await
    }

    /// `POST /auth/mfa/recovery` — действующие коды восстановления.
    pub async fn fetch_recovery_codes(&self, ticket: &MfaTicket) -> Result<Vec<String>> {
        self.ticketed(Method::POST, "/auth/mfa/recovery", None, Some(ticket))
            .await
    }

    /// `PATCH /auth/mfa/recovery` — выпустить новые коды восстановления.
    pub async fn generate_recovery_codes(&self, ticket: &MfaTicket) -> Result<Vec<String>> {
        self.ticketed(Method::PATCH, "/auth/mfa/recovery", None, Some(ticket))
            .await
    }

    /// `POST /auth/mfa/totp` — новый секрет для приложения (ещё не включён).
    pub async fn generate_totp_secret(&self, ticket: &MfaTicket) -> Result<String> {
        let secret: TotpSecret = self
            .ticketed(Method::POST, "/auth/mfa/totp", None, Some(ticket))
            .await?;
        Ok(secret.secret)
    }

    /// `PUT /auth/mfa/totp` — включить приложение, подтвердив первый код.
    pub async fn enable_totp(&self, code: &str) -> Result<()> {
        let body = json!({ "totp_code": code });
        self.send_empty(Method::PUT, "/auth/mfa/totp", Some(&body))
            .await
    }

    /// `DELETE /auth/mfa/totp` — отключить приложение.
    pub async fn disable_totp(&self, ticket: &MfaTicket) -> Result<()> {
        self.ticketed_empty(Method::DELETE, "/auth/mfa/totp", None, Some(ticket))
            .await
    }

    // ───────────────────────────── аккаунт ──────────────────────────────

    /// `PATCH /auth/account/change/email` — на новую почту придёт письмо.
    ///
    /// При включённой двухфакторной защите сервер требует ещё и тикет.
    pub async fn change_email(
        &self,
        email: &str,
        current_password: &str,
        ticket: Option<&MfaTicket>,
    ) -> Result<()> {
        let body = json!({ "email": email, "current_password": current_password });
        self.ticketed_empty(
            Method::PATCH,
            "/auth/account/change/email",
            Some(&body),
            ticket,
        )
        .await
    }

    /// `POST /auth/account/disable` — отключить аккаунт (вернуть — через поддержку).
    pub async fn disable_account(&self, ticket: &MfaTicket) -> Result<()> {
        self.ticketed_empty(Method::POST, "/auth/account/disable", None, Some(ticket))
            .await
    }

    /// `POST /auth/account/delete` — поставить аккаунт в очередь на удаление.
    pub async fn delete_account(&self, ticket: &MfaTicket) -> Result<()> {
        self.ticketed_empty(Method::POST, "/auth/account/delete", None, Some(ticket))
            .await
    }

    // ───────────────────────────── сессии ───────────────────────────────

    /// `DELETE /auth/session/{id}` — завершить одну сессию.
    pub async fn revoke_session(&self, session_id: &str, ticket: &MfaTicket) -> Result<()> {
        self.ticketed_empty(
            Method::DELETE,
            &format!("/auth/session/{}", segment(session_id)),
            None,
            Some(ticket),
        )
        .await
    }

    /// `DELETE /auth/session/all` — завершить все сессии, кроме текущей.
    pub async fn revoke_other_sessions(&self, ticket: &MfaTicket) -> Result<()> {
        self.ticketed_empty(
            Method::DELETE,
            "/auth/session/all?revoke_self=false",
            None,
            Some(ticket),
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn methods_follow_browser_client() {
        let none = MfaStatus::default();
        assert_eq!(none.methods(), vec![MfaMethod::Password]);
        assert!(!none.is_active());

        let totp = MfaStatus {
            totp_mfa: true,
            recovery_active: false,
        };
        assert_eq!(totp.methods(), vec![MfaMethod::Totp]);

        let both = MfaStatus {
            totp_mfa: true,
            recovery_active: true,
        };
        assert_eq!(both.methods(), vec![MfaMethod::Totp, MfaMethod::Recovery]);
        assert!(both.is_active());
    }

    #[test]
    fn response_is_untagged() {
        let parsed: MfaResponse = serde_json::from_str(r#"{"totp_code":"123456"}"#).unwrap();
        assert_eq!(
            parsed,
            MfaResponse::Totp {
                totp_code: "123456".into()
            }
        );
        let body = serde_json::to_value(MfaResponse::Password {
            password: "x".into(),
        })
        .unwrap();
        assert_eq!(body, json!({ "password": "x" }));
        assert!(
            MfaResponse::Recovery {
                recovery_code: "  ".into()
            }
            .is_empty()
        );
    }

    #[test]
    fn status_ignores_unknown_fields() {
        let status: MfaStatus =
            serde_json::from_str(r#"{"totp_mfa":true,"email_otp":false}"#).unwrap();
        assert!(status.totp_mfa);
        assert!(!status.recovery_active);
    }

    #[test]
    fn ticket_goes_to_header() {
        let ticket = MfaTicket {
            id: "01T".into(),
            token: "abc".into(),
        };
        let headers = ticket_headers(Some(&ticket)).unwrap();
        assert_eq!(headers.get(HEADER_MFA_TICKET).unwrap(), "abc");
        assert!(ticket_headers(None).unwrap().is_empty());
    }
}

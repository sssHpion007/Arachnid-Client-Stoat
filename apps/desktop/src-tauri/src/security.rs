//! Безопасность аккаунта: подтверждение действий (MFA), коды
//! восстановления, приложение для аутентификации, сессии, отключение и
//! удаление аккаунта.
//!
//! Повторяет `MultiFactorAuth`, `ManageAccount` и `Sessions` браузерного
//! клиента. Там окно `mfaFlow` выдаёт тикет, и вызывающий код сразу тратит
//! его на одно действие. Здесь UI присылает ответ пользователя (пароль или
//! код) вместе с командой, а ядро само получает тикет и тут же использует:
//! тикет не покидает Rust и не живёт дольше одного запроса.

use std::sync::Arc;

use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use qrcode::render::svg;
use qrcode::{EcLevel, QrCode};
use serde::{Deserialize, Serialize};
use stoat_core::http::{HttpClient, MfaMethod, MfaResponse, MfaTicket};
use tauri::State;

use crate::{AppState, CmdResult, CommandError, http_client};

/// Ответ пользователя в окне «Подтвердить действие».
#[derive(Debug, Clone, Deserialize)]
pub struct MfaAnswer {
    /// `Password`, `Totp` или `Recovery`
    pub method: MfaMethod,
    /// Пароль или код
    pub value: String,
}

impl MfaAnswer {
    /// Ответ в формате API; коды приходят с пробелами — их убираем.
    fn into_response(self) -> CmdResult<MfaResponse> {
        let response = match self.method {
            MfaMethod::Password => MfaResponse::Password {
                password: self.value,
            },
            MfaMethod::Totp => MfaResponse::Totp {
                totp_code: compact(&self.value),
            },
            MfaMethod::Recovery => MfaResponse::Recovery {
                recovery_code: compact(&self.value),
            },
        };
        if response.is_empty() {
            return Err(CommandError::new("invalid", "введите пароль или код"));
        }
        Ok(response)
    }
}

/// Код без пробелов (`123 456` → `123456`).
fn compact(code: &str) -> String {
    code.chars().filter(|c| !c.is_whitespace()).collect()
}

/// Получить тикет в обмен на ответ пользователя.
pub(crate) async fn ticket(http: &HttpClient, answer: MfaAnswer) -> CmdResult<MfaTicket> {
    let response = answer.into_response()?;
    Ok(http.create_mfa_ticket(&response).await?)
}

/// Состояние MFA для раздела «Мой аккаунт».
#[derive(Debug, Serialize)]
pub struct MfaView {
    /// Включено приложение для аутентификации
    pub totp: bool,
    /// Созданы коды восстановления
    pub recovery: bool,
    /// Способы подтверждения действий, по порядку
    pub methods: Vec<MfaMethod>,
}

/// Включены ли приложение и коды восстановления.
#[tauri::command]
pub async fn mfa_status(state: State<'_, Arc<AppState>>) -> CmdResult<MfaView> {
    let http = http_client(&state).await?;
    let status = http.fetch_mfa_status().await?;
    Ok(MfaView {
        totp: status.totp_mfa,
        recovery: status.recovery_active,
        methods: status.methods(),
    })
}

/// Действующие коды восстановления.
#[tauri::command]
pub async fn mfa_recovery_codes(
    mfa: MfaAnswer,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<Vec<String>> {
    let http = http_client(&state).await?;
    let ticket = ticket(&http, mfa).await?;
    Ok(http.fetch_recovery_codes(&ticket).await?)
}

/// Новый набор кодов восстановления (старые перестают действовать).
#[tauri::command]
pub async fn mfa_generate_recovery_codes(
    mfa: MfaAnswer,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<Vec<String>> {
    let http = http_client(&state).await?;
    let ticket = ticket(&http, mfa).await?;
    Ok(http.generate_recovery_codes(&ticket).await?)
}

/// Секрет для приложения и QR-код с ним.
#[derive(Debug, Serialize)]
pub struct TotpSetup {
    /// Секрет в base32 — для ручного ввода
    pub secret: String,
    /// QR-код `otpauth://` в виде SVG
    pub qr_svg: String,
}

/// Начать подключение приложения: секрет и QR-код.
///
/// Приложение включится только после [`mfa_enable_totp`] с первым кодом.
#[tauri::command]
pub async fn mfa_totp_secret(
    mfa: MfaAnswer,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<TotpSetup> {
    let http = http_client(&state).await?;
    let ticket = ticket(&http, mfa).await?;
    let secret = http.generate_totp_secret(&ticket).await?;
    let username = match state.cache.me_id().await {
        Some(id) => state.cache.user(&id).await.map(|user| user.username),
        None => None,
    };
    let username = match username {
        Some(name) => name,
        None => http.fetch_self().await?.username,
    };
    let qr_svg = qr_svg(&totp_uri(&username, &secret))?;
    Ok(TotpSetup { secret, qr_svg })
}

/// Адрес для приложения — как в `MFAEnableTOTP.tsx`.
fn totp_uri(username: &str, secret: &str) -> String {
    format!(
        "otpauth://totp/Stoat:{}?secret={secret}&issuer=Stoat",
        utf8_percent_encode(username, NON_ALPHANUMERIC)
    )
}

/// QR-код уровня M, чёрный на белом (белую подложку рисует UI).
fn qr_svg(data: &str) -> CmdResult<String> {
    let code = QrCode::with_error_correction_level(data.as_bytes(), EcLevel::M)
        .map_err(|error| CommandError::new("internal", format!("QR-код: {error}")))?;
    Ok(code
        .render()
        .min_dimensions(140, 140)
        .quiet_zone(false)
        .dark_color(svg::Color("#000000"))
        .light_color(svg::Color("#ffffff"))
        .build())
}

/// Включить приложение, подтвердив код из него.
#[tauri::command]
pub async fn mfa_enable_totp(code: String, state: State<'_, Arc<AppState>>) -> CmdResult<()> {
    let code = compact(&code);
    if code.is_empty() {
        return Err(CommandError::new("invalid", "введите код из приложения"));
    }
    let http = http_client(&state).await?;
    http.enable_totp(&code).await?;
    Ok(())
}

/// Отключить приложение для аутентификации.
#[tauri::command]
pub async fn mfa_disable_totp(mfa: MfaAnswer, state: State<'_, Arc<AppState>>) -> CmdResult<()> {
    let http = http_client(&state).await?;
    let ticket = ticket(&http, mfa).await?;
    http.disable_totp(&ticket).await?;
    Ok(())
}

/// Отключить аккаунт. После этого UI выходит из аккаунта.
#[tauri::command]
pub async fn disable_account(mfa: MfaAnswer, state: State<'_, Arc<AppState>>) -> CmdResult<()> {
    let http = http_client(&state).await?;
    let ticket = ticket(&http, mfa).await?;
    http.disable_account(&ticket).await?;
    Ok(())
}

/// Поставить аккаунт в очередь на удаление (пока есть свои серверы — нельзя).
#[tauri::command]
pub async fn delete_account(mfa: MfaAnswer, state: State<'_, Arc<AppState>>) -> CmdResult<()> {
    if state.cache.owned_servers().await > 0 {
        return Err(CommandError::new(
            "invalid",
            "сначала удалите свои серверы или передайте их другим",
        ));
    }
    let http = http_client(&state).await?;
    let ticket = ticket(&http, mfa).await?;
    http.delete_account(&ticket).await?;
    Ok(())
}

/// Новая почта: Stoat пришлёт письмо для подтверждения.
///
/// `mfa` нужен, только когда включено приложение для аутентификации.
#[tauri::command]
pub async fn change_email(
    email: String,
    current_password: String,
    mfa: Option<MfaAnswer>,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<()> {
    let email = email.trim();
    if !email.contains('@') {
        return Err(CommandError::new("invalid", "это не похоже на адрес почты"));
    }
    let http = http_client(&state).await?;
    let ticket = match mfa {
        Some(answer) => Some(ticket(&http, answer).await?),
        None => None,
    };
    http.change_email(email, &current_password, ticket.as_ref())
        .await?;
    Ok(())
}

/// Завершить одну сессию.
#[tauri::command]
pub async fn revoke_session(
    session_id: String,
    mfa: MfaAnswer,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<()> {
    let http = http_client(&state).await?;
    let ticket = ticket(&http, mfa).await?;
    http.revoke_session(&session_id, &ticket).await?;
    Ok(())
}

/// Завершить все сессии, кроме текущей.
#[tauri::command]
pub async fn revoke_other_sessions(
    mfa: MfaAnswer,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<()> {
    let http = http_client(&state).await?;
    let ticket = ticket(&http, mfa).await?;
    http.revoke_other_sessions(&ticket).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_lose_spaces() {
        let answer = MfaAnswer {
            method: MfaMethod::Totp,
            value: " 123 456 ".into(),
        };
        assert_eq!(
            answer.into_response().unwrap(),
            MfaResponse::Totp {
                totp_code: "123456".into()
            }
        );
        let empty = MfaAnswer {
            method: MfaMethod::Recovery,
            value: "   ".into(),
        };
        assert!(empty.into_response().is_err());
        // пароль не трогаем: пробелы в нём значимы
        let password = MfaAnswer {
            method: MfaMethod::Password,
            value: " a b ".into(),
        };
        assert_eq!(
            password.into_response().unwrap(),
            MfaResponse::Password {
                password: " a b ".into()
            }
        );
    }

    #[test]
    fn uri_matches_browser_client() {
        assert_eq!(
            totp_uri("insert", "ABC"),
            "otpauth://totp/Stoat:insert?secret=ABC&issuer=Stoat"
        );
        assert!(totp_uri("a b", "X").contains("Stoat:a%20b?"));
    }

    #[test]
    fn qr_is_svg() {
        let svg = qr_svg("otpauth://totp/Stoat:x?secret=ABC&issuer=Stoat").unwrap();
        assert!(svg.contains("<svg"));
        assert!(svg.contains("#000000"));
    }
}

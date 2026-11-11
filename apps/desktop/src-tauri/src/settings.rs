//! Настройки пользователя: аккаунт, профиль, сессии и загрузка файлов.
//!
//! Повторяет разделы «Мой аккаунт», «Профиль» и «Сессии» браузерного
//! клиента (`settings/user/*`).

use std::sync::Arc;

use base64::Engine;
use serde::Serialize;
use serde_json::{Map, Value, json};
use stoat_core::http::UploadTag;
use tauri::State;

use crate::profile::store_me;
use crate::views::{self, UserView};
use crate::{AppState, CmdResult, CommandError, http_client};

/// Самый большой файл, который отправляем в Autumn (лимит вложений Stoat — 20 МБ).
const UPLOAD_LIMIT: usize = 20 * 1024 * 1024;

/// Поля профиля, которые можно очистить (`FieldsUser` в API).
const REMOVABLE: [&str; 6] = [
    "Avatar",
    "ProfileBackground",
    "ProfileContent",
    "DisplayName",
    "Pronouns",
    "StatusText",
];

/// Раздел «Мой аккаунт».
#[derive(Debug, Serialize)]
pub struct AccountView {
    /// Почта
    pub email: String,
    /// Имя пользователя
    pub username: String,
    /// Дискриминатор
    pub discriminator: String,
}

/// Сессия в разделе «Сессии».
#[derive(Debug, Serialize)]
pub struct SessionView {
    /// Id сессии
    pub id: String,
    /// Имя, которое клиент дал сессии
    pub name: String,
    /// Эта сессия — наша
    pub current: bool,
    /// Когда создана (ISO-8601, из ULID)
    pub created_at: Option<String>,
}

/// Почта и имя аккаунта.
#[tauri::command]
pub async fn account_info(state: State<'_, Arc<AppState>>) -> CmdResult<AccountView> {
    let http = http_client(&state).await?;
    let account = http.fetch_account().await?;
    let me = match state.cache.me_id().await {
        Some(id) => state.cache.user(&id).await,
        None => None,
    };
    let me = match me {
        Some(user) => user,
        None => http.fetch_self().await?,
    };
    Ok(AccountView {
        email: account.email,
        username: me.username,
        discriminator: me.discriminator,
    })
}

/// Новое имя пользователя (нужен текущий пароль).
#[tauri::command]
pub async fn change_username(
    username: String,
    password: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<UserView> {
    let username = username.trim();
    if username.is_empty() {
        return Err(CommandError::new("invalid", "укажите имя пользователя"));
    }
    let http = http_client(&state).await?;
    let user = http.change_username(username, &password).await?;
    Ok(store_me(&state, user).await)
}

/// Новый пароль.
#[tauri::command]
pub async fn change_password(
    password: String,
    current_password: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<()> {
    if password.is_empty() {
        return Err(CommandError::new("invalid", "укажите новый пароль"));
    }
    let http = http_client(&state).await?;
    http.change_password(&password, &current_password).await?;
    Ok(())
}

/// Новая почта: Stoat пришлёт письмо для подтверждения.
#[tauri::command]
pub async fn change_email(
    email: String,
    current_password: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<()> {
    let email = email.trim();
    if !email.contains('@') {
        return Err(CommandError::new("invalid", "это не похоже на адрес почты"));
    }
    let http = http_client(&state).await?;
    http.change_email(email, &current_password).await?;
    Ok(())
}

/// Все сессии аккаунта; текущая — первой, остальные от новых к старым.
#[tauri::command]
pub async fn sessions(state: State<'_, Arc<AppState>>) -> CmdResult<Vec<SessionView>> {
    let http = http_client(&state).await?;
    let current = state.session_id.read().await.clone();
    let mut list: Vec<SessionView> = http
        .fetch_sessions()
        .await?
        .into_iter()
        .map(|session| SessionView {
            current: current.as_deref() == Some(session.id.as_str()),
            created_at: views::ulid_time_ms(&session.id).map(views::iso_from_ms),
            id: session.id,
            name: session.name,
        })
        .collect();
    list.sort_by(|a, b| b.current.cmp(&a.current).then_with(|| b.id.cmp(&a.id)));
    Ok(list)
}

/// Завершить одну сессию.
#[tauri::command]
pub async fn revoke_session(session_id: String, state: State<'_, Arc<AppState>>) -> CmdResult<()> {
    let http = http_client(&state).await?;
    http.revoke_session(&session_id).await?;
    Ok(())
}

/// Завершить все сессии, кроме текущей.
#[tauri::command]
pub async fn revoke_other_sessions(state: State<'_, Arc<AppState>>) -> CmdResult<()> {
    let http = http_client(&state).await?;
    http.revoke_other_sessions().await?;
    Ok(())
}

/// Изменить профиль: имя, местоимения, «обо мне», аватар и фон.
///
/// `avatar` и `background` — id файлов, уже загруженных через
/// [`upload_file`]; `remove` — поля, которые нужно очистить.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn edit_profile(
    display_name: Option<String>,
    pronouns: Option<String>,
    bio: Option<String>,
    avatar: Option<String>,
    background: Option<String>,
    remove: Option<Vec<String>>,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<UserView> {
    let body = profile_patch(display_name, pronouns, bio, avatar, background, remove)?;
    let http = http_client(&state).await?;
    let user = http.edit_self(&body).await?;
    Ok(store_me(&state, user).await)
}

/// Тело `PATCH /users/@me` из полей формы профиля.
fn profile_patch(
    display_name: Option<String>,
    pronouns: Option<String>,
    bio: Option<String>,
    avatar: Option<String>,
    background: Option<String>,
    remove: Option<Vec<String>>,
) -> CmdResult<Value> {
    let mut body = Map::new();
    let mut remove = remove.unwrap_or_default();
    for field in &remove {
        if !REMOVABLE.contains(&field.as_str()) {
            return Err(CommandError::new(
                "invalid",
                format!("это поле нельзя очистить: {field}"),
            ));
        }
    }

    // пустая строка значит «очистить»: сервер не принимает пустые значения
    let mut text = |value: Option<String>, key: &str, field: &str| match value {
        Some(value) if value.trim().is_empty() => remove.push(field.to_string()),
        Some(value) => {
            body.insert(key.to_string(), Value::String(value.trim().to_string()));
        }
        None => {}
    };
    text(display_name, "display_name", "DisplayName");
    text(pronouns, "pronouns", "Pronouns");

    let mut profile = Map::new();
    match bio {
        Some(bio) if bio.trim().is_empty() => remove.push("ProfileContent".to_string()),
        Some(bio) => {
            profile.insert("content".to_string(), Value::String(bio));
        }
        None => {}
    }
    if let Some(background) = background {
        profile.insert("background".to_string(), Value::String(background));
    }
    if !profile.is_empty() {
        body.insert("profile".to_string(), Value::Object(profile));
    }
    if let Some(avatar) = avatar {
        body.insert("avatar".to_string(), Value::String(avatar));
    }

    remove.sort();
    remove.dedup();
    if !remove.is_empty() {
        body.insert("remove".to_string(), json!(remove));
    }
    Ok(Value::Object(body))
}

/// Загрузить файл в Autumn и вернуть его id.
///
/// Файл приходит из `<input type=file>` в base64: так его проще и надёжнее
/// передать через мост, чем массивом чисел.
#[tauri::command]
pub async fn upload_file(
    tag: String,
    filename: String,
    content_type: Option<String>,
    data: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<String> {
    let tag = UploadTag::parse(&tag)
        .ok_or_else(|| CommandError::new("invalid", format!("неизвестный тип файла: {tag}")))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|_| CommandError::new("invalid", "файл повреждён при передаче"))?;
    if bytes.is_empty() {
        return Err(CommandError::new("invalid", "файл пустой"));
    }
    if bytes.len() > UPLOAD_LIMIT {
        return Err(CommandError::new("too_large", "файл больше 20 МБ"));
    }

    let mut autumn = state.cdn_url.read().await.clone();
    if autumn.is_none() {
        autumn = crate::fetch_cdn_url(&state).await;
    }
    let autumn = autumn
        .ok_or_else(|| CommandError::new("unsupported", "сервер не сообщил адрес для файлов"))?;

    let http = http_client(&state).await?;
    let id = http
        .upload(&autumn, tag, &filename, content_type.as_deref(), bytes)
        .await?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_fields_become_removals() {
        let body = profile_patch(
            Some("  ".into()),
            Some("он/его".into()),
            Some(String::new()),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(body["pronouns"], "он/его");
        assert!(body.get("display_name").is_none());
        assert_eq!(body["remove"], json!(["DisplayName", "ProfileContent"]));
    }

    #[test]
    fn files_and_bio_are_sent() {
        let body = profile_patch(
            None,
            None,
            Some("**привет**".into()),
            Some("a1".into()),
            Some("b1".into()),
            Some(vec!["StatusText".into()]),
        )
        .unwrap();
        assert_eq!(body["avatar"], "a1");
        assert_eq!(body["profile"]["content"], "**привет**");
        assert_eq!(body["profile"]["background"], "b1");
        assert_eq!(body["remove"], json!(["StatusText"]));
    }

    #[test]
    fn unknown_removal_is_rejected() {
        assert!(profile_patch(None, None, None, None, None, Some(vec!["Badges".into()])).is_err());
    }
}

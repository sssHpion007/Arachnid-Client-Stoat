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

/// Поля профиля, которые можно очистить (`FieldsUser` в API).
const REMOVABLE: [&str; 6] = [
    "Avatar",
    "ProfileBackground",
    "ProfileContent",
    "DisplayName",
    "Pronouns",
    "StatusText",
];

/// Раздел «Мой аккаунт» (`UserSummary` и `EditAccount`).
#[derive(Debug, Serialize)]
pub struct AccountView {
    /// Имя пользователя
    pub username: String,
    /// Дискриминатор
    pub discriminator: String,
    /// Имя для показа
    pub display_name: String,
    /// Аватар
    pub avatar: Option<String>,
    /// Фон профиля — баннер карточки
    pub background: Option<String>,
    /// Когда создан аккаунт (ISO-8601, из ULID)
    pub created_at: Option<String>,
    /// Сколько серверов принадлежит пользователю: пока они есть,
    /// удалить аккаунт нельзя
    pub owned_servers: usize,
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

/// Карточка аккаунта: имя, аватар, баннер, дата создания.
///
/// Почту браузерный клиент показывает только по «Показать» — её отдаёт
/// [`account_email`].
#[tauri::command]
pub async fn account_info(state: State<'_, Arc<AppState>>) -> CmdResult<AccountView> {
    let http = http_client(&state).await?;
    let me = match state.cache.me_id().await {
        Some(id) => state.cache.user(&id).await,
        None => None,
    };
    let me = match me {
        Some(user) => user,
        None => http.fetch_self().await?,
    };
    let cdn = state.cdn_url.read().await.clone();
    // без фона карточка просто останется цвета темы
    let background = http
        .fetch_profile(&me.id)
        .await
        .ok()
        .and_then(|profile| profile.background)
        .and_then(|file| views::file_url(&file, cdn.as_deref()));
    Ok(AccountView {
        display_name: views::display_name(&me),
        avatar: me
            .avatar
            .as_ref()
            .and_then(|file| views::file_url(file, cdn.as_deref())),
        created_at: views::ulid_time_ms(&me.id).map(views::iso_from_ms),
        owned_servers: state.cache.owned_servers().await,
        background,
        username: me.username,
        discriminator: me.discriminator,
    })
}

/// Почта аккаунта (кнопка «Показать»).
#[tauri::command]
pub async fn account_email(state: State<'_, Arc<AppState>>) -> CmdResult<String> {
    let http = http_client(&state).await?;
    Ok(http.fetch_account().await?.email)
}

/// Версия клиента и ссылки на правила инстанса — подвал списка разделов.
#[derive(Debug, Serialize)]
pub struct AboutView {
    /// Версия Arachnid Client
    pub version: &'static str,
    /// Версия Tauri
    pub tauri: &'static str,
    /// Версия WebView2 / WebKit, если известна
    pub webview: Option<String>,
    /// Условия, конфиденциальность и правила
    pub legal: stoat_core::LegalLinks,
    /// Официальный инстанс stoat.chat (кнопка Stoat Lounge в «Обратной связи»)
    pub official: bool,
}

/// Что показать под списком разделов.
#[tauri::command]
pub async fn about(state: State<'_, Arc<AppState>>) -> CmdResult<AboutView> {
    let official = is_official(&state.instance.read().await.api_url);
    Ok(AboutView {
        version: env!("CARGO_PKG_VERSION"),
        tauri: tauri::VERSION,
        webview: tauri::webview_version().ok(),
        legal: state.legal.read().await.clone(),
        official,
    })
}

/// Адрес API официального инстанса — как `Instance.isStoat` в браузерном клиенте.
fn is_official(api_url: &tauri::Url) -> bool {
    api_url.host_str() == Some("api.stoat.chat")
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

/// Переименовать сессию.
#[tauri::command]
pub async fn rename_session(
    session_id: String,
    name: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CommandError::new("invalid", "укажите имя сессии"));
    }
    let http = http_client(&state).await?;
    http.rename_session(&session_id, name).await?;
    Ok(())
}

/// Изменить профиль: имя, местоимения, «обо мне», аватар и фон.
///
/// `avatar` и `background` — id файлов, уже загруженных через
/// [`upload_file`]; `remove` — поля, которые нужно очистить.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn edit_profile(
    user_id: Option<String>,
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
    let me = state.cache.me_id().await;
    match user_id.filter(|id| Some(id) != me.as_ref()) {
        // профиль своего бота (`UserProfileEditor` на странице бота)
        Some(bot_id) => {
            let user = http.edit_user(&bot_id, &body).await?;
            state.cache.insert_user(user.clone()).await;
            let cdn = state.cdn_url.read().await.clone();
            Ok(UserView::build(user, cdn.as_deref()))
        }
        None => {
            let user = http.edit_self(&body).await?;
            Ok(store_me(&state, user).await)
        }
    }
}

/// Профиль на сервере (`ServerIdentity.tsx`): ник, аватар и местоимения.
///
/// Пустая строка очищает поле; `avatar` — id файла из [`upload_file`],
/// `remove_avatar` — вернуть обычный аватар.
#[tauri::command]
pub async fn edit_server_identity(
    server_id: String,
    nickname: Option<String>,
    pronouns: Option<String>,
    avatar: Option<String>,
    remove_avatar: Option<bool>,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<()> {
    let body = identity_patch(nickname, pronouns, avatar, remove_avatar.unwrap_or(false));
    let me = state
        .cache
        .me_id()
        .await
        .ok_or_else(|| CommandError::new("unauthorized", "сначала войдите"))?;
    let http = http_client(&state).await?;
    let member = http.edit_member(&server_id, &me, &body).await?;
    state
        .cache
        .insert_members(&server_id, vec![member], Vec::new())
        .await;
    Ok(())
}

/// Тело `PATCH /servers/{id}/members/{user}` для своего профиля на сервере.
fn identity_patch(
    nickname: Option<String>,
    pronouns: Option<String>,
    avatar: Option<String>,
    remove_avatar: bool,
) -> Value {
    let mut body = Map::new();
    let mut remove = Vec::new();
    for (value, key, field) in [
        (nickname, "nickname", "Nickname"),
        (pronouns, "pronouns", "Pronouns"),
    ] {
        match value {
            Some(value) if value.trim().is_empty() => remove.push(field),
            Some(value) => {
                body.insert(key.to_string(), Value::String(value.trim().to_string()));
            }
            None => {}
        }
    }
    match avatar {
        Some(avatar) => {
            body.insert("avatar".to_string(), Value::String(avatar));
        }
        None if remove_avatar => remove.push("Avatar"),
        None => {}
    }
    if !remove.is_empty() {
        body.insert("remove".to_string(), json!(remove));
    }
    Value::Object(body)
}

/// Последний список изменений Stoat (`Changelog.tsx`).
#[derive(Debug, Serialize)]
pub struct ChangelogView {
    /// Id записи
    pub id: String,
    /// Заголовок
    pub title: String,
    /// Когда опубликован (ISO-8601)
    pub published_at: String,
    /// Текст в виде дерева узлов
    pub content: Vec<crate::markdown::MdNode>,
}

/// Ответ `changelog.stoat.chat` (поля, которые проверяет браузерный клиент).
#[derive(Debug, serde::Deserialize)]
struct ChangelogResponse {
    id: String,
    title: String,
    markdown_content: String,
    published_at: String,
}

/// Адрес последнего списка изменений.
const CHANGELOG_URL: &str = "https://changelog.stoat.chat/v1/changelogs/latest";

/// «Узнай, что нового»: последний список изменений.
#[tauri::command]
pub async fn changelog(
    proxy: State<'_, Arc<crate::media::MediaProxy>>,
) -> CmdResult<ChangelogView> {
    let failed = |error: reqwest::Error| CommandError::new("network", error.to_string());
    let response = proxy
        .client()
        .get(CHANGELOG_URL)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(failed)?
        .error_for_status()
        .map_err(failed)?;
    let data: ChangelogResponse = response.json().await.map_err(failed)?;
    Ok(ChangelogView {
        content: crate::markdown::tree(&data.markdown_content),
        id: data.id,
        title: data.title,
        published_at: data.published_at,
    })
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

    let mut autumn = state.cdn_url.read().await.clone();
    if autumn.is_none() {
        autumn = crate::fetch_cdn_url(&state).await;
    }
    let autumn = autumn
        .ok_or_else(|| CommandError::new("unsupported", "сервер не сообщил адрес для файлов"))?;

    // предел инстанса для этого тега; более строгий предел нового аккаунта
    // проверяет интерфейс, а окончательно — сам Autumn
    let limit = state.upload.read().await.max_size(tag.as_str());
    if bytes.len() as u64 > limit {
        return Err(CommandError::new(
            "too_large",
            format!("файл больше {} МБ", limit as f64 / 1_000_000.0),
        ));
    }

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
    fn official_instance_by_api_host() {
        assert!(is_official(&"https://api.stoat.chat".parse().unwrap()));
        assert!(!is_official(
            &"https://chat.example.org/api".parse().unwrap()
        ));
    }

    #[test]
    fn identity_patch_clears_and_sets() {
        let body = identity_patch(Some(" ".into()), Some("она/её".into()), None, true);
        assert_eq!(body["pronouns"], "она/её");
        assert!(body.get("nickname").is_none());
        assert_eq!(body["remove"], json!(["Nickname", "Avatar"]));

        let body = identity_patch(Some("Ник".into()), None, Some("f1".into()), true);
        assert_eq!(body["nickname"], "Ник");
        assert_eq!(body["avatar"], "f1");
        assert!(body.get("remove").is_none());
    }

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

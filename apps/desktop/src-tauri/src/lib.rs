//! Tauri-слой клиента Stoat.
//!
//! Здесь только то, что связывает интерфейс с ядром [`stoat_core`]:
//! состояние приложения, команды для webview и хранение токена.
//! Никакой бизнес-логики протокола — она в ядре и покрыта тестами.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use stoat_core::cache::Cache;
use stoat_core::gateway::{self, GatewayConfig, GatewayEvent, GatewayHandle};
use stoat_core::http::{HttpClient, Token};
use stoat_core::{ApiRoot, Instance, ReadyField};
use tauri::{Manager, State};

mod views;
use tokio::sync::{Mutex, RwLock};
use views::{ChatMessage, HistoryView, UserView, WorkspaceView};

/// Состояние приложения, доступное командам.
pub struct AppState {
    /// Текущий инстанс (может быть переопределён config.toml)
    pub instance: RwLock<Instance>,
    /// REST-клиент; `None`, пока не создан
    pub http: RwLock<Option<HttpClient>>,
    /// Кэш состояния
    pub cache: Cache,
    /// Активное gateway-соединение
    pub gateway: Mutex<Option<GatewayHandle>>,
    /// Каталог установки (рядом с exe или выбранный бутстрапом)
    pub data_dir: PathBuf,
    /// Базовый URL файлового сервиса (Autumn) для аватаров и вложений
    pub cdn_url: RwLock<Option<String>>,
    /// Что уже скачано для показа: адрес → data-URL (`None` — файла нет)
    pub media: RwLock<std::collections::HashMap<String, Option<String>>>,
}

impl AppState {
    fn new(data_dir: PathBuf) -> Self {
        Self {
            instance: RwLock::new(Instance::official()),
            http: RwLock::new(None),
            cache: Cache::new(),
            gateway: Mutex::new(None),
            data_dir,
            cdn_url: RwLock::new(None),
            media: RwLock::new(std::collections::HashMap::new()),
        }
    }
}

/// Ответ на команду со сводкой по инстансу.
#[derive(Debug, Serialize)]
pub struct InstanceInfo {
    /// Имя инстанса
    pub name: String,
    /// Адрес API
    pub api_url: String,
    /// Адрес gateway
    pub ws_url: String,
    /// Версия Stoat, если инстанс её сообщил
    pub version: Option<String>,
    /// Включён ли голос
    pub voice: bool,
    /// Адрес файлового сервиса (Autumn)
    pub autumn_url: Option<String>,
}

/// Проблема, которую нужно показать пользователю.
#[derive(Debug, Serialize)]
pub struct CommandError {
    /// Тип ошибки для UI
    pub kind: String,
    /// Текст для человека
    pub message: String,
}

impl CommandError {
    fn new(kind: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            message: message.into(),
        }
    }
}

impl From<stoat_core::Error> for CommandError {
    fn from(error: stoat_core::Error) -> Self {
        // код из API (`InvalidCredentials`, `AccountDisabled`, …) важнее
        // общего вида ошибки: по нему форма выбирает текст для человека
        if let Some(api_kind) = error.api_kind() {
            return Self::new(api_kind.to_lowercase(), error.to_string());
        }
        let kind = match &error {
            stoat_core::Error::Unauthorized => "unauthorized",
            stoat_core::Error::RateLimited(_) => "rate_limited",
            stoat_core::Error::Network(_) | stoat_core::Error::ConnectionClosed => "network",
            stoat_core::Error::Api { .. } => "api",
            stoat_core::Error::Gateway(_) => "gateway",
            _ => "internal",
        };
        Self::new(kind, error.to_string())
    }
}

type CmdResult<T> = Result<T, CommandError>;

// ─────────────────────────────── каталог данных ─────────────────────────────

/// Каталог для журналов: рядом с exe (portable) либо `%LOCALAPPDATA%\Tauri-Stoat\logs`.
fn log_directory() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("TAURI_STOAT_DIR") {
        return Some(PathBuf::from(dir).join("logs"));
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(parent) = exe.parent()
        && parent.join("config.toml").exists()
    {
        return Some(parent.join("logs"));
    }
    std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("HOME"))
        .map(|base| PathBuf::from(base).join("Tauri-Stoat").join("logs"))
}

/// Определить каталог данных: портативный режим важнее системного.
///
/// Порядок:
/// 1. переменная `TAURI_STOAT_DIR` (её выставляет запуск из бутстрапа);
/// 2. рядом с исполняемым файлом, если там лежит `config.toml` (portable);
/// 3. системный каталог данных приложения.
fn resolve_data_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(dir) = std::env::var("TAURI_STOAT_DIR") {
        let path = PathBuf::from(dir);
        if ensure_layout(&path).is_ok() {
            return path;
        }
    }

    if let Ok(exe) = std::env::current_exe()
        && let Some(parent) = exe.parent()
        && parent.join("config.toml").exists()
        && ensure_layout(parent).is_ok()
    {
        return parent.to_path_buf();
    }

    let fallback = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = ensure_layout(&fallback);
    fallback
}

/// Создать структуру каталогов, если её нет (первый запуск без бутстрапа).
fn ensure_layout(dir: &Path) -> std::io::Result<()> {
    for sub in ["cache", "plugins", "themes", "logs"] {
        std::fs::create_dir_all(dir.join(sub))?;
    }
    Ok(())
}

// ───────────────────────────────── команды ──────────────────────────────────

/// Сводка по инстансу: используется экраном подключения.
#[tauri::command]
async fn instance_info(state: State<'_, Arc<AppState>>) -> CmdResult<InstanceInfo> {
    let instance = state.instance.read().await.clone();
    let mut client = HttpClient::new(instance.api_url.clone());
    client.set_app_name(instance.app_name.clone());

    match client.get_root().await {
        Ok(root) => Ok(info_from(&instance, &root)),
        // без сети показываем то, что знаем
        Err(error) if !error.is_retryable() => Err(error.into()),
        Err(_) => Ok(info_from(
            &instance,
            &ApiRoot {
                stoat: None,
                revolt: None,
                ws: Some(instance.ws_url.to_string()),
                app: None,
                vapid: None,
                features: serde_json::json!({}),
            },
        )),
    }
}

fn info_from(instance: &Instance, root: &ApiRoot) -> InstanceInfo {
    InstanceInfo {
        name: instance.name.clone(),
        api_url: instance.api_url.to_string(),
        ws_url: instance.ws_url.to_string(),
        version: root.stoat.clone(),
        voice: root.voice_enabled(),
        autumn_url: root.autumn_url().map(str::to_string),
    }
}

/// Сохранить токен и выполнить вход.
///
/// Токен не пишется в конфиг: только в память процесса и, если доступно,
/// в системное хранилище секретов (через плагин store на стороне UI).
#[tauri::command]
async fn login_with_token(
    app: tauri::AppHandle,
    token: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<UserView> {
    let instance = state.instance.read().await.clone();
    let mut client = HttpClient::new(instance.api_url.clone());
    client.set_app_name(instance.app_name.clone());
    client.set_token(Some(Token::Session(token)));

    let me = client.fetch_self().await?;
    state.cache.set_me(me.clone()).await;

    *state.http.write().await = Some(client);
    show_client(&app);
    Ok(UserView::from(me))
}

/// Результат шага входа, который видит форма.
#[derive(Debug, Serialize)]
#[serde(tag = "status")]
pub enum LoginStep {
    /// Вход выполнен
    Success {
        /// Профиль пользователя
        user: UserView,
        /// Токен сессии, чтобы UI мог сохранить его в системное хранилище
        token: String,
    },
    /// Нужен второй фактор
    Mfa {
        /// Тикет, который нужно передать на следующем шаге
        ticket: String,
        /// Разрешённые способы: Password, Totp, Recovery
        methods: Vec<String>,
    },
    /// Аккаунт отключён
    Disabled {
        /// Id пользователя
        user_id: String,
    },
}

/// Вход по почте и паролю.
#[tauri::command]
async fn login_password(
    app: tauri::AppHandle,
    email: String,
    password: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<LoginStep> {
    let instance = state.instance.read().await.clone();
    let mut client = HttpClient::new(instance.api_url.clone());
    client.set_app_name(instance.app_name.clone());

    let response = client
        .login_password(&email, &password, Some(instance.app_name.clone()))
        .await?;

    finish_login(app, response, client, state).await
}

/// Второй шаг входа: пароль, TOTP или код восстановления.
#[tauri::command]
async fn login_mfa(
    app: tauri::AppHandle,
    ticket: String,
    method: String,
    value: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<LoginStep> {
    use revolt_models::v0::MFAResponse;

    let mfa = match method.as_str() {
        "Password" | "password" => MFAResponse::Password { password: value },
        "Totp" | "totp" => MFAResponse::Totp { totp_code: value },
        "Recovery" | "recovery" => MFAResponse::Recovery {
            recovery_code: value,
        },
        other => {
            return Err(CommandError::new(
                "mfa",
                format!("неизвестный способ подтверждения: {other}"),
            ));
        }
    };

    let instance = state.instance.read().await.clone();
    let mut client = HttpClient::new(instance.api_url.clone());
    client.set_app_name(instance.app_name.clone());

    let response = client
        .login_mfa(&ticket, mfa, Some(instance.app_name.clone()))
        .await?;

    finish_login(app, response, client, state).await
}

/// Показать экран приложения после успешного входа.
///
/// Переключение делает Rust, а не `location.replace` из страницы: навигация
/// по встроенным страницам (`tauri://localhost`) из скрипта может быть
/// запрещена политикой безопасности, и форма просто «зависала» бы.
fn show_client(app: &tauri::AppHandle) {
    use tauri::Manager as _;

    // Адрес страницы берём из текущего, чтобы не зависеть от схемы
    // (на Windows это `http://tauri.localhost`, на Linux — `tauri://localhost`).
    let base = match app.get_webview_window("main").and_then(|w| w.url().ok()) {
        Some(url) => url,
        None => {
            eprintln!("окно main не найдено: экран приложения не открыт");
            return;
        }
    };
    let page = match base.join("app.html") {
        Ok(url) => url,
        Err(error) => {
            eprintln!("не удалось собрать адрес app.html: {error}");
            return;
        }
    };

    if let Some(window) = app.get_webview_window("main")
        && let Err(error) = window.navigate(page.clone())
    {
        eprintln!("не удалось открыть {page}: {error}");
    }
}

/// Общая часть входа: разобрать ответ и, если успех, поднять сессию.
async fn finish_login(
    app: tauri::AppHandle,
    response: revolt_models::v0::ResponseLogin,
    mut client: HttpClient,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<LoginStep> {
    use revolt_models::v0::ResponseLogin;

    match response {
        ResponseLogin::Success(session) => {
            client.set_token(Some(Token::Session(session.token.clone())));
            let me = client.fetch_self().await?;
            state.cache.set_me(me.clone()).await;
            *state.http.write().await = Some(client);

            show_client(&app);

            Ok(LoginStep::Success {
                user: UserView::from(me),
                token: session.token,
            })
        }
        ResponseLogin::MFA {
            ticket,
            allowed_methods,
        } => Ok(LoginStep::Mfa {
            ticket,
            methods: allowed_methods
                .into_iter()
                .map(|method| format!("{method:?}"))
                .collect(),
        }),
        ResponseLogin::Disabled { user_id } => Ok(LoginStep::Disabled { user_id }),
    }
}

/// Отключиться: закрыть gateway и удалить сессию на сервере.
#[tauri::command]
async fn logout(state: State<'_, Arc<AppState>>) -> CmdResult<()> {
    if let Some(handle) = state.gateway.lock().await.take() {
        handle.stop();
    }
    if let Some(client) = state.http.write().await.take() {
        let _ = client.logout().await; // ошибку не показываем: локально вышли в любом случае
    }
    state.cache.clear().await;
    Ok(())
}

/// Состояние входа: кто мы и что уже в кэше.
#[tauri::command]
async fn session_state(state: State<'_, Arc<AppState>>) -> CmdResult<SessionView> {
    let logged_in = state.http.read().await.is_some();
    let snapshot = state.cache.snapshot().await;
    Ok(SessionView {
        logged_in,
        me: snapshot.me.map(UserView::from),
        servers: snapshot.servers.len(),
        channels: snapshot.channels.len(),
    })
}

/// Подключить gateway и начать получать события.
#[tauri::command]
async fn connect_gateway(app: tauri::AppHandle, state: State<'_, Arc<AppState>>) -> CmdResult<()> {
    let http = {
        let guard = state.http.read().await;
        guard
            .as_ref()
            .cloned()
            .ok_or_else(|| CommandError::new("unauthorized", "сначала войдите в аккаунт"))?
    };

    let token = match http.token() {
        Some(Token::Session(token)) | Some(Token::Bot(token)) => token.clone(),
        None => return Err(CommandError::new("unauthorized", "нет токена сессии")),
    };

    let instance = state.instance.read().await.clone();
    let url = instance.gateway_url(&[
        ReadyField::Users,
        ReadyField::Servers,
        ReadyField::Channels,
        ReadyField::Members,
        ReadyField::ChannelUnreads,
    ]);

    // закрываем прошлое соединение, если оно было
    if let Some(handle) = state.gateway.lock().await.take() {
        handle.stop();
    }

    let (handle, mut events) = gateway::connect(url, token, GatewayConfig::default()).await?;
    *state.gateway.lock().await = Some(handle);

    let cache = state.cache.clone();
    let emitter = app.clone();
    tokio::spawn(async move {
        while let Some(event) = events.recv().await {
            if let GatewayEvent::Ready(ready) = &event {
                cache.apply_ready((**ready).clone()).await;
            } else {
                cache.apply(event.clone()).await;
            }
            // отдаём событие в webview как есть; UI решает, что перерисовать
            if let Ok(payload) = serde_json::to_string(&event)
                && emitter.emit("stoat:gateway", payload).is_err()
            {
                break;
            }
        }
    });

    Ok(())
}

/// Отправить сообщение в канал.
#[tauri::command]
async fn send_message(
    channel_id: String,
    content: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<ChatMessage> {
    let http = {
        let guard = state.http.read().await;
        guard
            .as_ref()
            .cloned()
            .ok_or_else(|| CommandError::new("unauthorized", "сначала войдите в аккаунт"))?
    };

    let data = revolt_send(&content);
    // ключ идемпотентности: повторная отправка не создаст дубликат
    let key = Some(nonce());
    let message = http.send_message(&channel_id, data, key).await?;
    state.cache.insert_message(message.clone()).await;

    let cdn = state.cdn_url.read().await.clone();
    Ok(ChatMessage::build(
        message,
        &std::collections::HashMap::new(),
        cdn.as_deref(),
    ))
}

/// Полный снимок состояния для отрисовки интерфейса.
///
/// UI не разбирает модели Stoat напрямую: здесь уже готовые к показу
/// серверы с категориями, каналы, личные сообщения и участники.
#[tauri::command]
async fn workspace(state: State<'_, Arc<AppState>>) -> CmdResult<WorkspaceView> {
    let snapshot = state.cache.snapshot().await;

    let mut cdn = state.cdn_url.read().await.clone();
    if cdn.is_none() {
        cdn = fetch_cdn_url(&state).await;
    }

    // порядок серверов и каналов задан пользователем в браузерной версии:
    // без него рельс выглядел бы случайным
    let ordering = fetch_ordering(&state).await;
    Ok(WorkspaceView::build_ordered(snapshot, cdn, &ordering))
}

/// Прочитать порядок серверов и категорий из настроек синхронизации.
///
/// Ошибка здесь не критична: без настроек интерфейс покажет порядок
/// по умолчанию, поэтому запрос не роняет команду.
async fn fetch_ordering(state: &State<'_, Arc<AppState>>) -> views::Ordering {
    let http = {
        let guard = state.http.read().await;
        match guard.as_ref() {
            Some(client) => client.clone(),
            None => return views::Ordering::default(),
        }
    };

    match http.fetch_settings(&["ordering"]).await {
        Ok(settings) => {
            let raw = settings
                .into_iter()
                .find(|(key, _)| key == "ordering")
                .and_then(|(_, value)| value);
            views::Ordering::parse(raw.as_deref())
        }
        Err(error) => {
            tracing::warn!(%error, "не удалось прочитать порядок серверов");
            views::Ordering::default()
        }
    }
}

/// Скачать картинку и отдать её интерфейсу как data-URL.
///
/// WebView2 блокирует сторонние изображения на встроенных страницах
/// (`tauri://`), а политика безопасности запрещает внешние загрузки.
/// Поэтому файл скачивает Rust и отдаёт уже готовые байты.
#[tauri::command]
async fn fetch_media(url: String, state: State<'_, Arc<AppState>>) -> CmdResult<String> {
    if !url.starts_with("https://") {
        return Err(CommandError::new(
            "bad_url",
            "адрес должен начинаться с https://",
        ));
    }

    // повторный показ аватара не должен снова ходить в сеть
    if let Some(cached) = state.media.read().await.get(&url) {
        return match cached {
            Some(data) => Ok(data.clone()),
            None => Err(CommandError::new("not_found", "файл недоступен")),
        };
    }

    let result = download_data_url(&url).await;
    // запоминаем и неудачу, чтобы не дёргать сеть на каждую отрисовку
    let stored = result.as_ref().ok().cloned();
    state.media.write().await.insert(url, stored);

    result.map_err(|message| CommandError::new("media", message))
}

/// Скачать файл и превратить его в data-URL.
async fn download_data_url(url: &str) -> std::result::Result<String, String> {
    // некоторые файлы CDN отдаёт только с заголовком Accept
    let response = reqwest::Client::new()
        .get(url)
        .header(reqwest::header::ACCEPT, "*/*")
        .send()
        .await
        .map_err(|error| format!("не удалось скачать файл: {error}"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("файл недоступен: HTTP {}", status.as_u16()));
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        .unwrap_or_else(|| guess_content_type(url).to_string());

    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("файл не дочитан: {error}"))?;

    // защита от случайно огромных файлов в памяти интерфейса
    if bytes.len() > 12 * 1024 * 1024 {
        return Err("файл больше 12 МБ".into());
    }

    use base64::Engine as _;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{content_type};base64,{encoded}"))
}

/// Тип содержимого по расширению: CDN не всегда его присылает.
fn guess_content_type(url: &str) -> &'static str {
    let path = url.split('?').next().unwrap_or(url);
    if path.ends_with(".svg") {
        "image/svg+xml"
    } else if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".webp") {
        "image/webp"
    } else if path.ends_with(".gif") {
        "image/gif"
    } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        "image/jpeg"
    } else {
        "application/octet-stream"
    }
}

/// Адрес аватара пользователя.
///
/// В сообщениях автор часто приходит без файла аватара, поэтому адрес
/// берём у самого пользователя и запоминаем в кэше.
#[tauri::command]
async fn user_avatar(
    user_id: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<Option<String>> {
    let (http, cdn) = {
        let guard = state.http.read().await;
        let client = guard
            .as_ref()
            .cloned()
            .ok_or_else(|| CommandError::new("unauthorized", "сначала войдите в аккаунт"))?;
        (client, state.cdn_url.read().await.clone())
    };

    let user = http.fetch_user(&user_id).await?;
    state.cache.insert_user(user.clone()).await;
    Ok(user
        .avatar
        .as_ref()
        .and_then(|file| views::file_url(file, cdn.as_deref())))
}

/// Скачать картинку эмодзи из статики Stoat.
///
/// Набор картинок (`twemoji`/`noto`) настраивается в клиенте пользователя,
/// поэтому пробуем по очереди и запоминаем удачный.
#[tauri::command]
async fn fetch_emoji(codepoint: String, pack: Option<String>) -> CmdResult<String> {
    if !codepoint
        .chars()
        .all(|symbol| symbol.is_ascii_hexdigit() || symbol == '-')
    {
        return Err(CommandError::new("bad_emoji", "некорректный код эмодзи"));
    }

    let mut packs: Vec<String> = Vec::new();
    if let Some(pack) = pack.filter(|pack| !pack.trim().is_empty()) {
        packs.push(pack);
    }
    for fallback in ["twemoji", "noto"] {
        if !packs.iter().any(|pack| pack == fallback) {
            packs.push(fallback.to_string());
        }
    }

    let mut last = String::from("эмодзи не найдено");
    for pack in packs {
        let url = views::emoji_url(&pack, &codepoint);
        match download_data_url(&url).await {
            Ok(data) => return Ok(data),
            Err(error) => last = error,
        }
    }
    Err(CommandError::new("not_found", last))
}

/// Узнать адрес файлового сервиса у инстанса (нужен для аватаров).
async fn fetch_cdn_url(state: &State<'_, Arc<AppState>>) -> Option<String> {
    let instance = state.instance.read().await.clone();
    let mut client = HttpClient::new(instance.api_url.clone());
    client.set_app_name(instance.app_name.clone());
    let root = client.get_root().await.ok()?;
    let url = root.autumn_url().map(str::to_string);
    *state.cdn_url.write().await = url.clone();
    url
}

/// История канала: сообщения с авторами и файлами, готовые к показу.
#[tauri::command]
async fn channel_history(
    channel_id: String,
    before: Option<String>,
    limit: Option<u32>,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<HistoryView> {
    let http = {
        let guard = state.http.read().await;
        guard
            .as_ref()
            .cloned()
            .ok_or_else(|| CommandError::new("unauthorized", "сначала войдите в аккаунт"))?
    };

    let response = http
        .fetch_messages(&channel_id, before.as_deref(), None, limit)
        .await?;

    let (mut messages, users) = match response {
        revolt_models::v0::BulkMessageResponse::JustMessages(messages) => (messages, Vec::new()),
        revolt_models::v0::BulkMessageResponse::MessagesAndUsers {
            messages, users, ..
        } => (messages, users),
    };

    // сервер отдаёт новые сверху — интерфейсу удобнее по возрастанию времени
    messages.reverse();

    let mut authors: std::collections::HashMap<String, UserView> = std::collections::HashMap::new();
    for user in users {
        let view = UserView::from(user.clone());
        authors.insert(view.id.clone(), view);
        state.cache.insert_user(user).await;
    }
    for message in &messages {
        if let Some(user) = &message.user {
            authors
                .entry(user.id.clone())
                .or_insert_with(|| UserView::from(user.clone()));
        }
        state.cache.insert_message_no_event(message.clone()).await;
    }

    // имена авторов, которых не прислали в этом ответе, берём из кэша
    for message in &messages {
        if !authors.contains_key(&message.author)
            && let Some(user) = state.cache.user(&message.author).await
        {
            authors.insert(message.author.clone(), UserView::from(user));
        }
    }

    let cdn = state.cdn_url.read().await.clone();
    Ok(HistoryView {
        messages: messages
            .into_iter()
            .map(|message| ChatMessage::build(message, &authors, cdn.as_deref()))
            .collect(),
        has_more: true,
    })
}

/// Изменить текст своего сообщения.
#[tauri::command]
async fn edit_message(
    channel_id: String,
    message_id: String,
    content: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<ChatMessage> {
    let http = {
        let guard = state.http.read().await;
        guard
            .as_ref()
            .cloned()
            .ok_or_else(|| CommandError::new("unauthorized", "сначала войдите в аккаунт"))?
    };

    let data = v0::DataEditMessage {
        content: Some(content),
        embeds: None,
    };
    let message = http.edit_message(&channel_id, &message_id, data).await?;
    state.cache.insert_message_no_event(message.clone()).await;

    let cdn = state.cdn_url.read().await.clone();
    let authors = std::collections::HashMap::new();
    Ok(ChatMessage::build(message, &authors, cdn.as_deref()))
}

/// Удалить своё сообщение.
#[tauri::command]
async fn delete_message(
    channel_id: String,
    message_id: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<()> {
    let http = {
        let guard = state.http.read().await;
        guard
            .as_ref()
            .cloned()
            .ok_or_else(|| CommandError::new("unauthorized", "сначала войдите в аккаунт"))?
    };
    http.delete_message(&channel_id, &message_id).await?;
    Ok(())
}

/// Снимок кэша для первичной отрисовки.
#[tauri::command]
async fn cache_snapshot(state: State<'_, Arc<AppState>>) -> CmdResult<serde_json::Value> {
    let snapshot = state.cache.snapshot().await;
    serde_json::to_value(snapshot).map_err(|error| CommandError::new("internal", error.to_string()))
}

/// Где лежат данные: показывается в настройках.
#[tauri::command]
async fn data_dir(state: State<'_, Arc<AppState>>) -> CmdResult<String> {
    Ok(state.data_dir.display().to_string())
}

// ─────────────────────────────── представления ──────────────────────────────

use revolt_models::v0;
use tauri::Emitter;

/// Состояние сессии для UI.
#[derive(Debug, Serialize)]
pub struct SessionView {
    /// Выполнен ли вход
    pub logged_in: bool,
    /// Кто вошёл
    pub me: Option<UserView>,
    /// Сколько серверов в кэше
    pub servers: usize,
    /// Сколько каналов в кэше
    pub channels: usize,
}

fn revolt_send(content: &str) -> v0::DataMessageSend {
    v0::DataMessageSend {
        nonce: None,
        content: Some(content.to_string()),
        attachments: None,
        replies: None,
        embeds: None,
        masquerade: None,
        interactions: None,
        flags: None,
    }
}

/// Простой уникальный ключ без внешних зависимостей.
fn nonce() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{nanos:x}")
}

// ─────────────────────────────────── вход ───────────────────────────────────

/// Запуск приложения.
pub fn run() {
    let log_dir = log_directory();
    let file_writer = log_dir.as_ref().and_then(|dir| {
        std::fs::create_dir_all(dir).ok()?;
        std::fs::File::create(dir.join("tauri-stoat.log")).ok()
    });

    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "tauri_stoat=debug,stoat_core=info".into());

    // в Windows-релизе нет консоли, поэтому журнал обязательно пишем в файл
    match file_writer {
        Some(file) => {
            tracing_subscriber::fmt()
                .with_env_filter(filter)
                .with_ansi(false)
                .with_writer(std::sync::Mutex::new(file))
                .init();
        }
        None => {
            tracing_subscriber::fmt().with_env_filter(filter).init();
        }
    }

    // паника в GUI-процессе иначе исчезает бесследно
    std::panic::set_hook(Box::new(|info| {
        tracing::error!(%info, "паника");
        if let Some(dir) = log_directory() {
            let _ = std::fs::create_dir_all(&dir);
            let path = dir.join("panic.log");
            let _ = std::fs::write(path, format!("{info}\n"));
        }
    }));

    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        log_dir = ?log_dir,
        "запуск Tauri-Stoat"
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // ошибка инициализации не должна убивать окно без следа
            let data_dir = resolve_data_dir(app.handle());
            tracing::info!(dir = %data_dir.display(), "каталог данных");

            if let Err(error) = ensure_layout(&data_dir) {
                tracing::warn!(%error, "не удалось подготовить каталоги данных");
            }

            let state = Arc::new(AppState::new(data_dir));
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            instance_info,
            login_password,
            login_mfa,
            login_with_token,
            logout,
            session_state,
            connect_gateway,
            workspace,
            fetch_media,
            fetch_emoji,
            user_avatar,
            channel_history,
            send_message,
            edit_message,
            delete_message,
            cache_snapshot,
            data_dir,
        ])
        .run(tauri::generate_context!())
        .expect("ошибка запуска Tauri-приложения");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_layout_is_created() {
        let dir = std::env::temp_dir().join(format!("tauri-stoat-test-{}", nonce()));
        ensure_layout(&dir).unwrap();
        for sub in ["cache", "plugins", "themes", "logs"] {
            assert!(dir.join(sub).is_dir(), "нет каталога {sub}");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn nonce_is_unique_enough() {
        assert_ne!(nonce(), nonce());
    }

    #[test]
    fn send_payload_is_minimal() {
        let data = revolt_send("привет");
        assert_eq!(data.content.as_deref(), Some("привет"));
        assert!(data.attachments.is_none());
    }
}

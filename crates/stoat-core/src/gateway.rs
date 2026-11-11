//! Gateway Stoat (Bonfire): WebSocket-соединение и события протокола.
//!
//! Реализует то, что описано в официальной документации:
//! `wss://…/?version=1&format=json&ready=…`, авторизация событием
//! `Authenticate`, `Ping` раз в 10–30 секунд, обработка `Bulk` (пачка событий)
//! и `Ready` (снимок состояния).
//!
//! События отдаются наружу как [`GatewayEvent`] по [`tokio::sync::mpsc`] —
//! так их одинаково удобно принимать и в Tauri-командах, и в plugin-host.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use revolt_models::v0;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use url::Url;

use crate::error::{Error, Result};

/// Событие, которое клиент отправляет на сервер.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum ClientEvent {
    /// Авторизация сессионным или бот-токеном
    Authenticate {
        /// Токен сессии
        token: String,
    },
    /// Начать печатать в канале
    BeginTyping {
        /// Id канала
        channel: String,
    },
    /// Перестать печатать
    EndTyping {
        /// Id канала
        channel: String,
    },
    /// Пинг с произвольным значением, сервер вернёт его в `Pong`
    Ping {
        /// Значение, которое вернётся обратно
        data: u64,
    },
    /// Подписка на `UserUpdate` сервера (живёт 15 минут, максимум 5 подписок)
    Subscribe {
        /// Id сервера
        server_id: String,
    },
}

/// Событие от сервера.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum GatewayEvent {
    /// Аутентификация прошла
    Authenticated,
    /// Снимок состояния после подключения
    Ready(Box<Ready>),
    /// Ошибка протокола
    ///
    /// На практике сервер присылает `{"type":"Error","data":{"type":"InvalidSession",…}}`,
    /// хотя документация обещает `{"error":"…"}` — [`ErrorEvent`] понимает оба вида.
    Error(ErrorEvent),
    /// Сессия завершена (выход или сброс токена)
    Logout,
    /// Ответ на [`ClientEvent::Ping`]
    Pong {
        /// Значение из пинга
        data: u64,
    },
    /// Новое сообщение
    Message(Box<v0::Message>),
    /// Сообщение изменено, `data` — частичное сообщение
    MessageUpdate {
        /// Id сообщения
        id: String,
        /// Id канала
        channel: String,
        /// Изменённые поля
        data: serde_json::Value,
    },
    /// К сообщению добавлены данные (например, встраивания)
    MessageAppend {
        /// Id сообщения
        id: String,
        /// Id канала
        channel: String,
        /// Что добавлено
        append: serde_json::Value,
    },
    /// Сообщение удалено
    MessageDelete {
        /// Id сообщения
        id: String,
        /// Id канала
        channel: String,
    },
    /// Реакция добавлена
    MessageReact {
        /// Id сообщения
        id: String,
        /// Id канала
        channel_id: String,
        /// Кто поставил
        user_id: String,
        /// Какой эмодзи
        emoji_id: String,
    },
    /// Реакция убрана пользователем
    MessageUnreact {
        /// Id сообщения
        id: String,
        /// Id канала
        channel_id: String,
        /// Кто убрал
        user_id: String,
        /// Какой эмодзи
        emoji_id: String,
    },
    /// Все реакции с этим эмодзи убраны
    MessageRemoveReaction {
        /// Id сообщения
        id: String,
        /// Id канала
        channel_id: String,
        /// Какой эмодзи
        emoji_id: String,
    },
    /// Канал создан
    ChannelCreate(Box<v0::Channel>),
    /// Канал изменён
    ChannelUpdate {
        /// Id канала
        id: String,
        /// Изменённые поля
        data: serde_json::Value,
        /// Поля, которые нужно очистить
        #[serde(default)]
        clear: Vec<String>,
    },
    /// Канал удалён
    ChannelDelete {
        /// Id канала
        id: String,
    },
    /// Пользователь присоединился к группе
    ChannelGroupJoin {
        /// Id канала
        id: String,
        /// Id пользователя
        user: String,
    },
    /// Пользователь покинул группу
    ChannelGroupLeave {
        /// Id канала
        id: String,
        /// Id пользователя
        user: String,
    },
    /// Пользователь начал печатать
    ChannelStartTyping {
        /// Id канала
        id: String,
        /// Id пользователя
        user: String,
    },
    /// Пользователь перестал печатать
    ChannelStopTyping {
        /// Id канала
        id: String,
        /// Id пользователя
        user: String,
    },
    /// Канал отмечен прочитанным
    ChannelAck {
        /// Id канала
        id: String,
        /// Id пользователя
        user: String,
        /// Последнее прочитанное сообщение
        message_id: String,
    },
    /// Сервер создан или пользователь в него вступил
    ServerCreate(Box<v0::Server>),
    /// Сервер изменён
    ServerUpdate {
        /// Id сервера
        id: String,
        /// Изменённые поля
        data: serde_json::Value,
        /// Поля, которые нужно очистить
        #[serde(default)]
        clear: Vec<String>,
    },
    /// Пользователь покинул сервер или сервер удалён
    ServerDelete {
        /// Id сервера
        id: String,
    },
    /// Участник сервера обновлён
    ServerMemberUpdate {
        /// Id сервера
        id: String,
        /// Id пользователя
        user: String,
        /// Изменённые поля
        data: serde_json::Value,
        /// Поля, которые нужно очистить
        #[serde(default)]
        clear: Vec<String>,
    },
    /// Участник присоединился к серверу
    ServerMemberJoin {
        /// Id сервера
        id: String,
        /// Id пользователя
        user: String,
    },
    /// Участник покинул сервер
    ServerMemberLeave {
        /// Id сервера
        id: String,
        /// Id пользователя
        user: String,
        /// Причина (`Kicked`, `Banned`, `Left`)
        #[serde(default)]
        reason: Option<String>,
    },
    /// Роль сервера обновлена
    ServerRoleUpdate {
        /// Id сервера
        id: String,
        /// Id роли
        role_id: String,
        /// Изменённые поля
        data: serde_json::Value,
        /// Поля, которые нужно очистить
        #[serde(default)]
        clear: Vec<String>,
    },
    /// Роль удалена
    ServerRoleDelete {
        /// Id сервера
        id: String,
        /// Id роли
        role_id: String,
    },
    /// Эмодзи добавлен на сервер
    EmojiCreate(Box<v0::Emoji>),
    /// Эмодзи удалён
    EmojiDelete {
        /// Id эмодзи
        id: String,
    },
    /// Пользователь обновил профиль
    UserUpdate {
        /// Id пользователя
        id: String,
        /// Изменённые поля
        data: serde_json::Value,
        /// Поля, которые нужно очистить
        #[serde(default)]
        clear: Vec<String>,
        /// Онлайн-статус
        #[serde(default)]
        online: Option<bool>,
    },
    /// Отношения с пользователем (дружба, блокировка) изменились
    UserRelationship {
        /// Id пользователя
        id: String,
        /// Пользователь, к которому относится изменение
        user: Box<v0::User>,
        /// Статус
        status: v0::RelationshipStatus,
    },
    /// Настройки пользователя изменены
    UserSettingsUpdate {
        /// Id пользователя
        id: String,
        /// Частичные настройки
        data: serde_json::Value,
    },
    /// Платформенная ошибка (например, `LabelMe`)
    #[serde(other)]
    Unknown,
}

/// Тело события `Error`.
///
/// Формат на практике отличается от документации, поэтому разбор терпимый:
///
/// * `{"type":"Error","data":{"type":"InvalidSession","location":"…"}}` — реальный ответ;
/// * `{"type":"Error","error":"InvalidSession"}` — то, что обещает документация;
/// * `{"type":"Error","error":{"type":"…","location":"…"}}` — на всякий случай.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ErrorEvent {
    /// Код ошибки (`InvalidSession`, `AlreadyAuthenticated`, `LabelMe`, …)
    pub kind: String,
    /// Где на сервере произошла ошибка, если сервер это прислал
    pub location: Option<String>,
}

impl ErrorEvent {
    /// Короткое описание для UI и логов.
    pub fn message(&self) -> &str {
        &self.kind
    }

    /// Ошибка означает, что токен больше не годится.
    pub fn is_invalid_session(&self) -> bool {
        self.kind == "InvalidSession"
    }

    fn from_value(value: &serde_json::Value) -> Self {
        // полезная нагрузка может лежать в `data`, в `error` или прямо в событии
        let source = value
            .get("data")
            .or_else(|| value.get("error"))
            .unwrap_or(value);

        let kind = source
            .get("type")
            .or_else(|| source.get("error"))
            .or_else(|| source.get("message"))
            .and_then(|value| value.as_str())
            .or_else(|| source.as_str())
            .unwrap_or("Unknown")
            .to_string();

        let location = source
            .get("location")
            .and_then(|value| value.as_str())
            .map(str::to_string);

        Self { kind, location }
    }
}

impl<'de> Deserialize<'de> for ErrorEvent {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        Ok(Self::from_value(&value))
    }
}

/// Снимок состояния из события `Ready`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Ready {
    /// Пользователи, с которыми есть отношения
    #[serde(default)]
    pub users: Option<Vec<v0::User>>,
    /// Серверы
    #[serde(default)]
    pub servers: Option<Vec<v0::Server>>,
    /// Каналы
    #[serde(default)]
    pub channels: Option<Vec<v0::Channel>>,
    /// Участники серверов
    #[serde(default)]
    pub members: Option<Vec<v0::Member>>,
    /// Эмодзи
    #[serde(default)]
    pub emojis: Option<Vec<v0::Emoji>>,
    /// Настройки
    #[serde(default)]
    pub user_settings: Option<serde_json::Value>,
    /// Непрочитанные
    #[serde(default)]
    pub channel_unreads: Option<Vec<v0::ChannelUnread>>,
}

/// Внутреннее представление входящего пакета: `Bulk` разворачивается в очередь.
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum Incoming {
    Bulk {
        #[serde(default)]
        v: Vec<serde_json::Value>,
    },
    #[serde(other)]
    Other,
}

/// Настройки gateway-клиента.
#[derive(Debug, Clone)]
pub struct GatewayConfig {
    /// Интервал пинга (документация: 10–30 секунд)
    pub ping_interval: Duration,
    /// Сколько ждать `Authenticated`, прежде чем считать соединение мёртвым
    pub auth_timeout: Duration,
    /// Поля `Ready`, которые просим у сервера
    pub ready_fields: Vec<crate::ReadyField>,
    /// Переподключаться автоматически при обрыве
    pub auto_reconnect: bool,
    /// Максимальная задержка между попытками переподключения
    pub max_backoff: Duration,
}

impl Default for GatewayConfig {
    fn default() -> Self {
        Self {
            ping_interval: Duration::from_secs(20),
            auth_timeout: Duration::from_secs(30),
            ready_fields: vec![
                crate::ReadyField::Users,
                crate::ReadyField::Servers,
                crate::ReadyField::Channels,
                crate::ReadyField::Members,
                crate::ReadyField::Emojis,
                crate::ReadyField::ChannelUnreads,
            ],
            auto_reconnect: true,
            max_backoff: Duration::from_secs(60),
        }
    }
}

/// Состояние соединения, о котором полезно знать UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ConnectionState {
    /// Соединение устанавливается
    Connecting,
    /// Ожидаем `Authenticated`
    Authenticating,
    /// Работаем в штатном режиме
    Ready,
    /// Ждём перед переподключением
    Reconnecting,
    /// Остановлен по команде
    Stopped,
}

/// Запуск gateway в отдельной задаче.
///
/// Возвращает [`GatewayHandle`], через который можно отправлять события
/// (`BeginTyping` и т.п.) и останавливать соединение, а также поток событий.
pub async fn connect(
    url: Url,
    token: String,
    config: GatewayConfig,
) -> Result<(GatewayHandle, mpsc::Receiver<GatewayEvent>)> {
    let (event_tx, event_rx) = mpsc::channel(256);
    let (send_tx, send_rx) = mpsc::channel::<ClientEvent>(32);
    let (state_tx, state_rx) = tokio::sync::watch::channel(ConnectionState::Connecting);

    let handle = GatewayHandle {
        outgoing: send_tx,
        states: state_rx,
        shutdown: tokio_util_lite::ShutdownFlag::new(),
    };

    tokio::spawn(run_loop(
        url,
        token,
        config,
        event_tx,
        send_rx,
        state_tx,
        handle.shutdown.clone(),
    ));

    Ok((handle, event_rx))
}

/// Управление соединением.
#[derive(Debug, Clone)]
pub struct GatewayHandle {
    outgoing: mpsc::Sender<ClientEvent>,
    states: tokio::sync::watch::Receiver<ConnectionState>,
    shutdown: tokio_util_lite::ShutdownFlag,
}

impl GatewayHandle {
    /// Отправить событие на сервер (не блокирует UI).
    pub async fn send(&self, event: ClientEvent) -> Result<()> {
        self.outgoing
            .send(event)
            .await
            .map_err(|_| Error::ConnectionClosed)
    }

    /// Подписаться на изменения состояния соединения.
    pub fn state(&self) -> tokio::sync::watch::Receiver<ConnectionState> {
        self.states.clone()
    }

    /// Корректно закрыть соединение и остановить задачу.
    pub fn stop(&self) {
        self.shutdown.trigger();
    }
}

async fn run_loop(
    url: Url,
    token: String,
    config: GatewayConfig,
    events: mpsc::Sender<GatewayEvent>,
    mut outgoing: mpsc::Receiver<ClientEvent>,
    state: tokio::sync::watch::Sender<ConnectionState>,
    shutdown: tokio_util_lite::ShutdownFlag,
) {
    let mut attempt: u32 = 0;

    loop {
        if shutdown.is_triggered() {
            let _ = state.send(ConnectionState::Stopped);
            return;
        }

        let _ = state.send(ConnectionState::Connecting);

        match session(
            &url,
            &token,
            &config,
            &events,
            &mut outgoing,
            &state,
            &shutdown,
        )
        .await
        {
            Ok(()) => {
                // штатное закрытие
                let _ = state.send(ConnectionState::Stopped);
                return;
            }
            Err(error) => {
                tracing::warn!(%error, "gateway: соединение потеряно");
                if !config.auto_reconnect || !error.is_retryable() {
                    let _ = events
                        .send(GatewayEvent::Error(ErrorEvent {
                            kind: error.to_string(),
                            location: None,
                        }))
                        .await;
                    let _ = state.send(ConnectionState::Stopped);
                    return;
                }
            }
        }

        attempt = attempt.saturating_add(1);
        let backoff = backoff_delay(attempt, config.max_backoff);
        let _ = state.send(ConnectionState::Reconnecting);
        tracing::info!(?backoff, attempt, "gateway: переподключение");

        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            _ = shutdown.wait() => {
                let _ = state.send(ConnectionState::Stopped);
                return;
            }
        }
    }
}

/// Ошибка шлюза, после которой соединение заведомо бесполезно.
///
/// Остальные коды (`AlreadyAuthenticated`, `PayloadTooLarge`, `NotAuthenticated`
/// на конкретный запрос и прочее) сервер присылает, не закрывая сокет, — на них
/// нельзя прекращать приём событий.
fn is_fatal_gateway_error(kind: &str) -> bool {
    matches!(kind, "InvalidSession" | "Logout" | "SessionExpired")
}

/// Экспоненциальная задержка с потолком: 1s, 2s, 4s, … (но не больше `max`).
fn backoff_delay(attempt: u32, max: Duration) -> Duration {
    let factor = 2u32.saturating_pow(attempt.min(6));
    Duration::from_secs(1) * factor.min(max.as_secs() as u32).max(1)
}

/// Одна сессия: подключение → Authenticate → цикл событий, пока не оборвётся.
#[allow(clippy::too_many_arguments)]
async fn session(
    url: &Url,
    token: &str,
    config: &GatewayConfig,
    events: &mpsc::Sender<GatewayEvent>,
    outgoing: &mut mpsc::Receiver<ClientEvent>,
    state: &tokio::sync::watch::Sender<ConnectionState>,
    shutdown: &tokio_util_lite::ShutdownFlag,
) -> Result<()> {
    let request = url.as_str().into_client_request()?;
    let (stream, _response) = tokio_tungstenite::connect_async(request).await?;
    let (mut sink, mut source) = stream.split();

    let _ = state.send(ConnectionState::Authenticating);

    // авторизуемся сразу после подключения
    let authenticate = serde_json::to_string(&ClientEvent::Authenticate {
        token: token.to_string(),
    })?;
    sink.send(WsMessage::Text(authenticate.into())).await?;

    let mut ping = tokio::time::interval(config.ping_interval);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut ping_value: u64 = 0;
    let mut auth_deadline = tokio::time::Instant::now() + config.auth_timeout;
    // сервер закрывает соединение сразу после ошибки авторизации —
    // это ожидаемое завершение, а не сбой транспорта
    let mut terminal = false;

    loop {
        tokio::select! {
            biased;

            _ = shutdown.wait() => {
                let _ = sink.close().await;
                return Ok(());
            }

            incoming = outgoing.recv() => {
                match incoming {
                    Some(event) => {
                        let payload = serde_json::to_string(&event)?;
                        sink.send(WsMessage::Text(payload.into())).await?;
                    }
                    // отправитель исчез — закрываемся штатно
                    None => {
                        let _ = sink.close().await;
                        return Ok(());
                    }
                }
            }

            _ = ping.tick() => {
                ping_value = ping_value.wrapping_add(1);
                let payload = serde_json::to_string(&ClientEvent::Ping { data: ping_value })?;
                sink.send(WsMessage::Text(payload.into())).await?;

                if tokio::time::Instant::now() > auth_deadline {
                    return Err(Error::Gateway("нет Authenticated за отведённое время".into()));
                }
            }

            message = source.next() => {
                let Some(message) = message else {
                    return if terminal {
                        Ok(())
                    } else {
                        Err(Error::ConnectionClosed)
                    };
                };

                let message = match message {
                    Ok(message) => message,
                    Err(error) if terminal => {
                        tracing::debug!(%error, "gateway: соединение закрыто после ошибки протокола");
                        return Ok(());
                    }
                    Err(error) => return Err(error.into()),
                };

                match message {
                    WsMessage::Text(text) => {
                        for event in parse_packet(text.as_str())? {
                            if let GatewayEvent::Error(error) = &event {
                                tracing::warn!(
                                    kind = error.message(),
                                    location = ?error.location,
                                    "gateway: ошибка протокола"
                                );
                            }
                            if matches!(event, GatewayEvent::Authenticated) {
                                // продлеваем дедлайн: сервер ответил
                                auth_deadline = tokio::time::Instant::now() + config.auth_timeout;
                            }
                            if matches!(event, GatewayEvent::Ready(_)) {
                                let _ = state.send(ConnectionState::Ready);
                            }
                            // Код из `Error` — это часто НЕ повод рвать соединение:
                            // сервер присылает `AlreadyAuthenticated`, `PayloadTooLarge`,
                            // жалобы на конкретный пакет и т.п., а сессия после них жива.
                            // Раньше любая такая ошибка объявлялась терминальной — и шлюз
                            // отключался, из-за чего после отправки сообщения пропадали
                            // живые события (новые сообщения, участники).
                            if let GatewayEvent::Error(error) = &event
                                && !is_fatal_gateway_error(error.message())
                            {
                                tracing::info!(
                                    kind = error.message(),
                                    "gateway: ошибка протокола, соединение продолжает работать"
                                );
                            }
                            if let GatewayEvent::Error(error) = &event
                                && is_fatal_gateway_error(error.message())
                            {
                                terminal = true;
                            }
                            if matches!(event, GatewayEvent::Logout) {
                                let _ = events.send(event).await;
                                return Ok(());
                            }
                            if events.send(event).await.is_err() {
                                // получатель событий больше не нужен
                                let _ = sink.close().await;
                                return Ok(());
                            }
                        }
                    }
                    WsMessage::Binary(bin) => {
                        // сервер может отвечать msgpack, если попросить format=msgpack;
                        // мы просим json, но не падаем на неожиданных кадрах
                        tracing::debug!(len = bin.len(), "gateway: бинарный пакет проигнорирован");
                    }
                    WsMessage::Ping(payload) => sink.send(WsMessage::Pong(payload)).await?,
                    WsMessage::Pong(_) => {}
                    WsMessage::Close(_) => return Ok(()),
                    WsMessage::Frame(_) => {}
                }
            }
        }
    }
}

/// Разобрать пакет: `Bulk` разворачивается, остальное — как одно событие.
fn parse_packet(text: &str) -> Result<Vec<GatewayEvent>> {
    match serde_json::from_str::<Incoming>(text) {
        Ok(Incoming::Bulk { v }) => {
            let mut events = Vec::with_capacity(v.len());
            for item in v {
                match serde_json::from_value::<GatewayEvent>(item) {
                    Ok(event) => events.push(event),
                    Err(error) => {
                        tracing::debug!(%error, "gateway: пропущено неизвестное событие из Bulk");
                    }
                }
            }
            Ok(events)
        }
        _ => match serde_json::from_str::<GatewayEvent>(text) {
            Ok(event) => Ok(vec![event]),
            Err(error) => {
                tracing::debug!(%error, "gateway: неизвестный пакет");
                Ok(vec![GatewayEvent::Unknown])
            }
        },
    }
}

/// Минималистичный флаг остановки, чтобы не тянуть tokio-util целиком.
mod tokio_util_lite {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use tokio::sync::Notify;

    /// Флаг остановки, который можно ждать асинхронно.
    #[derive(Debug, Clone, Default)]
    pub struct ShutdownFlag {
        inner: Arc<Inner>,
    }

    #[derive(Debug, Default)]
    struct Inner {
        triggered: AtomicBool,
        notify: Notify,
    }

    impl ShutdownFlag {
        /// Взвести флаг и разбудить ожидающих.
        pub fn trigger(&self) {
            self.inner.triggered.store(true, Ordering::SeqCst);
            self.inner.notify.notify_waiters();
        }

        /// Взведён ли флаг.
        pub fn is_triggered(&self) -> bool {
            self.inner.triggered.load(Ordering::SeqCst)
        }

        /// Новый флаг остановки.
        pub fn new() -> Self {
            Self::default()
        }

        /// Дождаться взведения флага.
        pub async fn wait(&self) {
            if self.is_triggered() {
                return;
            }
            self.inner.notify.notified().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bulk_packets_are_flattened() {
        let packet = r#"{"type":"Bulk","v":[
            {"type":"Pong","data":1},
            {"type":"MessageDelete","id":"m1","channel":"c1"}
        ]}"#;

        let events = parse_packet(packet).unwrap();
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], GatewayEvent::Pong { data: 1 }));
        assert!(matches!(
            &events[1],
            GatewayEvent::MessageDelete { id, channel } if id == "m1" && channel == "c1"
        ));
    }

    #[test]
    fn single_event_is_parsed() {
        let events = parse_packet(r#"{"type":"Authenticated"}"#).unwrap();
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], GatewayEvent::Authenticated));
    }

    #[test]
    fn unknown_events_do_not_break_the_stream() {
        let events = parse_packet(r#"{"type":"SomethingNewFromStoat","x":1}"#).unwrap();
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], GatewayEvent::Unknown));
    }

    #[test]
    fn message_event_matches_api_schema() {
        // реальная форма события Message: поля Message плюс type
        let packet = r#"{
            "type":"Message",
            "_id":"01ABCDEF","channel":"01CH","author":"01USER",
            "content":"привет","nonce":null
        }"#;

        let events = parse_packet(packet).unwrap();
        match &events[0] {
            GatewayEvent::Message(message) => {
                assert_eq!(message.id, "01ABCDEF");
                assert_eq!(message.content.as_deref(), Some("привет"));
            }
            other => panic!("ожидали Message, получили {other:?}"),
        }
    }

    #[test]
    fn client_events_serialize_to_expected_wire_format() {
        let auth = serde_json::to_string(&ClientEvent::Authenticate { token: "t".into() }).unwrap();
        assert_eq!(auth, r#"{"type":"Authenticate","token":"t"}"#);

        let ping = serde_json::to_string(&ClientEvent::Ping { data: 7 }).unwrap();
        assert_eq!(ping, r#"{"type":"Ping","data":7}"#);

        let typing = serde_json::to_string(&ClientEvent::BeginTyping {
            channel: "c".into(),
        })
        .unwrap();
        assert_eq!(typing, r#"{"type":"BeginTyping","channel":"c"}"#);
    }

    #[test]
    fn error_packet_uses_real_wire_format() {
        // именно так ответил api.stoat.chat на неверный токен 2026-11-10
        let packet = r#"{"type":"Error","data":{"type":"InvalidSession","location":"crates/core/database/src/models/users/model.rs:346:38"}}"#;
        let events = parse_packet(packet).unwrap();

        match &events[0] {
            GatewayEvent::Error(error) => {
                assert_eq!(error.message(), "InvalidSession");
                assert!(error.is_invalid_session());
                assert!(error.location.is_some());
            }
            other => panic!("ожидали Error, получили {other:?}"),
        }
    }

    #[test]
    fn error_packet_also_understands_documented_format() {
        // формат из документации: {"type":"Error","error":"{error_id}"}
        let events = parse_packet(r#"{"type":"Error","error":"AlreadyAuthenticated"}"#).unwrap();
        match &events[0] {
            GatewayEvent::Error(error) => assert_eq!(error.message(), "AlreadyAuthenticated"),
            other => panic!("ожидали Error, получили {other:?}"),
        }
    }

    #[test]
    fn error_packet_handles_error_object() {
        let events = parse_packet(r#"{"type":"Error","error":{"type":"LabelMe"}}"#).unwrap();
        match &events[0] {
            GatewayEvent::Error(error) => assert_eq!(error.message(), "LabelMe"),
            other => panic!("ожидали Error, получили {other:?}"),
        }
    }

    #[test]
    fn backoff_grows_and_caps() {
        let max = Duration::from_secs(60);
        assert_eq!(backoff_delay(1, max), Duration::from_secs(2));
        assert_eq!(backoff_delay(3, max), Duration::from_secs(8));
        assert_eq!(backoff_delay(10, max), max);
    }

    #[tokio::test]
    async fn shutdown_flag_wakes_waiters() {
        let flag = tokio_util_lite::ShutdownFlag::new();
        let waiter = {
            let flag = flag.clone();
            tokio::spawn(async move { flag.wait().await })
        };

        tk::yield_now().await;
        flag.trigger();

        tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("ожидание должно завершиться")
            .unwrap();
        assert!(flag.is_triggered());
    }

    mod tk {
        pub use tokio::task::yield_now;
    }
}

#[cfg(test)]
mod fatal_tests {
    use super::*;

    #[test]
    fn only_session_errors_stop_the_gateway() {
        assert!(is_fatal_gateway_error("InvalidSession"));
        assert!(is_fatal_gateway_error("Logout"));
        // эти коды приходят на конкретный пакет, соединение после них живёт
        assert!(!is_fatal_gateway_error("AlreadyAuthenticated"));
        assert!(!is_fatal_gateway_error("PayloadTooLarge"));
        assert!(!is_fatal_gateway_error("NotFound"));
    }
}

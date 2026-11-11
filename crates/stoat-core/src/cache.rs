//! Кэш состояния клиента: пользователи, серверы, каналы, сообщения.
//!
//! Задача кэша — держать актуальный снимок в одном месте, чтобы UI и плагины
//! не лазили в сеть за каждым полем, и чтобы события gateway применялись
//! предсказуемо (`MessageUpdate` со частичным `data`, `ServerMemberLeave` и т.п.).
//!
//! Любое изменение отдаётся наружу как [`CacheEvent`] — по нему Tauri-слой
//! рассылает обновления в webview, а plugin-host — плагинам в рамках их прав.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::Arc;

use revolt_models::v0;
use serde::{Deserialize, Serialize};
use tokio::sync::{RwLock, broadcast};

use crate::gateway::{GatewayEvent, Ready};

/// Что произошло в кэше.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CacheEvent {
    /// Пользователь появился или обновился
    UserChanged(String),
    /// Пользователь исчез из кэша (для отношений и участников)
    UserRemoved(String),
    /// Сервер появился или обновился
    ServerChanged(String),
    /// Сервер покинут или удалён
    ServerRemoved(String),
    /// Канал появился или обновился
    ChannelChanged(String),
    /// Канал удалён
    ChannelRemoved(String),
    /// Сообщение добавлено или изменено
    MessageChanged {
        /// Id канала
        channel: String,
        /// Id сообщения
        message: String,
    },
    /// Сообщение удалено
    MessageRemoved {
        /// Id канала
        channel: String,
        /// Id сообщения
        message: String,
    },
    /// Пользователь печатает в канале
    Typing {
        /// Id канала
        channel: String,
        /// Id пользователя
        user: String,
        /// true — начал, false — перестал
        active: bool,
    },
    /// Кэш полностью сброшен (например, при Logout)
    Cleared,
}

/// Что пользователь уже прочитал в канале.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Unread {
    /// Последнее прочитанное сообщение
    pub last_id: Option<String>,
    /// Непрочитанные сообщения с упоминанием пользователя
    pub mentions: Vec<String>,
}

impl Unread {
    /// Есть ли в канале что-то новее прочитанного.
    ///
    /// Id сообщений — ULID, поэтому их порядок совпадает с порядком строк.
    /// Канал без отметки о прочтении считается непрочитанным, как в
    /// браузерном клиенте.
    pub fn is_behind(unread: Option<&Unread>, last_message_id: Option<&str>) -> bool {
        let Some(last) = last_message_id else {
            return false;
        };
        match unread.and_then(|unread| unread.last_id.as_deref()) {
            Some(read) => read < last,
            None => true,
        }
    }
}

/// Снимок кэша, который отдаётся в UI.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Snapshot {
    /// Пользователи
    pub users: Vec<v0::User>,
    /// Серверы
    pub servers: Vec<v0::Server>,
    /// Каналы
    pub channels: Vec<v0::Channel>,
    /// Участники по id сервера
    pub members: HashMap<String, Vec<v0::Member>>,
    /// Эмодзи
    pub emojis: Vec<v0::Emoji>,
    /// Профиль текущего пользователя
    pub me: Option<v0::User>,
    /// Отметки о прочтении: id канала → что прочитано
    #[serde(default)]
    pub unreads: HashMap<String, Unread>,
}

#[derive(Debug, Default)]
struct State {
    me: Option<String>,
    users: HashMap<String, v0::User>,
    servers: HashMap<String, v0::Server>,
    channels: HashMap<String, v0::Channel>,
    members: HashMap<String, HashMap<String, v0::Member>>,
    emojis: HashMap<String, v0::Emoji>,
    /// сообщения: канал → id → сообщение (по возрастанию ULID, не больше
    /// [`MESSAGES_PER_CHANNEL`] на канал и [`MESSAGE_CHANNELS`] каналов)
    messages: HashMap<String, BTreeMap<String, v0::Message>>,
    /// каналы с сообщениями в кэше: от давно тронутых к свежим
    message_channels: VecDeque<String>,
    /// кто печатает: канал → множество пользователей
    typing: HashMap<String, std::collections::HashSet<String>>,
    /// отметки о прочтении: канал → что прочитано
    unreads: HashMap<String, Unread>,
}

/// Сколько последних сообщений канала держит кэш.
///
/// Кэш нужен, чтобы собрать сообщение целиком после `MessageUpdate`; историю
/// интерфейс грузит сам, поэтому хранить её всю незачем — за часы работы
/// сообщения со всех серверов съедали бы память без предела.
pub const MESSAGES_PER_CHANNEL: usize = 200;

/// Сколько каналов с сообщениями держит кэш (давно не тронутые выгружаются).
pub const MESSAGE_CHANNELS: usize = 32;

impl State {
    /// Положить сообщение, соблюдая пределы кэша.
    fn store_message(&mut self, message: v0::Message) {
        let channel = message.channel.clone();
        let map = self.messages.entry(channel.clone()).or_default();
        map.insert(message.id.clone(), message);
        while map.len() > MESSAGES_PER_CHANNEL {
            map.pop_first();
        }
        self.touch_channel(&channel);
    }

    /// Отметить канал свежим; самый давний вытесняется вместе с сообщениями.
    fn touch_channel(&mut self, channel: &str) {
        if self.message_channels.back().map(String::as_str) == Some(channel) {
            return;
        }
        if let Some(index) = self
            .message_channels
            .iter()
            .position(|item| item == channel)
        {
            self.message_channels.remove(index);
        }
        self.message_channels.push_back(channel.to_string());
        while self.message_channels.len() > MESSAGE_CHANNELS {
            if let Some(oldest) = self.message_channels.pop_front() {
                self.messages.remove(&oldest);
            }
        }
    }

    /// Убрать канал из кэша сообщений.
    fn forget_channel(&mut self, channel: &str) {
        self.messages.remove(channel);
        self.message_channels.retain(|item| item != channel);
    }
}

/// Сколько чего лежит в кэше — для страницы «Приложение» в настройках.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct CacheStats {
    /// Пользователи
    pub users: usize,
    /// Серверы
    pub servers: usize,
    /// Каналы
    pub channels: usize,
    /// Участники всех серверов
    pub members: usize,
    /// Эмодзи
    pub emojis: usize,
    /// Сообщения
    pub messages: usize,
    /// Каналы, у которых в кэше есть сообщения
    pub message_channels: usize,
}

/// Потокобезопасный кэш.
#[derive(Debug, Clone)]
pub struct Cache {
    state: Arc<RwLock<State>>,
    events: broadcast::Sender<CacheEvent>,
}

impl Cache {
    /// Новый пустой кэш.
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(512);
        Self {
            state: Arc::new(RwLock::new(State::default())),
            events,
        }
    }

    /// Подписка на изменения.
    pub fn subscribe(&self) -> broadcast::Receiver<CacheEvent> {
        self.events.subscribe()
    }

    fn publish(&self, event: CacheEvent) {
        // нет подписчиков — это нормально (например, в тестах)
        let _ = self.events.send(event);
    }

    /// Применить событие gateway к кэшу.
    pub async fn apply(&self, event: GatewayEvent) -> Vec<CacheEvent> {
        let mut emitted = Vec::new();
        {
            let mut state = self.state.write().await;
            apply_event(&mut state, event, &mut emitted);
        }
        for event in &emitted {
            let _ = self.events.send(event.clone());
        }
        emitted
    }

    /// Заменить состояние снимком `Ready`.
    pub async fn apply_ready(&self, ready: Ready) {
        let mut state = self.state.write().await;
        state.users.clear();
        state.servers.clear();
        state.channels.clear();
        state.members.clear();
        state.emojis.clear();
        state.messages.clear();
        state.message_channels.clear();
        state.typing.clear();
        state.unreads.clear();

        for user in ready.users.unwrap_or_default() {
            state.users.insert(user.id.clone(), user);
        }
        for server in ready.servers.unwrap_or_default() {
            state.servers.insert(server.id.clone(), server);
        }
        for channel in ready.channels.unwrap_or_default() {
            state
                .channels
                .insert(channel_id(&channel).to_string(), channel);
        }
        for member in ready.members.unwrap_or_default() {
            state
                .members
                .entry(member.id.server.clone())
                .or_default()
                .insert(member.id.user.clone(), member);
        }
        for emoji in ready.emojis.unwrap_or_default() {
            state.emojis.insert(emoji.id.clone(), emoji);
        }
        for unread in ready.channel_unreads.unwrap_or_default() {
            state.unreads.insert(
                unread.id.channel,
                Unread {
                    last_id: unread.last_id,
                    mentions: unread.mentions,
                },
            );
        }
        drop(state);

        self.publish(CacheEvent::Cleared);
    }

    /// Записать текущего пользователя (после `GET /users/@me`).
    pub async fn set_me(&self, user: v0::User) {
        let mut state = self.state.write().await;
        state.me = Some(user.id.clone());
        state.users.insert(user.id.clone(), user.clone());
        drop(state);
        self.publish(CacheEvent::UserChanged(user.id));
    }

    /// Вставить сообщение (например, из истории `GET /messages`).
    pub async fn insert_message(&self, message: v0::Message) {
        let channel = message.channel.clone();
        let id = message.id.clone();
        self.state.write().await.store_message(message);
        self.publish(CacheEvent::MessageChanged {
            channel,
            message: id,
        });
    }

    /// Вставить пользователя (например, из ответа `BulkMessageResponse`).
    pub async fn insert_user(&self, user: v0::User) {
        let id = user.id.clone();
        {
            let mut state = self.state.write().await;
            state.users.insert(id.clone(), user);
        }
        self.publish(CacheEvent::UserChanged(id));
    }

    /// Вставить или заменить сервер (ответ REST после изменения настроек).
    ///
    /// Событие `ServerUpdate` придёт и по шлюзу, но интерфейсу нужно сразу
    /// показать результат, не дожидаясь его.
    pub async fn insert_server(&self, server: v0::Server) {
        let id = server.id.clone();
        self.state.write().await.servers.insert(id.clone(), server);
        self.publish(CacheEvent::ServerChanged(id));
    }

    /// Записать полный список участников сервера (ответ `GET /servers/{id}/members`).
    ///
    /// `Ready` присылает только тех, кто в сети, поэтому список участников
    /// дополняется отдельным запросом. Уже известные участники перезаписываются
    /// свежими данными, а пришедшие тем временем по gateway — сохраняются.
    pub async fn insert_members(
        &self,
        server: &str,
        members: Vec<v0::Member>,
        users: Vec<v0::User>,
    ) {
        {
            let mut state = self.state.write().await;
            for user in users {
                state.users.insert(user.id.clone(), user);
            }
            let map = state.members.entry(server.to_string()).or_default();
            for member in members {
                map.insert(member.id.user.clone(), member);
            }
        }
        self.publish(CacheEvent::ServerChanged(server.to_string()));
    }

    /// Вставить сообщение без публикации события.
    ///
    /// Нужно при массовой загрузке истории: UI получает список целиком и не
    /// должен перерисовываться на каждое сообщение.
    pub async fn insert_message_no_event(&self, message: v0::Message) {
        self.state.write().await.store_message(message);
    }

    /// Вставить канал.
    pub async fn insert_channel(&self, channel: v0::Channel) {
        let id = channel_id(&channel).to_string();
        {
            let mut state = self.state.write().await;
            state.channels.insert(id.clone(), channel);
        }
        self.publish(CacheEvent::ChannelChanged(id));
    }

    /// Снимок для UI.
    pub async fn snapshot(&self) -> Snapshot {
        let state = self.state.read().await;
        Snapshot {
            users: state.users.values().cloned().collect(),
            servers: state.servers.values().cloned().collect(),
            channels: state.channels.values().cloned().collect(),
            members: state
                .members
                .iter()
                .map(|(server, members)| {
                    (
                        server.clone(),
                        members.values().cloned().collect::<Vec<_>>(),
                    )
                })
                .collect(),
            emojis: state.emojis.values().cloned().collect(),
            me: state
                .me
                .as_ref()
                .and_then(|id| state.users.get(id))
                .cloned(),
            unreads: state.unreads.clone(),
        }
    }

    /// Отметить канал прочитанным до сообщения `message` включительно.
    ///
    /// Вызывается сразу после успешного `PUT /ack`, не дожидаясь, пока шлюз
    /// пришлёт `ChannelAck`: иначе повторное открытие клиента до прихода
    /// события снова показало бы канал непрочитанным.
    pub async fn mark_read(&self, channel: &str, message: &str) {
        let mut state = self.state.write().await;
        mark_read(&mut state, channel, message);
        drop(state);
        self.publish(CacheEvent::ChannelChanged(channel.to_string()));
    }

    /// Поставить отметку прочитанного ровно на `message` — «Пометить как
    /// непрочитанное»: всё, что после него, снова считается новым.
    pub async fn mark_unread(&self, channel: &str, message: &str) {
        let mut state = self.state.write().await;
        set_read(&mut state, channel, message);
        drop(state);
        self.publish(CacheEvent::ChannelChanged(channel.to_string()));
    }

    /// Пользователь по id.
    pub async fn user(&self, id: &str) -> Option<v0::User> {
        self.state.read().await.users.get(id).cloned()
    }

    /// Канал по id.
    pub async fn channel(&self, id: &str) -> Option<v0::Channel> {
        self.state.read().await.channels.get(id).cloned()
    }

    /// Эмодзи серверов, известные кэшу: из `Ready` и событий шлюза.
    pub async fn emojis(&self) -> Vec<v0::Emoji> {
        self.state.read().await.emojis.values().cloned().collect()
    }

    /// Сервер по id.
    pub async fn server(&self, id: &str) -> Option<v0::Server> {
        self.state.read().await.servers.get(id).cloned()
    }

    /// Размеры кэша.
    pub async fn stats(&self) -> CacheStats {
        let state = self.state.read().await;
        CacheStats {
            users: state.users.len(),
            servers: state.servers.len(),
            channels: state.channels.len(),
            members: state.members.values().map(HashMap::len).sum(),
            emojis: state.emojis.len(),
            messages: state.messages.values().map(BTreeMap::len).sum(),
            message_channels: state.message_channels.len(),
        }
    }

    /// Сообщения канала, отсортированные по id (id в Stoat — ULID, растёт со временем).
    pub async fn messages(&self, channel: &str) -> Vec<v0::Message> {
        let state = self.state.read().await;
        state
            .messages
            .get(channel)
            .map(|map| map.values().cloned().collect())
            .unwrap_or_default()
    }

    /// Id текущего пользователя.
    pub async fn me_id(&self) -> Option<String> {
        self.state.read().await.me.clone()
    }

    /// Участник сервера: нужен для ролей и цвета ника.
    pub async fn member(&self, server: &str, user: &str) -> Option<v0::Member> {
        let state = self.state.read().await;
        state
            .members
            .get(server)
            .and_then(|map| map.get(user))
            .cloned()
    }

    /// Все участники сервера.
    pub async fn members(&self, server: &str) -> Vec<v0::Member> {
        self.state
            .read()
            .await
            .members
            .get(server)
            .map(|map| map.values().cloned().collect())
            .unwrap_or_default()
    }

    /// Id сервера, которому принадлежит канал (для правой панели и ролей).
    pub async fn server_of_channel(&self, channel: &str) -> Option<String> {
        let state = self.state.read().await;
        let channel = state.channels.get(channel)?;
        match channel {
            v0::Channel::TextChannel { server, .. } => Some(server.clone()),
            // голосовые каналы в модели тоже TextChannel (с полем voice)
            _ => None,
        }
    }

    /// Сколько серверов принадлежит текущему пользователю: пока они есть,
    /// аккаунт нельзя удалить.
    pub async fn owned_servers(&self) -> usize {
        let state = self.state.read().await;
        let Some(me) = state.me.as_deref() else {
            return 0;
        };
        state
            .servers
            .values()
            .filter(|server| server.owner == me)
            .count()
    }

    /// Есть ли сервер в кэше.
    pub async fn has_server(&self, id: &str) -> bool {
        let state = self.state.read().await;
        state.servers.contains_key(id)
    }

    /// Кто сейчас печатает в канале.
    pub async fn typers(&self, channel: &str) -> Vec<String> {
        let state = self.state.read().await;
        state
            .typing
            .get(channel)
            .map(|set| set.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Полностью очистить кэш (выход из аккаунта).
    pub async fn clear(&self) {
        let mut state = self.state.write().await;
        *state = State::default();
        drop(state);
        self.publish(CacheEvent::Cleared);
    }
}

impl Default for Cache {
    fn default() -> Self {
        Self::new()
    }
}

/// Id канала независимо от варианта [`v0::Channel`].
pub fn channel_id(channel: &v0::Channel) -> &str {
    use v0::Channel::*;
    match channel {
        SavedMessages { id, .. }
        | DirectMessage { id, .. }
        | Group { id, .. }
        | TextChannel { id, .. } => id,
    }
}

/// Запомнить последнее сообщение канала.
fn set_last_message(channel: &mut v0::Channel, message: &str) {
    use v0::Channel::*;
    match channel {
        DirectMessage {
            last_message_id, ..
        }
        | Group {
            last_message_id, ..
        }
        | TextChannel {
            last_message_id, ..
        } => {
            // события могут прийти не по порядку: назад не откатываемся
            if last_message_id.as_deref() < Some(message) {
                *last_message_id = Some(message.to_string());
            }
        }
        SavedMessages { .. } => {}
    }
}

/// Сдвинуть отметку о прочтении канала вперёд.
fn mark_read(state: &mut State, channel: &str, message: &str) {
    let unread = state.unreads.entry(channel.to_string()).or_default();
    if unread.last_id.as_deref() < Some(message) {
        unread.last_id = Some(message.to_string());
    }
    unread.mentions.retain(|id| id.as_str() > message);
}

/// Отметка прочитанного как есть, даже назад: так её ставит сервер,
/// когда сообщение пометили непрочитанным (здесь или в другом клиенте).
fn set_read(state: &mut State, channel: &str, message: &str) {
    let unread = state.unreads.entry(channel.to_string()).or_default();
    unread.last_id = Some(message.to_string());
    unread.mentions.retain(|id| id.as_str() > message);
}

/// Сообщение из кэша, если оно там есть.
fn cached_message<'a>(
    state: &'a mut State,
    channel: &str,
    id: &str,
) -> Option<&'a mut v0::Message> {
    state
        .messages
        .get_mut(channel)
        .and_then(|map| map.get_mut(id))
}

fn apply_event(state: &mut State, event: GatewayEvent, emitted: &mut Vec<CacheEvent>) {
    match event {
        GatewayEvent::Message(message) => {
            let channel = message.channel.clone();
            let id = message.id.clone();
            // по `last_message_id` интерфейс решает, есть ли в канале новое
            if let Some(existing) = state.channels.get_mut(&channel) {
                set_last_message(existing, &id);
            }
            // своё сообщение прочитано сразу
            if state.me.as_deref() == Some(message.author.as_str()) {
                mark_read(state, &channel, &id);
            }
            state.store_message(*message);
            emitted.push(CacheEvent::MessageChanged {
                channel,
                message: id,
            });
        }
        GatewayEvent::MessageUpdate { id, channel, data } => {
            if let Some(existing) = state
                .messages
                .get_mut(&channel)
                .and_then(|map| map.get_mut(&id))
            {
                merge_message(existing, &data);
                emitted.push(CacheEvent::MessageChanged {
                    channel,
                    message: id,
                });
            }
        }
        GatewayEvent::MessageAppend {
            id,
            channel,
            append,
        } => {
            if let Some(existing) = state
                .messages
                .get_mut(&channel)
                .and_then(|map| map.get_mut(&id))
            {
                if let Some(embeds) = append
                    .get("embeds")
                    .and_then(|value| serde_json::from_value(value.clone()).ok())
                {
                    existing.embeds = Some(embeds);
                }
                emitted.push(CacheEvent::MessageChanged {
                    channel,
                    message: id,
                });
            }
        }
        GatewayEvent::MessageDelete { id, channel } => {
            if let Some(map) = state.messages.get_mut(&channel) {
                map.remove(&id);
            }
            emitted.push(CacheEvent::MessageRemoved {
                channel,
                message: id,
            });
        }
        GatewayEvent::ChannelCreate(channel) => {
            let id = channel_id(&channel).to_string();
            state.channels.insert(id.clone(), *channel);
            emitted.push(CacheEvent::ChannelChanged(id));
        }
        GatewayEvent::ChannelUpdate { id, data, clear } => {
            if let Some(existing) = state.channels.get_mut(&id) {
                merge_channel(existing, &data, &clear);
                emitted.push(CacheEvent::ChannelChanged(id));
            }
        }
        GatewayEvent::ChannelGroupJoin { id, user } => {
            // как `recipientIds.add` в stoat.js
            if let Some(v0::Channel::Group { recipients, .. }) = state.channels.get_mut(&id)
                && !recipients.contains(&user)
            {
                recipients.push(user);
                emitted.push(CacheEvent::ChannelChanged(id));
            }
        }
        GatewayEvent::ChannelGroupLeave { id, user } => {
            if let Some(v0::Channel::Group { recipients, .. }) = state.channels.get_mut(&id)
                && let Some(index) = recipients.iter().position(|item| *item == user)
            {
                recipients.remove(index);
                emitted.push(CacheEvent::ChannelChanged(id));
            }
        }
        GatewayEvent::ChannelDelete { id } => {
            state.channels.remove(&id);
            state.forget_channel(&id);
            emitted.push(CacheEvent::ChannelRemoved(id));
        }
        GatewayEvent::ChannelStartTyping { id, user } => {
            state
                .typing
                .entry(id.clone())
                .or_default()
                .insert(user.clone());
            emitted.push(CacheEvent::Typing {
                channel: id,
                user,
                active: true,
            });
        }
        GatewayEvent::ChannelStopTyping { id, user } => {
            if let Some(set) = state.typing.get_mut(&id) {
                set.remove(&user);
            }
            emitted.push(CacheEvent::Typing {
                channel: id,
                user,
                active: false,
            });
        }
        GatewayEvent::ServerCreate(server) => {
            let id = server.id.clone();
            state.servers.insert(id.clone(), *server);
            emitted.push(CacheEvent::ServerChanged(id));
        }
        GatewayEvent::ServerUpdate { id, data, .. } => {
            if let Some(existing) = state.servers.get_mut(&id) {
                if let Some(name) = data.get("name").and_then(|v| v.as_str()) {
                    existing.name = name.to_string();
                }
                if let Some(description) = data.get("description").and_then(|v| v.as_str()) {
                    existing.description = Some(description.to_string());
                }
                emitted.push(CacheEvent::ServerChanged(id));
            }
        }
        GatewayEvent::ServerDelete { id } => {
            state.servers.remove(&id);
            state.members.remove(&id);
            emitted.push(CacheEvent::ServerRemoved(id));
        }
        GatewayEvent::ServerMemberJoin { id, user } => {
            let member = state
                .members
                .entry(id.clone())
                .or_default()
                .entry(user.clone())
                .or_insert_with(|| v0::Member {
                    id: v0::MemberCompositeKey {
                        server: id.clone(),
                        user: user.clone(),
                    },
                    joined_at: iso8601_now(),
                    nickname: None,
                    pronouns: None,
                    avatar: None,
                    roles: Vec::new(),
                    timeout: None,
                    can_publish: true,
                    can_receive: true,
                });
            let _ = member;
            emitted.push(CacheEvent::UserChanged(user));
        }
        GatewayEvent::ServerMemberLeave { id, user, .. } => {
            if let Some(members) = state.members.get_mut(&id) {
                members.remove(&user);
            }
            emitted.push(CacheEvent::UserRemoved(user));
        }
        GatewayEvent::ServerMemberUpdate {
            id,
            user,
            data,
            clear,
        } => {
            if let Some(member) = state
                .members
                .get_mut(&id)
                .and_then(|members| members.get_mut(&user))
            {
                if let Some(nickname) = data.get("nickname").and_then(|v| v.as_str()) {
                    member.nickname = Some(nickname.to_string());
                }
                if clear.iter().any(|field| field == "Nickname") {
                    member.nickname = None;
                }
                emitted.push(CacheEvent::UserChanged(user));
            }
        }
        GatewayEvent::UserUpdate {
            id,
            data,
            clear,
            online,
        } => {
            if let Some(user) = state.users.get_mut(&id) {
                // сначала очищаем поля, затем применяем новые значения — так же,
                // как это делает браузерный клиент
                for field in &clear {
                    match field.as_str() {
                        "Avatar" => user.avatar = None,
                        "DisplayName" => user.display_name = None,
                        "StatusText" => {
                            if let Some(status) = user.status.as_mut() {
                                status.text = None;
                            }
                        }
                        "StatusPresence" => {
                            if let Some(status) = user.status.as_mut() {
                                status.presence = None;
                            }
                        }
                        _ => {}
                    }
                }
                // присутствие приходит в `data.online`, старые серверы — рядом с `data`
                if let Some(online) = data.get("online").and_then(|v| v.as_bool()).or(online) {
                    user.online = online;
                }
                if let Some(display_name) = data.get("display_name").and_then(|v| v.as_str()) {
                    user.display_name = Some(display_name.to_string());
                }
                if let Some(avatar) = data.get("avatar") {
                    user.avatar = if avatar.is_null() {
                        None
                    } else {
                        serde_json::from_value(avatar.clone()).ok()
                    };
                }
                if let Some(status) = data
                    .get("status")
                    .and_then(|value| serde_json::from_value(value.clone()).ok())
                {
                    user.status = Some(status);
                }
                emitted.push(CacheEvent::UserChanged(id));
            }
        }
        GatewayEvent::UserRelationship {
            id: _,
            user,
            status,
        } => {
            let user_id = user.id.clone();
            let mut user = user;
            // страница «Друзья» читает `relationship`, а не список связей
            user.relationship = status.clone();
            user.relations = vec![v0::Relationship {
                user_id: user_id.clone(),
                status,
            }];
            state.users.insert(user_id.clone(), *user);
            emitted.push(CacheEvent::UserChanged(user_id));
        }
        GatewayEvent::ChannelAck { id, message_id, .. } => {
            set_read(state, &id, &message_id);
            emitted.push(CacheEvent::ChannelChanged(id));
        }
        // реакции приходят по одной; порядок эмодзи сохраняется, как на сервере
        GatewayEvent::MessageReact {
            id,
            channel_id,
            user_id,
            emoji_id,
        } => {
            if let Some(message) = cached_message(state, &channel_id, &id) {
                message
                    .reactions
                    .entry(emoji_id)
                    .or_default()
                    .insert(user_id);
                emitted.push(CacheEvent::MessageChanged {
                    channel: channel_id,
                    message: id,
                });
            }
        }
        GatewayEvent::MessageUnreact {
            id,
            channel_id,
            user_id,
            emoji_id,
        } => {
            if let Some(message) = cached_message(state, &channel_id, &id) {
                if let Some(users) = message.reactions.get_mut(&emoji_id) {
                    users.shift_remove(&user_id);
                    if users.is_empty() {
                        message.reactions.shift_remove(&emoji_id);
                    }
                }
                emitted.push(CacheEvent::MessageChanged {
                    channel: channel_id,
                    message: id,
                });
            }
        }
        GatewayEvent::MessageRemoveReaction {
            id,
            channel_id,
            emoji_id,
        } => {
            if let Some(message) = cached_message(state, &channel_id, &id) {
                message.reactions.shift_remove(&emoji_id);
                emitted.push(CacheEvent::MessageChanged {
                    channel: channel_id,
                    message: id,
                });
            }
        }
        GatewayEvent::EmojiCreate(emoji) => {
            if let v0::EmojiParent::Server { id } = &emoji.parent {
                emitted.push(CacheEvent::ServerChanged(id.clone()));
            }
            state.emojis.insert(emoji.id.clone(), *emoji);
        }
        GatewayEvent::EmojiDelete { id } => {
            if let Some(v0::Emoji {
                parent: v0::EmojiParent::Server { id: server },
                ..
            }) = state.emojis.remove(&id)
            {
                emitted.push(CacheEvent::ServerChanged(server));
            }
        }
        GatewayEvent::UserSettingsUpdate { .. } => {}
        GatewayEvent::Authenticated
        | GatewayEvent::Ready(_)
        | GatewayEvent::Error(_)
        | GatewayEvent::Logout
        | GatewayEvent::Pong { .. }
        | GatewayEvent::ServerRoleUpdate { .. }
        | GatewayEvent::ServerRoleDelete { .. }
        | GatewayEvent::Unknown => {}
    }
}

fn merge_message(message: &mut v0::Message, data: &serde_json::Value) {
    if let Some(content) = data.get("content").and_then(|v| v.as_str()) {
        message.content = Some(content.to_string());
    }
    if let Some(timestamp) = data
        .get("edited")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
    {
        message.edited = Some(timestamp);
    }
    if let Some(pinned) = data.get("pinned").and_then(|v| v.as_bool()) {
        message.pinned = Some(pinned);
    }
    if let Some(embeds) = data
        .get("embeds")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
    {
        message.embeds = Some(embeds);
    }
    if let Some(reactions) = data
        .get("reactions")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
    {
        message.reactions = reactions;
    }
}

fn merge_channel(channel: &mut v0::Channel, data: &serde_json::Value, clear: &[String]) {
    use v0::Channel::*;
    match channel {
        Group {
            name, description, ..
        } => {
            if let Some(new_name) = data.get("name").and_then(|v| v.as_str()) {
                *name = new_name.to_string();
            }
            if let Some(new_description) = data.get("description").and_then(|v| v.as_str()) {
                *description = Some(new_description.to_string());
            }
            if clear.iter().any(|field| field == "Description") {
                *description = None;
            }
        }
        TextChannel {
            name, description, ..
        } => {
            if let Some(new_name) = data.get("name").and_then(|v| v.as_str()) {
                *name = new_name.to_string();
            }
            if let Some(new_description) = data.get("description").and_then(|v| v.as_str()) {
                *description = Some(new_description.to_string());
            }
            if clear.iter().any(|field| field == "Description") {
                *description = None;
            }
        }
        DirectMessage { .. } | SavedMessages { .. } => {}
    }
}

fn iso8601_now() -> iso8601_timestamp::Timestamp {
    iso8601_timestamp::Timestamp::now_utc()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message(id: &str, channel: &str, content: &str) -> v0::Message {
        serde_json::from_value(json!({
            "_id": id,
            "channel": channel,
            "author": "01AUTHOR",
            "content": content
        }))
        .unwrap()
    }

    #[test]
    fn unread_compares_message_ids() {
        let read = Unread {
            last_id: Some("01B".into()),
            mentions: Vec::new(),
        };
        assert!(!Unread::is_behind(Some(&read), Some("01B")));
        assert!(!Unread::is_behind(Some(&read), Some("01A")));
        assert!(Unread::is_behind(Some(&read), Some("01C")));
        assert!(Unread::is_behind(None, Some("01A")));
        assert!(!Unread::is_behind(None, None));
    }

    #[tokio::test]
    async fn emoji_events_update_cache() {
        let cache = Cache::new();
        let event: GatewayEvent = serde_json::from_value(json!({
            "type": "EmojiCreate",
            "_id": "01EMOJI",
            "parent": { "type": "Server", "id": "s1" },
            "creator_id": "01USER",
            "name": "spider"
        }))
        .unwrap();
        let emitted = cache.apply(event).await;
        assert_eq!(emitted, vec![CacheEvent::ServerChanged("s1".into())]);
        assert_eq!(cache.emojis().await.len(), 1);

        let emitted = cache
            .apply(GatewayEvent::EmojiDelete {
                id: "01EMOJI".into(),
            })
            .await;
        assert_eq!(emitted, vec![CacheEvent::ServerChanged("s1".into())]);
        assert!(cache.emojis().await.is_empty());
    }

    #[tokio::test]
    async fn ack_moves_read_marker_forward_only() {
        let cache = Cache::new();
        cache
            .apply(GatewayEvent::ChannelAck {
                id: "c1".into(),
                user: "me".into(),
                message_id: "01B".into(),
            })
            .await;
        cache.mark_read("c1", "01A").await;

        let snapshot = cache.snapshot().await;
        assert_eq!(snapshot.unreads["c1"].last_id.as_deref(), Some("01B"));
    }

    #[tokio::test]
    async fn ack_from_server_can_move_marker_back() {
        let cache = Cache::new();
        cache.mark_read("c1", "01C").await;
        // «Пометить как непрочитанное» в другом клиенте
        cache
            .apply(GatewayEvent::ChannelAck {
                id: "c1".into(),
                user: "me".into(),
                message_id: "01A".into(),
            })
            .await;
        let snapshot = cache.snapshot().await;
        assert_eq!(snapshot.unreads["c1"].last_id.as_deref(), Some("01A"));

        cache.mark_unread("c1", "01B").await;
        let snapshot = cache.snapshot().await;
        assert_eq!(snapshot.unreads["c1"].last_id.as_deref(), Some("01B"));
    }

    #[tokio::test]
    async fn reactions_are_tracked_in_order() {
        let cache = Cache::new();
        cache
            .apply(GatewayEvent::Message(Box::new(message("01A", "c1", "hi"))))
            .await;
        let react = |user: &str, emoji: &str| GatewayEvent::MessageReact {
            id: "01A".into(),
            channel_id: "c1".into(),
            user_id: user.into(),
            emoji_id: emoji.into(),
        };
        cache.apply(react("u1", "👍")).await;
        cache.apply(react("u2", "👍")).await;
        let emitted = cache.apply(react("u1", "🎉")).await;
        assert_eq!(
            emitted,
            vec![CacheEvent::MessageChanged {
                channel: "c1".into(),
                message: "01A".into()
            }]
        );

        let reactions = |messages: Vec<v0::Message>| {
            messages[0]
                .reactions
                .iter()
                .map(|(emoji, users)| (emoji.clone(), users.iter().cloned().collect::<Vec<_>>()))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            reactions(cache.messages("c1").await),
            vec![
                ("👍".to_string(), vec!["u1".to_string(), "u2".to_string()]),
                ("🎉".to_string(), vec!["u1".to_string()]),
            ]
        );

        // последний снявший реакцию убирает и сам эмодзи
        cache
            .apply(GatewayEvent::MessageUnreact {
                id: "01A".into(),
                channel_id: "c1".into(),
                user_id: "u1".into(),
                emoji_id: "🎉".into(),
            })
            .await;
        cache
            .apply(GatewayEvent::MessageRemoveReaction {
                id: "01A".into(),
                channel_id: "c1".into(),
                emoji_id: "👍".into(),
            })
            .await;
        assert!(cache.messages("c1").await[0].reactions.is_empty());

        // реакция на сообщение вне кэша ничего не объявляет
        let unknown = GatewayEvent::MessageReact {
            id: "01Z".into(),
            channel_id: "c2".into(),
            user_id: "u1".into(),
            emoji_id: "👍".into(),
        };
        assert!(cache.apply(unknown).await.is_empty());
    }

    #[tokio::test]
    async fn new_message_updates_channel_last_message() {
        let cache = Cache::new();
        let channel: v0::Channel = serde_json::from_value(json!({
            "channel_type": "TextChannel",
            "_id": "c1",
            "server": "s1",
            "name": "general"
        }))
        .unwrap();
        cache.insert_channel(channel).await;
        cache
            .apply(GatewayEvent::Message(Box::new(message("01C", "c1", "hi"))))
            .await;

        let snapshot = cache.snapshot().await;
        match &snapshot.channels[0] {
            v0::Channel::TextChannel {
                last_message_id, ..
            } => assert_eq!(last_message_id.as_deref(), Some("01C")),
            other => panic!("не тот канал: {other:?}"),
        }
        // чужое сообщение не отмечает канал прочитанным
        assert!(Unread::is_behind(snapshot.unreads.get("c1"), Some("01C")));
    }

    #[tokio::test]
    async fn group_join_and_leave_update_recipients() {
        let cache = Cache::new();
        let channel: v0::Channel = serde_json::from_value(json!({
            "channel_type": "Group",
            "_id": "g1",
            "name": "friends",
            "owner": "u1",
            "recipients": ["u1", "u2"]
        }))
        .unwrap();
        cache.insert_channel(channel).await;
        let recipients = |snapshot: Snapshot| match &snapshot.channels[0] {
            v0::Channel::Group { recipients, .. } => recipients.clone(),
            other => panic!("не тот канал: {other:?}"),
        };

        let join = |user: &str| GatewayEvent::ChannelGroupJoin {
            id: "g1".into(),
            user: user.into(),
        };
        cache.apply(join("u3")).await;
        // повторное событие не дублирует участника
        cache.apply(join("u3")).await;
        assert_eq!(recipients(cache.snapshot().await), ["u1", "u2", "u3"]);

        cache
            .apply(GatewayEvent::ChannelGroupLeave {
                id: "g1".into(),
                user: "u2".into(),
            })
            .await;
        assert_eq!(recipients(cache.snapshot().await), ["u1", "u3"]);
    }

    #[tokio::test]
    async fn new_messages_are_stored_and_announced() {
        let cache = Cache::new();
        let mut events = cache.subscribe();

        cache
            .apply(GatewayEvent::Message(Box::new(message("01A", "c1", "hi"))))
            .await;

        assert_eq!(cache.messages("c1").await.len(), 1);
        let event = events.recv().await.unwrap();
        assert_eq!(
            event,
            CacheEvent::MessageChanged {
                channel: "c1".into(),
                message: "01A".into()
            }
        );
    }

    #[tokio::test]
    async fn update_merges_partial_data() {
        let cache = Cache::new();
        cache
            .apply(GatewayEvent::Message(Box::new(message("01A", "c1", "hi"))))
            .await;

        cache
            .apply(GatewayEvent::MessageUpdate {
                id: "01A".into(),
                channel: "c1".into(),
                data: json!({ "content": "исправлено" }),
            })
            .await;

        let messages = cache.messages("c1").await;
        assert_eq!(messages[0].content.as_deref(), Some("исправлено"));
    }

    #[tokio::test]
    async fn delete_removes_message() {
        let cache = Cache::new();
        cache
            .apply(GatewayEvent::Message(Box::new(message("01A", "c1", "hi"))))
            .await;
        cache
            .apply(GatewayEvent::MessageDelete {
                id: "01A".into(),
                channel: "c1".into(),
            })
            .await;

        assert!(cache.messages("c1").await.is_empty());
    }

    #[tokio::test]
    async fn message_cache_is_bounded() {
        let cache = Cache::new();
        // в одном канале остаются только последние сообщения
        for index in 0..MESSAGES_PER_CHANNEL + 50 {
            cache
                .insert_message_no_event(message(&format!("01{index:06}"), "c1", "текст"))
                .await;
        }
        let kept = cache.messages("c1").await;
        assert_eq!(kept.len(), MESSAGES_PER_CHANNEL);
        assert_eq!(kept[0].id, "01000050");

        // давно не тронутые каналы выгружаются целиком
        for channel in 0..MESSAGE_CHANNELS {
            cache
                .insert_message_no_event(message("01A", &format!("other{channel}"), "текст"))
                .await;
        }
        assert!(cache.messages("c1").await.is_empty());
        assert_eq!(cache.messages("other0").await.len(), 1);

        // удалённый канал забывается и не занимает место в очереди
        cache
            .apply(GatewayEvent::ChannelDelete {
                id: "other0".into(),
            })
            .await;
        assert!(cache.messages("other0").await.is_empty());
        assert_eq!(
            cache.state.read().await.message_channels.len(),
            MESSAGE_CHANNELS - 1
        );
        let stats = cache.stats().await;
        assert_eq!(stats.message_channels, MESSAGE_CHANNELS - 1);
        assert_eq!(stats.messages, MESSAGE_CHANNELS - 1);
    }

    #[tokio::test]
    async fn messages_are_sorted_by_ulid() {
        let cache = Cache::new();
        for (id, text) in [("01B", "второе"), ("01A", "первое")] {
            cache
                .apply(GatewayEvent::Message(Box::new(message(id, "c1", text))))
                .await;
        }

        let ids: Vec<String> = cache
            .messages("c1")
            .await
            .into_iter()
            .map(|m| m.id)
            .collect();
        assert_eq!(ids, vec!["01A".to_string(), "01B".to_string()]);
    }

    #[tokio::test]
    async fn typing_state_tracks_start_and_stop() {
        let cache = Cache::new();
        cache
            .apply(GatewayEvent::ChannelStartTyping {
                id: "c1".into(),
                user: "u1".into(),
            })
            .await;
        assert_eq!(cache.typers("c1").await, vec!["u1".to_string()]);

        cache
            .apply(GatewayEvent::ChannelStopTyping {
                id: "c1".into(),
                user: "u1".into(),
            })
            .await;
        assert!(cache.typers("c1").await.is_empty());
    }

    #[tokio::test]
    async fn channel_update_merges_and_clears_fields() {
        let cache = Cache::new();
        let channel: v0::Channel = serde_json::from_value(json!({
            "_id": "c1",
            "channel_type": "TextChannel",
            "server": "s1",
            "name": "general",
            "description": "старое"
        }))
        .unwrap();
        cache.insert_channel(channel).await;

        cache
            .apply(GatewayEvent::ChannelUpdate {
                id: "c1".into(),
                data: json!({ "name": "renamed" }),
                clear: vec!["Description".into()],
            })
            .await;

        let channel = cache.channel("c1").await.unwrap();
        match channel {
            v0::Channel::TextChannel {
                name, description, ..
            } => {
                assert_eq!(name, "renamed");
                assert_eq!(description, None);
            }
            other => panic!("ожидали TextChannel, получили {other:?}"),
        }
    }

    #[tokio::test]
    async fn user_update_clears_and_sets_fields() {
        let cache = Cache::new();
        let user: v0::User = serde_json::from_value(json!({
            "_id": "u1",
            "username": "bob",
            "discriminator": "0001",
            "display_name": "Боб",
            "status": { "text": "занят", "presence": "Busy" },
            "relationship": "None",
            "online": false
        }))
        .unwrap();
        cache.insert_user(user).await;
        cache
            .apply(GatewayEvent::UserUpdate {
                id: "u1".into(),
                data: json!({ "online": true }),
                clear: vec!["StatusText".into(), "DisplayName".into()],
                online: None,
            })
            .await;

        let user = cache.user("u1").await.unwrap();
        assert!(user.online);
        assert_eq!(user.display_name, None);
        let status = user.status.unwrap();
        assert_eq!(status.text, None);
        assert!(status.presence.is_some());
    }

    #[tokio::test]
    async fn clear_wipes_everything() {
        let cache = Cache::new();
        cache
            .apply(GatewayEvent::Message(Box::new(message("01A", "c1", "hi"))))
            .await;
        cache.clear().await;

        assert!(cache.messages("c1").await.is_empty());
        assert!(cache.snapshot().await.users.is_empty());
    }
}

//! Представления для интерфейса.
//!
//! UI не разбирает модели Stoat напрямую: здесь они превращаются в плоские
//! структуры, которые удобно рисовать. Модуль сознательно не зависит от Tauri,
//! поэтому его поведение проверяется тестами без сборки GUI.

use std::collections::HashMap;

use revolt_models::v0;
use serde::{Deserialize, Serialize};
use stoat_core::cache::{Snapshot, Unread, channel_id as id_of};

/// Эмодзи сервера в том виде, который удобен UI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EmojiView {
    /// Id файла эмодзи на CDN
    pub id: String,
    /// Имя, которое набирают в сообщении: `:имя:`
    pub name: String,
    /// Готовый адрес картинки
    pub url: Option<String>,
    /// Анимированный (gif/apng)
    pub animated: bool,
}

impl EmojiView {
    /// Собрать эмодзи из ответа API `/servers/{id}/emojis`.
    pub fn build(emoji: &v0::Emoji, cdn: Option<&str>) -> Self {
        let base = cdn.map(|base| base.trim_end_matches('/').to_string());
        Self {
            id: emoji.id.clone(),
            name: emoji.name.clone(),
            url: base.map(|base| format!("{base}/emojis/{}", emoji.id)),
            animated: emoji.animated,
        }
    }
}

/// Пользователь в том виде, который удобен UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserView {
    /// Id
    pub id: String,
    /// Ник
    pub username: String,
    /// Дискриминатор
    pub discriminator: String,
    /// Отображаемое имя
    pub display_name: Option<String>,
    /// Аватар (есть, только если представление собрано через [`UserView::build`])
    #[serde(default)]
    pub avatar: Option<String>,
    /// Присутствие: `Online`, `Idle`, `Focus`, `Busy`, `Offline`
    #[serde(default)]
    pub presence: String,
    /// Текст статуса
    #[serde(default)]
    pub status: Option<String>,
}

/// Присутствие пользователя так, как его показывает браузерный клиент.
///
/// Невидимый пользователь для остальных выглядит как не в сети.
pub fn presence_of(user: &v0::User) -> &'static str {
    if !user.online {
        return "Offline";
    }
    match user
        .status
        .as_ref()
        .and_then(|status| status.presence.as_ref())
    {
        Some(v0::Presence::Idle) => "Idle",
        Some(v0::Presence::Focus) => "Focus",
        Some(v0::Presence::Busy) => "Busy",
        Some(v0::Presence::Invisible) => "Offline",
        Some(v0::Presence::Online) | None => "Online",
    }
}

/// Текст статуса пользователя, если он задан.
pub fn status_text(user: &v0::User) -> Option<String> {
    user.status
        .as_ref()
        .and_then(|status| status.text.clone())
        .filter(|text| !text.trim().is_empty())
}

/// Роли сервера от старшей к младшей.
///
/// В Stoat у старшей роли **меньший** `rank` («Smaller values take
/// priority»), роли участника приходят списком id без порядка.
fn ordered_roles<'a>(
    roles: &[String],
    server_roles: &'a HashMap<String, v0::Role>,
) -> Vec<&'a v0::Role> {
    let mut list: Vec<&v0::Role> = roles.iter().filter_map(|id| server_roles.get(id)).collect();
    list.sort_by_key(|role| role.rank);
    list
}

/// Цвет роли участника.
///
/// Ник красится цветом старшей роли, у которой цвет задан, а не первой
/// попавшейся.
pub fn role_colour(roles: &[String], server_roles: &HashMap<String, v0::Role>) -> Option<String> {
    ordered_roles(roles, server_roles)
        .into_iter()
        .find_map(|role| role.colour.clone())
}

/// Роль, под которой участник показывается в правой панели.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HoistView {
    /// Id роли
    pub id: String,
    /// Название роли
    pub name: String,
    /// Позиция роли: чем меньше, тем выше группа
    pub rank: i64,
}

/// Участник сервера в том виде, который нужен интерфейсу.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemberView {
    /// Id пользователя
    pub id: String,
    /// Имя: ник на сервере, иначе имя профиля
    pub name: String,
    /// Имя пользователя без серверного ника
    pub username: String,
    /// Аватар: свой у участника или из профиля
    pub avatar: Option<String>,
    /// Цвет ника из роли
    pub colour: Option<String>,
    /// Названия ролей сверху вниз
    pub roles: Vec<String>,
    /// В сети
    pub online: bool,
    /// Присутствие: `Online`, `Idle`, `Focus`, `Busy`, `Offline`
    pub presence: String,
    /// Текст статуса
    pub status: Option<String>,
    /// Старшая роль с флагом `hoist`: по ней участник попадает в группу
    pub hoist: Option<HoistView>,
}

impl UserView {
    /// Имя для показа: отображаемое, иначе имя пользователя.
    ///
    /// Дискриминатор (`#0001`) в браузерном клиенте виден только в профиле,
    /// рядом с именем в чате его нет.
    pub fn label(&self) -> String {
        self.display_name
            .clone()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| self.username.clone())
    }

    /// Представление с адресом аватара.
    pub fn build(user: v0::User, cdn: Option<&str>) -> Self {
        let avatar = user.avatar.as_ref().and_then(|file| file_url(file, cdn));
        Self {
            avatar,
            ..Self::from(user)
        }
    }
}

impl From<v0::User> for UserView {
    fn from(user: v0::User) -> Self {
        Self {
            presence: presence_of(&user).to_string(),
            status: status_text(&user),
            id: user.id,
            username: user.username,
            discriminator: user.discriminator,
            display_name: user.display_name,
            avatar: None,
        }
    }
}

// ───────────────────────────── дерево серверов ──────────────────────────────

/// Всё, что нужно для отрисовки списка серверов и каналов.
#[derive(Debug, Serialize)]
pub struct WorkspaceView {
    /// Кто вошёл
    pub me: Option<UserView>,
    /// Серверы с категориями и каналами
    pub servers: Vec<ServerView>,
    /// Личные сообщения и группы
    pub dms: Vec<ChannelView>,
    /// Канал «Заметки» (сохранённые сообщения), если он уже создан
    pub notes: Option<String>,
    /// Канал, который стоит открыть по умолчанию
    pub last_channel: Option<String>,
    /// Базовый URL файлов (аватары, вложения)
    pub cdn: Option<String>,
    /// Прокси January для сторонних картинок и видео во встраиваниях
    pub proxy: Option<String>,
    /// Друзья, заявки и заблокированные (страница «Друзья»)
    pub relationships: Vec<RelationView>,
}

/// Пользователь, с которым есть отношение: друг, заявка, блокировка.
#[derive(Debug, Serialize)]
pub struct RelationView {
    /// Пользователь (с аватаром и присутствием)
    pub user: UserView,
    /// `Friend`, `Incoming`, `Outgoing`, `Blocked`, `BlockedOther`
    pub relationship: &'static str,
}

/// Отношение так, как его пишет API; `None` — отношения нет.
fn relationship_name(status: &v0::RelationshipStatus) -> Option<&'static str> {
    match status {
        v0::RelationshipStatus::Friend => Some("Friend"),
        v0::RelationshipStatus::Incoming => Some("Incoming"),
        v0::RelationshipStatus::Outgoing => Some("Outgoing"),
        v0::RelationshipStatus::Blocked => Some("Blocked"),
        v0::RelationshipStatus::BlockedOther => Some("BlockedOther"),
        v0::RelationshipStatus::None | v0::RelationshipStatus::User => None,
    }
}

/// Порядок, который пользователь задал в браузерной версии Stoat.
///
/// Хранится в настройке `ordering` и приходит как JSON-строка.
#[derive(Debug, Default, Clone, Deserialize)]
pub struct Ordering {
    /// Порядок серверов в рельсе
    #[serde(default)]
    pub servers: Vec<String>,
    /// Свой порядок категорий: id сервера → список id категорий.
    ///
    /// Категория `default` — это каналы без категории.
    #[serde(default)]
    pub categories: HashMap<String, Vec<String>>,
}

impl Ordering {
    /// Разобрать строку из настроек; при ошибке порядок остаётся пустым.
    pub fn parse(raw: Option<&str>) -> Self {
        raw.and_then(|value| serde_json::from_str(value).ok())
            .unwrap_or_default()
    }

    /// Расставить элементы по сохранённому порядку.
    ///
    /// Всё, чего нет в настройках, идёт следом в исходном порядке — так же
    /// поступает браузерный клиент, когда список устарел.
    fn apply<T, F>(items: &mut [T], order: &[String], key: F)
    where
        F: Fn(&T) -> &str,
    {
        if order.is_empty() {
            return;
        }
        let rank = |item: &T| {
            order
                .iter()
                .position(|id| id == key(item))
                .unwrap_or(usize::MAX)
        };
        items.sort_by_key(rank);
    }
}

impl WorkspaceView {
    /// Собрать дерево с учётом пользовательского порядка.
    pub fn build_ordered(snapshot: Snapshot, cdn: Option<String>, ordering: &Ordering) -> Self {
        let channels: Vec<&v0::Channel> = snapshot.channels.iter().collect();
        let me_id = snapshot.me.as_ref().map(|user| user.id.as_str());

        let mut servers: Vec<ServerView> = snapshot
            .servers
            .iter()
            .map(|server| {
                let members = snapshot.members.get(&server.id);
                let mut view =
                    ServerView::build(server, &channels, members, ordering, cdn.as_deref());
                let mine = me_id.and_then(|id| {
                    members.and_then(|list| list.iter().find(|member| member.id.user == id))
                });
                view.owner = me_id == Some(server.owner.as_str());
                view.permissions = crate::permissions::server(server, me_id, mine);
                view
            })
            .collect();
        // порядок как в браузере: сначала серверы из настроек, затем новые
        Ordering::apply(&mut servers, &ordering.servers, |server| &server.id);
        if ordering.servers.is_empty() {
            servers.sort_by_key(|server| server.name.to_lowercase());
        }

        // права в каналах: от них зависят пункты меню сообщений
        let viewer = crate::permissions::Viewer {
            me: snapshot.me.as_ref(),
            users: &snapshot.users,
        };
        let channel_permissions = |view: &ChannelView, server: Option<&v0::Server>| {
            let source = channels.iter().find(|channel| id_of(channel) == view.id)?;
            let member = server.and_then(|server| {
                let id = me_id?;
                snapshot
                    .members
                    .get(&server.id)?
                    .iter()
                    .find(|member| member.id.user == id)
            });
            Some(crate::permissions::channel(source, &viewer, server, member))
        };

        for server in &mut servers {
            let source = snapshot.servers.iter().find(|item| item.id == server.id);
            for category in &mut server.categories {
                for channel in &mut category.channels {
                    channel.apply_unread(&snapshot.unreads);
                    channel.permissions = channel_permissions(channel, source).unwrap_or(0);
                }
            }
            let listed = server
                .categories
                .iter()
                .flat_map(|category| &category.channels);
            server.unread = listed.clone().any(|channel| channel.unread);
            server.mentions = listed.map(|channel| channel.mentions).sum();
        }

        let me = snapshot.me.as_ref().map(|user| user.id.as_str());
        // закрытые личные переписки (`active: false`) браузер не показывает
        let mut dms: Vec<ChannelView> = channels
            .iter()
            .filter(|channel| match channel {
                v0::Channel::DirectMessage { active, .. } => *active,
                v0::Channel::Group { .. } => true,
                _ => false,
            })
            .map(|channel| {
                let mut view =
                    ChannelView::build(channel, &snapshot.users, None, me, cdn.as_deref());
                view.apply_unread(&snapshot.unreads);
                view.permissions = channel_permissions(&view, None).unwrap_or(0);
                view
            })
            .collect();
        let notes = channels.iter().find_map(|channel| match channel {
            v0::Channel::SavedMessages { id, .. } => Some(id.clone()),
            _ => None,
        });
        dms.sort_by(|a, b| {
            b.last_message_id
                .cmp(&a.last_message_id)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        // по умолчанию открываем первый текстовый канал первого сервера
        let last_channel = servers
            .iter()
            .flat_map(|server| server.categories.iter())
            .flat_map(|category| category.channels.iter())
            .find(|channel| channel.kind == "text")
            .map(|channel| channel.id.clone())
            .or_else(|| dms.first().map(|channel| channel.id.clone()));

        let relationships = snapshot
            .users
            .iter()
            .filter_map(|user| {
                let relationship = relationship_name(&user.relationship)?;
                Some(RelationView {
                    user: UserView::build(user.clone(), cdn.as_deref()),
                    relationship,
                })
            })
            .collect();

        Self {
            relationships,
            me: snapshot
                .me
                .map(|user| crate::profile::own_view(user, cdn.as_deref())),
            servers,
            dms,
            notes,
            last_channel,
            cdn,
            proxy: None,
        }
    }
}

/// Сервер в том виде, в котором его рисует интерфейс.
#[derive(Debug, Serialize)]
pub struct ServerView {
    /// Id
    pub id: String,
    /// Название
    pub name: String,
    /// Первая буква имени — для «иконки»
    pub initial: String,
    /// Иконка, если она есть
    pub icon: Option<String>,
    /// Баннер: фон шапки боковой панели
    pub banner: Option<String>,
    /// Описание сервера (markdown)
    pub description: Option<String>,
    /// Значок: 1 — официальный сервер, 2 — проверенный
    pub flags: u32,
    /// Категории с каналами (в порядке сервера)
    pub categories: Vec<CategoryView>,
    /// Есть ли непрочитанное хотя бы в одном канале
    pub unread: bool,
    /// Сколько непрочитанных упоминаний во всех каналах
    pub mentions: usize,
    /// Мои права на сервере (биты API): какие пункты меню и настроек показывать
    pub permissions: u64,
    /// Я владелец сервера
    pub owner: bool,
    /// Роли от старшей к младшей: для упоминаний `<%id>` в тексте
    pub roles: Vec<RoleTag>,
}

/// Роль в том виде, в котором её показывает упоминание (`RoleMention`).
#[derive(Debug, Serialize)]
pub struct RoleTag {
    /// Id
    pub id: String,
    /// Название
    pub name: String,
    /// Цвет (CSS)
    pub colour: Option<String>,
}

impl ServerView {
    fn build(
        server: &v0::Server,
        channels: &[&v0::Channel],
        members: Option<&Vec<v0::Member>>,
        ordering: &Ordering,
        cdn: Option<&str>,
    ) -> Self {
        // только текстовые каналы этого сервера
        let own: Vec<&&v0::Channel> = channels
            .iter()
            .filter(|channel| match channel {
                v0::Channel::TextChannel { server: owner, .. } => owner == &server.id,
                _ => false,
            })
            .collect();

        let mut categories = Vec::new();
        let mut placed: Vec<String> = Vec::new();

        for category in server.categories.iter().flatten() {
            let list: Vec<ChannelView> = category
                .channels
                .iter()
                .filter_map(|channel_id| {
                    let channel = own.iter().find(|c| id_of(c) == channel_id)?;
                    placed.push(channel_id.clone());
                    Some(ChannelView::build(channel, &[], members, None, cdn))
                })
                .collect();
            if !list.is_empty() {
                categories.push(CategoryView {
                    id: category.id.clone(),
                    title: category.title.clone(),
                    channels: list,
                });
            }
        }

        // Каналы без категории: в браузере они попадают в категорию
        // `default`, и если такая категория уже есть — дополняют её,
        // иначе она идёт первой. Повторяем это поведение.
        let mut rest: Vec<ChannelView> = own
            .iter()
            .filter(|channel| !placed.contains(&id_of(channel).to_string()))
            .map(|channel| ChannelView::build(channel, &[], members, None, cdn))
            .collect();

        if !rest.is_empty() {
            if let Some(index) = categories
                .iter()
                .position(|category| category.id == "default")
            {
                categories[index].channels.append(&mut rest);
            } else {
                categories.insert(
                    0,
                    CategoryView {
                        id: "default".into(),
                        title: "Каналы".into(),
                        channels: rest,
                    },
                );
            }
        }

        // порядок категорий мог быть переставлен перетаскиванием
        if let Some(order) = ordering.categories.get(&server.id) {
            Ordering::apply(&mut categories, order, |category| &category.id);
        }

        Self {
            id: server.id.clone(),
            initial: initial_of(&server.name),
            name: server.name.clone(),
            icon: server.icon.as_ref().and_then(|file| file_url(file, cdn)),
            banner: server.banner.as_ref().and_then(|file| file_url(file, cdn)),
            description: server.description.clone(),
            flags: server.flags,
            categories,
            unread: false,
            mentions: 0,
            permissions: 0,
            owner: false,
            roles: server_roles(server),
        }
    }
}

/// Роли сервера от старшей к младшей (меньший `rank` — старше).
fn server_roles(server: &v0::Server) -> Vec<RoleTag> {
    let mut roles: Vec<&v0::Role> = server.roles.values().collect();
    roles.sort_by_key(|role| role.rank);
    roles
        .into_iter()
        .map(|role| RoleTag {
            id: role.id.clone(),
            name: role.name.clone(),
            colour: role.colour.clone(),
        })
        .collect()
}

/// Категория каналов.
#[derive(Debug, Serialize)]
pub struct CategoryView {
    /// Id
    pub id: String,
    /// Заголовок
    pub title: String,
    /// Каналы категории
    pub channels: Vec<ChannelView>,
}

/// Канал (текстовый, личные сообщения или группа).
#[derive(Debug, Serialize)]
pub struct ChannelView {
    /// Id
    pub id: String,
    /// Название, уже с учётом собеседника для ЛС
    pub name: String,
    /// `text`, `dm`, `group`, `voice`, `notes`
    pub kind: String,
    /// Описание, если есть
    pub description: Option<String>,
    /// Иконка канала: файл-картинка (в Stoat это обычный файл с тегом
    /// `icons`, код эмодзи в имени файла не хранится).
    pub icon: Option<String>,
    /// Id последнего сообщения — для сортировки ЛС
    pub last_message_id: Option<String>,
    /// Идёт ли голосовая сессия
    pub voice: bool,
    /// Собеседник в личных сообщениях
    pub recipient: Option<String>,
    /// Участники группы (для ЛС — оба собеседника)
    pub recipients: Vec<String>,
    /// Присутствие собеседника в личных сообщениях
    pub presence: Option<String>,
    /// Есть ли непрочитанные сообщения
    pub unread: bool,
    /// Сколько непрочитанных упоминаний
    pub mentions: usize,
    /// Последнее прочитанное сообщение: по нему ставится разделитель «новое»
    pub last_read: Option<String>,
    /// Мои права в канале (биты API): ответить, отреагировать, закрепить, удалить чужое
    pub permissions: u64,
}

impl ChannelView {
    /// `me` нужен для личных сообщений: собеседник — тот, кто не я.
    fn build(
        channel: &v0::Channel,
        users: &[v0::User],
        members: Option<&Vec<v0::Member>>,
        me: Option<&str>,
        cdn: Option<&str>,
    ) -> Self {
        match channel {
            v0::Channel::TextChannel {
                id,
                name,
                description,
                icon,
                last_message_id,
                voice,
                ..
            } => Self {
                id: id.clone(),
                name: name.clone(),
                kind: if voice.is_some() { "voice" } else { "text" }.into(),
                description: description.clone(),
                icon: icon.as_ref().and_then(|file| file_url(file, cdn)),
                last_message_id: last_message_id.clone(),
                voice: voice.is_some(),
                recipient: None,
                recipients: Vec::new(),
                presence: None,
                unread: false,
                mentions: 0,
                last_read: None,
                permissions: 0,
            },
            v0::Channel::DirectMessage {
                id,
                recipients,
                last_message_id,
                ..
            } => {
                let others: Vec<String> = recipients
                    .iter()
                    .filter(|recipient| Some(recipient.as_str()) != me)
                    .cloned()
                    .collect();
                let other = others
                    .first()
                    .and_then(|recipient| users.iter().find(|user| &user.id == recipient));
                Self {
                    id: id.clone(),
                    name: recipient_name(&others, users, members),
                    kind: "dm".into(),
                    description: other.and_then(status_text),
                    icon: other
                        .and_then(|user| user.avatar.as_ref())
                        .and_then(|file| file_url(file, cdn)),
                    last_message_id: last_message_id.clone(),
                    voice: false,
                    recipient: others.first().cloned(),
                    recipients: recipients.clone(),
                    presence: other.map(|user| presence_of(user).to_string()),
                    unread: false,
                    mentions: 0,
                    last_read: None,
                    permissions: 0,
                }
            }
            v0::Channel::Group {
                id,
                name,
                description,
                icon,
                last_message_id,
                recipients,
                ..
            } => Self {
                id: id.clone(),
                name: name.clone(),
                kind: "group".into(),
                description: description.clone(),
                icon: icon.as_ref().and_then(|file| file_url(file, cdn)),
                last_message_id: last_message_id.clone(),
                voice: false,
                recipient: None,
                recipients: recipients.clone(),
                presence: None,
                unread: false,
                mentions: 0,
                last_read: None,
                permissions: 0,
            },
            v0::Channel::SavedMessages { id, .. } => Self {
                id: id.clone(),
                name: "Заметки".into(),
                kind: "notes".into(),
                description: None,
                icon: None,
                last_message_id: None,
                voice: false,
                recipient: None,
                recipients: Vec::new(),
                presence: None,
                unread: false,
                mentions: 0,
                last_read: None,
                permissions: 0,
            },
        }
    }

    /// Отметить непрочитанное по отметкам из `Ready`/`ChannelAck`.
    fn apply_unread(&mut self, unreads: &HashMap<String, Unread>) {
        if self.kind == "notes" {
            return;
        }
        let unread = unreads.get(&self.id);
        self.unread = Unread::is_behind(unread, self.last_message_id.as_deref());
        self.mentions = unread.map_or(0, |unread| unread.mentions.len());
        self.last_read = unread.and_then(|unread| unread.last_id.clone());
    }
}

// ─────────────────────────────── сообщения ─────────────────────────────────

/// Сообщение, готовое к показу в чате.
#[derive(Debug, Serialize)]
pub struct ChatMessage {
    /// Id
    pub id: String,
    /// Id канала
    pub channel: String,
    /// Id автора
    pub author_id: String,
    /// Имя автора
    pub author: String,
    /// Ссылка на аватар
    pub avatar: Option<String>,
    /// Текст
    pub content: String,
    /// Время отправки, ISO-8601 (UTC)
    pub timestamp: String,
    /// Отредактировано
    pub edited: bool,
    /// Системное сообщение (вход, выход, закрепление)
    pub system: bool,
    /// Что произошло в системном сообщении: текст по нему собирает
    /// интерфейс на выбранном языке (`content` — запасной русский)
    pub system_event: Option<SystemEvent>,
    /// Файлы
    pub attachments: Vec<AttachmentView>,
    /// Эмодзи сервера из текста: код `:id:` → адрес картинки
    pub emoji: HashMap<String, String>,
    /// Ник без серверного (для подсказки)
    pub username: Option<String>,
    /// Названия ролей автора сверху вниз
    pub roles: Vec<String>,
    /// Упоминания `<@id>` из текста
    pub mentions: Vec<String>,
    /// Цвет ника из роли или маски
    pub colour: Option<String>,
    /// Встраивания: превью ссылок, картинки, видео
    pub embeds: Vec<EmbedView>,
    /// Id сообщений, на которые это сообщение отвечает
    pub replies: Vec<String>,
    /// Закреплено в канале
    pub pinned: bool,
    /// Реакции в порядке появления: эмодзи и кто поставил
    pub reactions: Vec<ReactionView>,
    /// Как с сообщением можно взаимодействовать (реакции бота)
    pub interactions: InteractionsView,
}

/// Реакция: юникод-эмодзи или id своего эмодзи (адрес — в `ChatMessage::emoji`).
#[derive(Debug, Serialize)]
pub struct ReactionView {
    /// Эмодзи
    pub emoji: String,
    /// Кто поставил
    pub users: Vec<String>,
}

/// `interactions` сообщения: реакции, которые показываются всегда, даже без
/// счётчика, и запрет на остальные.
#[derive(Debug, Default, Serialize)]
pub struct InteractionsView {
    /// Обязательные реакции
    pub reactions: Vec<String>,
    /// Ставить можно только их
    pub restrict_reactions: bool,
}

/// Собрать список участников сервера для правой панели.
///
/// Онлайн-участники идут первыми, дальше по алфавиту — как в браузерном клиенте.
pub fn members_of(
    server: &v0::Server,
    members: &[v0::Member],
    users: &HashMap<String, v0::User>,
    cdn: Option<&str>,
) -> Vec<MemberView> {
    let mut list: Vec<MemberView> = members
        .iter()
        .filter_map(|member| {
            let user = users.get(&member.id.user)?;
            let avatar = member
                .avatar
                .as_ref()
                .and_then(|file| file_url(file, cdn))
                .or_else(|| user.avatar.as_ref().and_then(|file| file_url(file, cdn)));
            // как в клиенте: сначала старшие роли
            let roles = ordered_roles(&member.roles, &server.roles);
            let hoist = roles.iter().find(|role| role.hoist).map(|role| HoistView {
                id: role.id.clone(),
                name: role.name.clone(),
                rank: role.rank,
            });
            Some(MemberView {
                id: member.id.user.clone(),
                name: user_label_with(user, Some(member)),
                username: format!("{}#{}", user.username, user.discriminator),
                avatar,
                colour: role_colour(&member.roles, &server.roles),
                roles: roles.iter().map(|role| role.name.clone()).collect(),
                online: user.online,
                presence: presence_of(user).to_string(),
                status: status_text(user),
                hoist,
            })
        })
        .collect();

    list.sort_by(|a, b| {
        b.online
            .cmp(&a.online)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    list
}

/// Участники группы (`GroupMemberSidebar`): получатели канала по имени,
/// без ролей и серверных ников.
pub fn group_members_of(users: &[v0::User], cdn: Option<&str>) -> Vec<MemberView> {
    let mut list: Vec<MemberView> = users
        .iter()
        .map(|user| MemberView {
            id: user.id.clone(),
            name: display_name(user),
            username: format!("{}#{}", user.username, user.discriminator),
            avatar: user.avatar.as_ref().and_then(|file| file_url(file, cdn)),
            colour: None,
            roles: Vec::new(),
            online: user.online,
            presence: presence_of(user).to_string(),
            status: status_text(user),
            hoist: None,
        })
        .collect();
    // как в клиенте: `recipients.toSorted((a, b) => a.displayName.localeCompare(b.displayName))`
    list.sort_by_cached_key(|member| member.name.to_lowercase());
    list
}

/// Имя пользователя с учётом серверного ника.
pub fn user_label_with(user: &v0::User, member: Option<&v0::Member>) -> String {
    member
        .and_then(|member| member.nickname.clone())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| display_name(user))
}

/// Встраиваемое содержимое сообщения.
#[derive(Debug, Serialize)]
pub struct EmbedView {
    /// `website`, `image`, `video`, `text`
    pub kind: String,
    /// Адрес
    pub url: Option<String>,
    /// Заголовок
    pub title: Option<String>,
    /// Описание
    pub description: Option<String>,
    /// Сайт
    pub site: Option<String>,
    /// Картинка предпросмотра
    pub image: Option<String>,
    /// Ширина картинки или видео
    pub width: Option<usize>,
    /// Высота картинки или видео
    pub height: Option<usize>,
    /// Видео (у видео-встраиваний и GIF с Tenor/Giphy)
    pub video: Option<String>,
    /// Это GIF: проигрывается без звука по кругу, как в браузере
    pub gif: bool,
    /// Значок сайта
    pub icon: Option<String>,
    /// Цвет полоски слева
    pub colour: Option<String>,
}

/// Сайты GIF, чьи файлы браузерный клиент показывает без прокси
/// (`common/lib/gifs.ts`).
const GIF_PROVIDERS: [&str; 3] = [
    "https://tenor.com",
    "https://giphy.com",
    "https://gifbox.me",
];

/// Адрес с одного из сайтов GIF.
fn from_gif_provider(url: Option<&str>) -> bool {
    url.is_some_and(|url| {
        GIF_PROVIDERS.iter().any(|origin| {
            url.strip_prefix(origin).is_some_and(|rest| {
                rest.is_empty() || rest.starts_with('/') || rest.starts_with('?')
            })
        })
    })
}

/// Системное сообщение для интерфейса: вид события, участники и их имена.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SystemEvent {
    /// Вид события из API: `user_joined`, `message_pinned`, …
    pub kind: &'static str,
    /// С кем произошло (имя для показа)
    pub user: Option<String>,
    /// id того, с кем произошло (для упоминания)
    pub user_id: Option<String>,
    /// Кто сделал (имя для показа)
    pub by: Option<String>,
    /// id того, кто сделал
    pub by_id: Option<String>,
    /// Закреплённое или откреплённое сообщение
    pub message_id: Option<String>,
    /// Новое название канала или текст сообщения `text`
    pub text: Option<String>,
}

/// Разобрать системное сообщение на вид события и участников.
pub fn system_event(event: &v0::SystemMessage, who: impl Fn(&str) -> String) -> SystemEvent {
    use v0::SystemMessage::*;
    let make =
        |kind, user: Option<&String>, by: Option<&String>, text: Option<&String>| SystemEvent {
            kind,
            user: user.map(|id| who(id)),
            user_id: user.cloned(),
            by: by.map(|id| who(id)),
            by_id: by.cloned(),
            message_id: None,
            text: text.cloned(),
        };
    match event {
        Text { content } => make("text", None, None, Some(content)),
        UserAdded { id, by } => make("user_added", Some(id), Some(by), None),
        UserRemove { id, by } => make("user_remove", Some(id), Some(by), None),
        UserJoined { id } => make("user_joined", Some(id), None, None),
        UserLeft { id } => make("user_left", Some(id), None, None),
        UserKicked { id } => make("user_kicked", Some(id), None, None),
        UserBanned { id } => make("user_banned", Some(id), None, None),
        ChannelRenamed { name, by } => make("channel_renamed", None, Some(by), Some(name)),
        ChannelDescriptionChanged { by } => {
            make("channel_description_changed", None, Some(by), None)
        }
        ChannelIconChanged { by } => make("channel_icon_changed", None, Some(by), None),
        ChannelOwnershipChanged { from, to } => {
            make("channel_ownership_changed", Some(to), Some(from), None)
        }
        MessagePinned { id, by } => SystemEvent {
            message_id: Some(id.clone()),
            ..make("message_pinned", None, Some(by), None)
        },
        MessageUnpinned { id, by } => SystemEvent {
            message_id: Some(id.clone()),
            ..make("message_unpinned", None, Some(by), None)
        },
        CallStarted { by, .. } => make("call_started", None, Some(by), None),
    }
}

/// Текст системного сообщения, как в браузерном клиенте.
///
/// `who` превращает id пользователя в имя для показа.
pub fn system_text(event: &v0::SystemMessage, who: impl Fn(&str) -> String) -> String {
    use v0::SystemMessage::*;
    match event {
        Text { content } => content.clone(),
        UserAdded { id, by } => format!("{} добавляет {} в группу", who(by), who(id)),
        UserRemove { id, by } => format!("{} убирает {} из группы", who(by), who(id)),
        UserJoined { id } => format!("{} присоединяется", who(id)),
        UserLeft { id } => format!("{} выходит", who(id)),
        UserKicked { id } => format!("{} исключён(а) с сервера", who(id)),
        UserBanned { id } => format!("{} заблокирован(а) на сервере", who(id)),
        ChannelRenamed { name, by } => format!("{} переименовывает канал в «{name}»", who(by)),
        ChannelDescriptionChanged { by } => format!("{} меняет описание канала", who(by)),
        ChannelIconChanged { by } => format!("{} меняет значок канала", who(by)),
        ChannelOwnershipChanged { from, to } => {
            format!("{} передаёт группу {}", who(from), who(to))
        }
        MessagePinned { by, .. } => format!("{} закрепляет сообщение", who(by)),
        MessageUnpinned { by, .. } => format!("{} открепляет сообщение", who(by)),
        CallStarted { by, .. } => format!("{} начинает звонок", who(by)),
    }
}

/// Свои эмодзи из текста: id → адрес картинки.
///
/// Браузерный клиент Stoat хранит в тексте не имя, а id эмодзи — `:ULID:`
/// (26 символов `0-9A-Z`), а картинку берёт из `{cdn}/emojis/{id}`.
pub fn custom_emojis(text: &str, cdn: Option<&str>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Some(base) = cdn.map(|base| base.trim_end_matches('/')) else {
        return out;
    };
    for (index, _) in text.match_indices(':') {
        let Some(candidate) = text.get(index + 1..index + 28) else {
            continue;
        };
        let bytes = candidate.as_bytes();
        let is_id = bytes[26] == b':'
            && bytes[..26]
                .iter()
                .all(|byte| byte.is_ascii_digit() || byte.is_ascii_uppercase());
        if is_id {
            let id = &candidate[..26];
            out.insert(id.to_string(), format!("{base}/emojis/{id}"));
        }
    }
    out
}

/// Упоминания `<@id>` из текста (в Stoat упоминание — это ULID пользователя).
pub fn mentioned_users(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (index, _) in text.match_indices("<@") {
        let rest = &text[index + 2..];
        let end = rest.find('>').unwrap_or(0);
        let candidate = &rest[..end];
        // ULID: 26 символов из алфавита base32
        if candidate.len() == 26
            && candidate
                .chars()
                .all(|symbol| symbol.is_ascii_alphanumeric())
            && !out.iter().any(|known| known == candidate)
        {
            out.push(candidate.to_string());
        }
    }
    out
}

impl ChatMessage {
    /// Собрать сообщение для показа.
    ///
    /// В моделях Stoat у сообщения нет поля времени: время закодировано в
    /// ULID-идентификаторе (первые 10 символов — миллисекунды эпохи).
    pub fn build(
        message: v0::Message,
        authors: &HashMap<String, UserView>,
        server_roles: &HashMap<String, v0::Role>,
        // ники участников сервера по id пользователя (в сообщении их часто нет)
        member_nickname: &HashMap<String, String>,
        // цвет роли участника по id пользователя
        member_colour: &HashMap<String, String>,
        cdn: Option<&str>,
    ) -> Self {
        // Порядок как в клиенте Stoat: маска сообщения важнее всего, затем
        // вебхук (у него своё имя и аватар), затем участник, затем профиль.
        let masquerade = message.masquerade.as_ref();
        let webhook = message.webhook.as_ref();

        let author = masquerade
            .and_then(|mask| mask.name.clone())
            .or_else(|| webhook.map(|hook| hook.name.clone()))
            .or_else(|| {
                message
                    .member
                    .as_ref()
                    .and_then(|member| member.nickname.clone())
                    .filter(|name| !name.trim().is_empty())
            })
            .or_else(|| message.user.as_ref().map(display_name))
            // в сообщениях из шлюза участник приходит без ника — берём из кэша
            .or_else(|| member_nickname.get(&message.author).cloned())
            .or_else(|| authors.get(&message.author).map(UserView::label))
            .unwrap_or_else(|| message.author.clone());

        // маска хранит готовый адрес, вебхук — только id файла
        let avatar = masquerade
            .and_then(|mask| mask.avatar.clone())
            .or_else(|| {
                webhook
                    .and_then(|hook| hook.avatar.as_ref())
                    .and_then(|id| webhook_avatar_url(id, cdn))
            })
            // как в браузере: аватар участника сервера важнее аватара профиля
            .or_else(|| {
                message
                    .member
                    .as_ref()
                    .and_then(|member| member.avatar.as_ref())
                    .and_then(|file| file_url(file, cdn))
            })
            .or_else(|| {
                message
                    .user
                    .as_ref()
                    .and_then(|user| user.avatar.as_ref())
                    .and_then(|file| file_url(file, cdn))
            })
            // в событиях шлюза профиля нет — берём аватар автора из кэша
            .or_else(|| {
                authors
                    .get(&message.author)
                    .and_then(|author| author.avatar.clone())
            });

        // ник без серверного — для подсказки при наведении
        let username = message
            .user
            .as_ref()
            .map(|user| format!("{}#{}", user.username, user.discriminator))
            .or_else(|| authors.get(&message.author).map(UserView::label));

        let member_roles = message.member.as_ref().map(|member| member.roles.clone());
        let roles: Vec<String> =
            ordered_roles(member_roles.as_deref().unwrap_or_default(), server_roles)
                .into_iter()
                .map(|role| role.name.clone())
                .collect();

        // маска сообщения важнее роли, иначе нику достаётся цвет главной роли
        let colour = masquerade
            .and_then(|mask| mask.colour.clone())
            .or_else(|| {
                member_roles
                    .as_ref()
                    .and_then(|member_roles| role_colour(member_roles, server_roles))
            })
            .or_else(|| member_colour.get(&message.author).cloned());
        let system = message.system.is_some();

        let attachments = message
            .attachments
            .iter()
            .flatten()
            .map(|file| AttachmentView::build(file, cdn))
            .collect();

        let embeds = message
            .embeds
            .iter()
            .flatten()
            .filter_map(EmbedView::build)
            .collect();

        // у системного сообщения нет текста: его собирает клиент
        let who = |id: &str| {
            member_nickname
                .get(id)
                .cloned()
                .or_else(|| authors.get(id).map(UserView::label))
                .unwrap_or_else(|| "Пользователь".into())
        };
        let system_event = message
            .system
            .as_ref()
            .map(|event| system_event(event, who));
        let content = match &message.system {
            Some(event) => system_text(event, who),
            None => message.content.unwrap_or_default(),
        };
        let reactions: Vec<ReactionView> = message
            .reactions
            .iter()
            .map(|(emoji, users)| ReactionView {
                emoji: emoji.clone(),
                users: users.iter().cloned().collect(),
            })
            .collect();
        let interactions = InteractionsView {
            reactions: message
                .interactions
                .reactions
                .iter()
                .flatten()
                .cloned()
                .collect(),
            restrict_reactions: message.interactions.restrict_reactions,
        };
        let mut emoji = custom_emojis(&content, cdn);
        // свои эмодзи в реакциях — тоже картинками с CDN
        if let Some(base) = cdn.map(|base| base.trim_end_matches('/')) {
            let ids = reactions
                .iter()
                .map(|reaction| reaction.emoji.as_str())
                .chain(interactions.reactions.iter().map(String::as_str));
            for id in ids.filter(|id| is_ulid(id)) {
                emoji
                    .entry(id.to_string())
                    .or_insert_with(|| format!("{base}/emojis/{id}"));
            }
        }
        let mentions = mentioned_users(&content);

        Self {
            timestamp: ulid_time_ms(&message.id)
                .map(iso_from_ms)
                .unwrap_or_default(),
            id: message.id,
            channel: message.channel,
            author_id: message.author,
            author,
            avatar,
            content,
            edited: message.edited.is_some(),
            system,
            system_event,
            attachments,
            colour,
            embeds,
            emoji,
            username,
            roles,
            mentions,
            replies: message.replies.unwrap_or_default(),
            pinned: message.pinned.unwrap_or(false),
            reactions,
            interactions,
        }
    }
}

/// Похоже на id Stoat (ULID): 26 знаков из цифр и заглавных латинских.
fn is_ulid(value: &str) -> bool {
    value.len() == 26
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte.is_ascii_uppercase())
}

impl EmbedView {
    fn build(embed: &v0::Embed) -> Option<Self> {
        let blank = Self {
            kind: String::new(),
            url: None,
            title: None,
            description: None,
            site: None,
            image: None,
            width: None,
            height: None,
            video: None,
            gif: false,
            icon: None,
            colour: None,
        };
        match embed {
            v0::Embed::Website(website) => {
                let page = website.original_url.as_deref().or(website.url.as_deref());
                let gif =
                    matches!(website.special, Some(v0::Special::GIF)) || from_gif_provider(page);
                let (width, height) = website
                    .video
                    .as_ref()
                    .map(|video| (video.width, video.height))
                    .or_else(|| {
                        website
                            .image
                            .as_ref()
                            .map(|image| (image.width, image.height))
                    })
                    .unzip();
                Some(Self {
                    kind: "website".into(),
                    url: website.url.clone().or_else(|| website.original_url.clone()),
                    title: website.title.clone(),
                    description: website.description.clone(),
                    site: website.site_name.clone(),
                    image: website.image.as_ref().map(|image| image.url.clone()),
                    width,
                    height,
                    video: website.video.as_ref().map(|video| video.url.clone()),
                    gif,
                    icon: website.icon_url.clone(),
                    colour: website.colour.clone(),
                })
            }
            v0::Embed::Image(image) => Some(Self {
                kind: "image".into(),
                url: Some(image.url.clone()),
                image: Some(image.url.clone()),
                width: Some(image.width),
                height: Some(image.height),
                gif: from_gif_provider(Some(&image.url)),
                ..blank
            }),
            v0::Embed::Video(video) => Some(Self {
                kind: "video".into(),
                url: Some(video.url.clone()),
                width: Some(video.width),
                height: Some(video.height),
                video: Some(video.url.clone()),
                gif: from_gif_provider(Some(&video.url)),
                ..blank
            }),
            v0::Embed::Text(text) => Some(Self {
                kind: "text".into(),
                url: text.url.clone(),
                title: text.title.clone(),
                description: text.description.clone(),
                icon: text.icon_url.clone(),
                colour: text.colour.clone(),
                ..blank
            }),
            v0::Embed::None => None,
        }
    }
}

/// Адрес аватара вебхука: в сообщении приходит только id файла.
pub fn webhook_avatar_url(id: &str, cdn: Option<&str>) -> Option<String> {
    let base = cdn?.trim_end_matches('/');
    // вебхуки хранят аватары в том же хранилище, что и пользователи
    if id.contains('/') {
        Some(format!("{base}/{id}"))
    } else {
        Some(format!("{base}/avatars/{id}"))
    }
}

/// Файл в сообщении.
#[derive(Debug, Serialize)]
pub struct AttachmentView {
    /// Имя файла
    pub name: String,
    /// Ссылка
    pub url: Option<String>,
    /// `image`, `video`, `audio`, `text`, `file`
    pub kind: String,
    /// Размер в байтах
    pub size: i64,
    /// Исходный файл без пережатия (для просмотра и скачивания)
    pub original: Option<String>,
    /// Ширина картинки или видео
    pub width: Option<usize>,
    /// Высота картинки или видео
    pub height: Option<usize>,
    /// MIME-тип
    pub content_type: String,
}

impl AttachmentView {
    fn build(file: &v0::File, cdn: Option<&str>) -> Self {
        let kind = match &file.metadata {
            v0::Metadata::Image { .. } => "image",
            v0::Metadata::Video { .. } => "video",
            v0::Metadata::Audio => "audio",
            v0::Metadata::Text => "text",
            v0::Metadata::File => "file",
        };
        let (width, height) = match &file.metadata {
            v0::Metadata::Image { width, height, .. } | v0::Metadata::Video { width, height } => {
                (Some(*width), Some(*height))
            }
            _ => (None, None),
        };
        let url = file_url(file, cdn);
        Self {
            name: file.filename.clone(),
            original: url.as_ref().map(|url| format!("{url}/original")),
            url,
            kind: kind.into(),
            size: file.size as i64,
            width,
            height,
            content_type: file.content_type.clone(),
        }
    }
}

/// История канала.
#[derive(Debug, Serialize)]
pub struct HistoryView {
    /// Сообщения по возрастанию времени
    pub messages: Vec<ChatMessage>,
    /// Есть ли ещё более старая история
    pub has_more: bool,
}

// ─────────────────────────────── помощники ─────────────────────────────────

/// Первая буква для «иконки» сервера.
pub fn initial_of(name: &str) -> String {
    name.trim()
        .chars()
        .next()
        .map(|c| c.to_uppercase().to_string())
        .unwrap_or_else(|| "#".into())
}

/// Имя собеседника для личных сообщений.
pub fn recipient_name(
    recipients: &[String],
    users: &[v0::User],
    members: Option<&Vec<v0::Member>>,
) -> String {
    let names: Vec<String> = recipients
        .iter()
        .filter_map(|id| {
            if let Some(user) = users.iter().find(|user| &user.id == id) {
                return Some(display_name(user));
            }
            members
                .and_then(|list| list.iter().find(|member| &member.id.user == id))
                .and_then(|member| member.nickname.clone())
        })
        .collect();

    if names.is_empty() {
        "Личные сообщения".into()
    } else {
        names.join(", ")
    }
}

/// Имя пользователя для показа.
pub fn display_name(user: &v0::User) -> String {
    user.display_name
        .clone()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| user.username.clone())
}

/// Адрес файла на CDN Stoat: `<cdn>/<tag>/<id>`.
pub fn file_url(file: &v0::File, cdn: Option<&str>) -> Option<String> {
    if file.deleted == Some(true) {
        return None;
    }
    let base = cdn?.trim_end_matches('/');
    Some(format!("{base}/{}/{}", file.tag, file.id))
}

/// Адрес сообщения, как его понимает браузерный клиент Stoat.
///
/// Для сервера: `https://stoat.chat/server/<сервер>/channel/<канал>/<сообщение>`,
/// для личных сообщений: `https://stoat.chat/channel/<канал>/<сообщение>`.
pub fn message_link(server: Option<&str>, channel: &str, message: &str) -> String {
    match server {
        Some(server) => format!("https://stoat.chat/server/{server}/channel/{channel}/{message}"),
        None => format!("https://stoat.chat/channel/{channel}/{message}"),
    }
}

/// Наборы эмодзи на статике Stoat (UNICODE_EMOJI_PACKS).
pub const UNICODE_EMOJI_PACKS: [&str; 6] = [
    "fluent-3d",
    "fluent-color",
    "fluent-flat",
    "mutant",
    "noto",
    "twemoji",
];

/// Адрес картинки эмодзи на статике Stoat.
///
/// Официальный клиент берёт `https://static.stoat.chat/emoji/<набор>/<код>.svg`:
/// набор определяет стиль картинок (`twemoji`, `noto`).
pub fn emoji_url(pack: &str, codepoint: &str) -> String {
    format!("https://static.stoat.chat/emoji/{pack}/{codepoint}.svg?v=1")
}

/// Время из ULID: первые 10 символов — миллисекунды эпохи.
///
/// Stoat не присылает время у сообщений, поэтому берём его из id.
pub fn ulid_time_ms(id: &str) -> Option<u64> {
    const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    if id.len() < 10 {
        return None;
    }
    let mut value: u64 = 0;
    for byte in id.as_bytes().iter().take(10) {
        let upper = byte.to_ascii_uppercase();
        let index = ALPHABET.iter().position(|symbol| *symbol == upper)? as u64;
        value = value * 32 + index;
    }
    Some(value)
}

/// Миллисекунды эпохи в ISO-8601 (UTC) — формат, который понимает `new Date()`.
pub fn iso_from_ms(ms: u64) -> String {
    let secs = ms / 1000;
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    // civil_from_days — перевод дней от эпохи в дату без внешних зависимостей
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_from_ms_is_correct() {
        assert_eq!(iso_from_ms(1_794_268_800_000), "2026-11-10T00:00:00Z");
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn ulid_time_is_decoded() {
        // 01K9Z6R0B0 — правдоподобный ULID; проверяем, что время растёт
        let first = ulid_time_ms("01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
        let second = ulid_time_ms("01ARZ4NDEKTSV4RRFFQ69G5FAV").unwrap();
        assert!(
            second > first,
            "более новый ULID должен давать большее время"
        );
        assert_eq!(ulid_time_ms("коротко"), None);
    }

    #[test]
    fn file_url_uses_cdn() {
        let file: v0::File = serde_json::from_str(
            r#"{"_id":"abc","tag":"avatars","filename":"a.png",
                "metadata":{"type":"Image","width":10,"height":10},
                "content_type":"image/png","size":10}"#,
        )
        .unwrap();
        assert_eq!(
            file_url(&file, Some("https://cdn.example/")),
            Some("https://cdn.example/avatars/abc".to_string())
        );
        assert_eq!(file_url(&file, None), None);
    }

    #[test]
    fn workspace_groups_channels_by_category() {
        let snapshot = Snapshot {
            users: serde_json::from_str(
                r#"[{"_id":"u1","username":"me","discriminator":"0001","display_name":"Я","relationship":"User","online":true}]"#,
            )
            .unwrap(),
            servers: serde_json::from_str(
                r#"[{"_id":"s1","owner":"u1","name":"Мой сервер",
                     "channels":["c1","c2"],
                     "categories":[{"id":"cat1","title":"Основное","channels":["c1"]}],
                     "roles":{},"default_permissions":0,"flags":0,"nsfw":false,
                     "analytics":false,"discoverable":false,
                     "approximate_member_count":1}]"#,
            )
            .unwrap(),
            channels: serde_json::from_str(
                r#"[{"channel_type":"TextChannel","_id":"c1","server":"s1",
                     "name":"общий","role_permissions":{}},
                    {"channel_type":"TextChannel","_id":"c2","server":"s1",
                     "name":"флуд","role_permissions":{}}]"#,
            )
            .unwrap(),
            ..Default::default()
        };

        let workspace = WorkspaceView::build_ordered(
            snapshot,
            Some("https://cdn".into()),
            &Ordering::default(),
        );
        assert_eq!(workspace.servers.len(), 1);

        let server = &workspace.servers[0];
        assert_eq!(server.name, "Мой сервер");
        assert_eq!(server.initial, "М");
        assert_eq!(server.categories.len(), 2, "категория сервера + остаток");
        // как в браузере: каналы без категории попадают в «default», и он идёт первым
        assert_eq!(server.categories[0].id, "default");
        assert_eq!(server.categories[0].channels[0].name, "флуд");
        assert_eq!(server.categories[1].title, "Основное");
        assert_eq!(server.categories[1].channels[0].name, "общий");
        assert_eq!(workspace.last_channel.as_deref(), Some("c2"));
    }

    #[test]
    fn unread_and_direct_messages_are_marked() {
        let snapshot = Snapshot {
            users: serde_json::from_str(
                r#"[{"_id":"me","username":"me","discriminator":"0001","relationship":"User","online":true},
                    {"_id":"u2","username":"friend","discriminator":"0002","display_name":"Друг",
                     "status":{"text":"занят","presence":"Busy"},
                     "relationship":"Friend","online":true}]"#,
            )
            .unwrap(),
            servers: serde_json::from_str(
                r#"[{"_id":"s1","owner":"me","name":"Сервер","channels":["c1","c2"],
                     "roles":{},"default_permissions":0,"approximate_member_count":1}]"#,
            )
            .unwrap(),
            channels: serde_json::from_str(
                r#"[{"channel_type":"TextChannel","_id":"c1","server":"s1","name":"прочитан",
                     "last_message_id":"01B"},
                    {"channel_type":"TextChannel","_id":"c2","server":"s1","name":"новое",
                     "last_message_id":"01C"},
                    {"channel_type":"DirectMessage","_id":"d1","active":true,
                     "recipients":["me","u2"],"last_message_id":"01D"},
                    {"channel_type":"DirectMessage","_id":"d2","active":false,
                     "recipients":["me","u2"]},
                    {"channel_type":"SavedMessages","_id":"n1","user":"me"}]"#,
            )
            .unwrap(),
            me: serde_json::from_str(
                r#"{"_id":"me","username":"me","discriminator":"0001","relationship":"User","online":true}"#,
            )
            .unwrap(),
            unreads: [
                (
                    "c1".to_string(),
                    Unread {
                        last_id: Some("01B".into()),
                        mentions: Vec::new(),
                    },
                ),
                (
                    "c2".to_string(),
                    Unread {
                        last_id: Some("01A".into()),
                        mentions: vec!["01C".into()],
                    },
                ),
                (
                    "d1".to_string(),
                    Unread {
                        last_id: Some("01D".into()),
                        mentions: Vec::new(),
                    },
                ),
            ]
            .into_iter()
            .collect(),
            ..Default::default()
        };

        let workspace = WorkspaceView::build_ordered(snapshot, None, &Ordering::default());
        let server = &workspace.servers[0];
        assert!(server.unread);
        assert_eq!(server.mentions, 1);
        let channels = &server.categories[0].channels;
        let read = channels.iter().find(|channel| channel.id == "c1").unwrap();
        let fresh = channels.iter().find(|channel| channel.id == "c2").unwrap();
        assert!(!read.unread);
        assert!(fresh.unread);
        assert_eq!(fresh.mentions, 1);

        // закрытая переписка скрыта, заметки — отдельно
        assert_eq!(workspace.dms.len(), 1);
        assert_eq!(workspace.notes.as_deref(), Some("n1"));
        let dm = &workspace.dms[0];
        assert_eq!(dm.name, "Друг", "в имени нет самого пользователя");
        assert_eq!(dm.recipient.as_deref(), Some("u2"));
        assert_eq!(dm.presence.as_deref(), Some("Busy"));
        assert_eq!(dm.description.as_deref(), Some("занят"));
        assert!(!dm.unread);
        assert_eq!(workspace.me.unwrap().presence, "Online");
    }

    #[test]
    fn ordering_from_settings_is_applied() {
        let snapshot = Snapshot {
            users: Vec::new(),
            servers: serde_json::from_str(
                r#"[{"_id":"s1","owner":"u1","name":"Альфа","channels":["c1","c2"],
                     "categories":[{"id":"cat1","title":"Первая","channels":["c1"]},
                                   {"id":"other","title":"Вторая","channels":["c2"]}],
                     "roles":{},"default_permissions":0,"flags":0,"nsfw":false,
                     "analytics":false,"discoverable":false,"approximate_member_count":1},
                    {"_id":"s2","owner":"u1","name":"Бета","channels":[],
                     "roles":{},"default_permissions":0,"flags":0,"nsfw":false,
                     "analytics":false,"discoverable":false,"approximate_member_count":1}]"#,
            )
            .unwrap(),
            channels: serde_json::from_str(
                r#"[{"channel_type":"TextChannel","_id":"c1","server":"s1",
                     "name":"общий","role_permissions":{}},
                    {"channel_type":"TextChannel","_id":"c2","server":"s1",
                     "name":"без категории","role_permissions":{}}]"#,
            )
            .unwrap(),
            ..Default::default()
        };

        // пользователь поставил «Бета» перед «Альфа» и поменял категории местами
        let ordering = Ordering::parse(Some(
            r#"{"servers":["s2","s1"],"categories":{"s1":["other","cat1"]}}"#,
        ));

        let workspace = WorkspaceView::build_ordered(snapshot, None, &ordering);
        assert_eq!(
            workspace.servers[0].name, "Бета",
            "порядок серверов из настроек"
        );
        assert_eq!(workspace.servers[1].name, "Альфа");

        let categories: Vec<&str> = workspace.servers[1]
            .categories
            .iter()
            .map(|category| category.id.as_str())
            .collect();
        assert_eq!(
            categories,
            vec!["other", "cat1"],
            "порядок категорий из настроек"
        );
    }

    #[test]
    fn custom_emojis_are_found_by_id() {
        let cdn = Some("https://cdn.example/");
        let found = custom_emojis(
            "привет :01GZ8K1WZ6J0X8Y4V3T2R1Q0PN: и :cat: и 12:30 и :01GZ8K1WZ6J0X8Y4V3T2R1Q0P:",
            cdn,
        );
        assert_eq!(found.len(), 1, "только полный ULID между двоеточиями");
        assert_eq!(
            found["01GZ8K1WZ6J0X8Y4V3T2R1Q0PN"],
            "https://cdn.example/emojis/01GZ8K1WZ6J0X8Y4V3T2R1Q0PN"
        );
        assert!(custom_emojis("обычный текст", cdn).is_empty());
        assert!(custom_emojis(":01GZ8K1WZ6J0X8Y4V3T2R1Q0PN:", None).is_empty());
        // многобайтовые символы рядом с двоеточием не ломают разбор
        assert!(custom_emojis(":ёёёёёёёёёёёёёёё:", cdn).is_empty());
    }

    #[test]
    fn server_emoji_url_is_built() {
        let emoji: v0::Emoji = serde_json::from_str(
            r#"{"_id":"e1","parent":{"type":"Server","id":"s1"},"creator_id":"u1",
                "name":"cat","animated":true}"#,
        )
        .unwrap();
        let view = EmojiView::build(&emoji, Some("https://cdn.example/"));
        assert_eq!(view.url.as_deref(), Some("https://cdn.example/emojis/e1"));
        assert!(view.animated);
    }

    #[test]
    fn message_and_emoji_urls_match_web_client() {
        assert_eq!(
            message_link(Some("01S"), "01C", "01M"),
            "https://stoat.chat/server/01S/channel/01C/01M"
        );
        assert_eq!(
            message_link(None, "01C", "01M"),
            "https://stoat.chat/channel/01C/01M"
        );
        assert_eq!(
            emoji_url("twemoji", "1f600"),
            "https://static.stoat.chat/emoji/twemoji/1f600.svg?v=1"
        );
    }

    #[test]
    fn ordering_survives_broken_value() {
        // мусор в настройке не должен ломать интерфейс
        assert!(Ordering::parse(Some("не json")).servers.is_empty());
        assert!(Ordering::parse(None).servers.is_empty());
    }

    #[test]
    fn dm_name_comes_from_recipient() {
        let users: Vec<v0::User> =
            serde_json::from_str(r#"[{"_id":"u2","username":"friend","discriminator":"0002","relationship":"Friend","online":false}]"#)
                .unwrap();
        assert_eq!(
            recipient_name(&["u2".to_string()], &users, None),
            "friend",
            "дискриминатор в имени не показывается"
        );
        assert_eq!(
            recipient_name(&["нет".to_string()], &users, None),
            "Личные сообщения"
        );
    }

    #[test]
    fn message_view_has_author_and_time() {
        let message: v0::Message = serde_json::from_str(
            r#"{"_id":"01K9Z6R0B0AAAAAAAAAAAAAAAA","channel":"c1","author":"u1",
                "content":"привет",
                "user":{"_id":"u1","username":"me","discriminator":"0001","display_name":"Я","relationship":"User","online":true}}"#,
        )
        .unwrap();

        let view = ChatMessage::build(
            message,
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            None,
        );
        assert_eq!(view.content, "привет");
        assert_eq!(view.author, "Я");
        assert!(!view.edited);
        assert!(!view.system);
        assert!(view.timestamp.ends_with('Z'), "время должно быть ISO-8601");
    }

    fn roles_json() -> HashMap<String, v0::Role> {
        serde_json::from_str(
            r##"{"r1":{"_id":"r1","name":"Гость","permissions":{"a":0,"d":0},"rank":1,"colour":"#00ff00"},
                 "r2":{"_id":"r2","name":"Админ","permissions":{"a":0,"d":0},"rank":10,"colour":"#ff0000"},
                 "r3":{"_id":"r3","name":"Без цвета","permissions":{"a":0,"d":0},"rank":99}}"##,
        )
        .unwrap()
    }

    #[test]
    fn colour_comes_from_highest_role() {
        let roles = roles_json();
        // в Stoat старшая роль — с меньшим rank: «Гость» (1) выше «Админа» (10)
        let member_roles = vec!["r3".to_string(), "r2".to_string(), "r1".to_string()];
        assert_eq!(
            role_colour(&member_roles, &roles),
            Some("#00ff00".to_string()),
            "цвет берётся у старшей роли, а не у первой в списке"
        );
        assert_eq!(
            role_colour(&["r3".to_string(), "r2".to_string()], &roles),
            Some("#ff0000".to_string()),
            "роль без цвета пропускается"
        );
        assert_eq!(role_colour(&["r3".to_string()], &roles), None);
        assert_eq!(role_colour(&[], &roles), None);
    }

    #[test]
    fn nickname_and_colour_come_from_member() {
        let message: v0::Message = serde_json::from_str(
            r#"{"_id":"01K9Z6R0B0AAAAAAAAAAAAAAAA","channel":"c1","author":"u1",
                "content":"привет <@01ARZ3NDEKTSV4RRFFQ69G5FAV>",
                "member":{"_id":{"server":"s1","user":"u1"},"joined_at":"2026-01-01T00:00:00Z",
                          "nickname":"Шеф","roles":["r2"]},
                "user":{"_id":"u1","username":"boss","discriminator":"0002","display_name":"Профиль",
                        "relationship":"User","online":true}}"#,
        )
        .unwrap();

        let view = ChatMessage::build(
            message,
            &HashMap::new(),
            &roles_json(),
            &HashMap::new(),
            &HashMap::new(),
            None,
        );
        assert_eq!(view.author, "Шеф", "ник с сервера важнее имени профиля");
        assert_eq!(view.colour.as_deref(), Some("#ff0000"));
        assert_eq!(view.roles, vec!["Админ"]);
        assert_eq!(view.mentions, vec!["01ARZ3NDEKTSV4RRFFQ69G5FAV"]);
        assert_eq!(view.username.as_deref(), Some("boss#0002"));
    }

    #[test]
    fn members_are_sorted_online_first() {
        let server: v0::Server = serde_json::from_str(
            r##"{"_id":"s1","owner":"u1","name":"С","channels":[],"roles":
                 {"r2":{"_id":"r2","name":"Админ","permissions":{"a":0,"d":0},"rank":10,"colour":"#ff0000"}},
                 "default_permissions":0,"flags":0,"nsfw":false,"analytics":false,
                 "discoverable":false,"approximate_member_count":2}"##,
        )
        .unwrap();
        let members: Vec<v0::Member> = serde_json::from_str(
            r#"[{"_id":{"server":"s1","user":"u1"},"joined_at":"2026-01-01T00:00:00Z",
                 "nickname":"Шеф","roles":["r2"]},
                {"_id":{"server":"s1","user":"u2"},"joined_at":"2026-01-01T00:00:00Z"}]"#,
        )
        .unwrap();
        let users: HashMap<String, v0::User> = serde_json::from_str(
            r#"[{"_id":"u1","username":"boss","discriminator":"0002","relationship":"User","online":false},
                {"_id":"u2","username":"sleepy","discriminator":"0003","relationship":"User","online":true}]"#,
        )
        .map(|list: Vec<v0::User>| list.into_iter().map(|u| (u.id.clone(), u)).collect())
        .unwrap();

        let list = members_of(&server, &members, &users, None);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "u2", "сначала те, кто в сети");
        assert_eq!(list[1].name, "Шеф");
        assert_eq!(list[1].colour.as_deref(), Some("#ff0000"));
        assert_eq!(list[1].roles, vec!["Админ"]);
        assert!(!list[1].online);
        assert_eq!(list[1].presence, "Offline");
        assert_eq!(list[0].presence, "Online");
        assert_eq!(list[1].hoist, None, "роль без hoist не создаёт группу");
    }

    #[test]
    fn hoisted_role_is_the_most_senior_one() {
        let server: v0::Server = serde_json::from_str(
            r##"{"_id":"s1","owner":"u1","name":"С","channels":[],"roles":{
                 "low":{"_id":"low","name":"Участник","permissions":{"a":0,"d":0},"rank":20,"hoist":true},
                 "top":{"_id":"top","name":"Модератор","permissions":{"a":0,"d":0},"rank":2,"hoist":true}},
                 "default_permissions":0,"approximate_member_count":1}"##,
        )
        .unwrap();
        let members: Vec<v0::Member> = serde_json::from_str(
            r#"[{"_id":{"server":"s1","user":"u1"},"joined_at":"2026-01-01T00:00:00Z",
                 "roles":["low","top"]}]"#,
        )
        .unwrap();
        let users: HashMap<String, v0::User> = serde_json::from_str(
            r#"{"u1":{"_id":"u1","username":"mod","discriminator":"0001","relationship":"User","online":true}}"#,
        )
        .unwrap();

        let list = members_of(&server, &members, &users, None);
        let hoist = list[0].hoist.as_ref().unwrap();
        assert_eq!(hoist.name, "Модератор");
        assert_eq!(hoist.rank, 2);
        assert_eq!(list[0].roles, vec!["Модератор", "Участник"]);
    }

    #[test]
    fn system_message_gets_text() {
        let message: v0::Message = serde_json::from_str(
            r#"{"_id":"01K9Z6R0B0AAAAAAAAAAAAAAAA","channel":"c1","author":"00000000000000000000000000",
                "system":{"type":"user_joined","id":"u1"}}"#,
        )
        .unwrap();
        let nicknames: HashMap<String, String> = [("u1".to_string(), "Новичок".to_string())]
            .into_iter()
            .collect();
        let view = ChatMessage::build(
            message,
            &HashMap::new(),
            &HashMap::new(),
            &nicknames,
            &HashMap::new(),
            None,
        );
        assert!(view.system);
        assert_eq!(view.content, "Новичок присоединяется");
        let event = view.system_event.unwrap();
        assert_eq!(event.kind, "user_joined");
        assert_eq!(event.user.as_deref(), Some("Новичок"));
        assert_eq!(event.user_id.as_deref(), Some("u1"));
        assert_eq!(event.by, None);
    }

    #[test]
    fn replies_are_kept() {
        let message: v0::Message = serde_json::from_str(
            r#"{"_id":"01K9Z6R0B0AAAAAAAAAAAAAAAA","channel":"c1","author":"u1",
                "content":"ответ","replies":["01K9Z6R0B0AAAAAAAAAAAAAAA0"]}"#,
        )
        .unwrap();
        let view = ChatMessage::build(
            message,
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            None,
        );
        assert_eq!(view.replies, vec!["01K9Z6R0B0AAAAAAAAAAAAAAA0"]);
    }
}

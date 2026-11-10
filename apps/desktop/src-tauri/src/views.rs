//! Представления для интерфейса.
//!
//! UI не разбирает модели Stoat напрямую: здесь они превращаются в плоские
//! структуры, которые удобно рисовать. Модуль сознательно не зависит от Tauri,
//! поэтому его поведение проверяется тестами без сборки GUI.

use std::collections::HashMap;

use revolt_models::v0;
use serde::{Deserialize, Serialize};
use stoat_core::cache::{Snapshot, channel_id as id_of};

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
}

impl UserView {
    /// Имя для показа: отображаемое, иначе `ник#0001`.
    pub fn label(&self) -> String {
        self.display_name
            .clone()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| format!("{}#{}", self.username, self.discriminator))
    }
}

impl From<v0::User> for UserView {
    fn from(user: v0::User) -> Self {
        Self {
            id: user.id,
            username: user.username,
            discriminator: user.discriminator,
            display_name: user.display_name,
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
    /// Канал, который стоит открыть по умолчанию
    pub last_channel: Option<String>,
    /// Базовый URL файлов (аватары, вложения)
    pub cdn: Option<String>,
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

        let mut servers: Vec<ServerView> = snapshot
            .servers
            .iter()
            .map(|server| {
                ServerView::build(
                    server,
                    &channels,
                    snapshot.members.get(&server.id),
                    ordering,
                    cdn.as_deref(),
                )
            })
            .collect();
        // порядок как в браузере: сначала серверы из настроек, затем новые
        Ordering::apply(&mut servers, &ordering.servers, |server| &server.id);
        if ordering.servers.is_empty() {
            servers.sort_by_key(|server| server.name.to_lowercase());
        }

        let mut dms: Vec<ChannelView> = channels
            .iter()
            .filter(|channel| {
                matches!(
                    channel,
                    v0::Channel::DirectMessage { .. } | v0::Channel::Group { .. }
                )
            })
            .map(|channel| ChannelView::build(channel, &snapshot.users, None))
            .collect();
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

        Self {
            me: snapshot.me.map(UserView::from),
            servers,
            dms,
            last_channel,
            cdn,
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
    /// Категории с каналами (в порядке сервера)
    pub categories: Vec<CategoryView>,
}

impl ServerView {
    fn build(
        server: &v0::Server,
        channels: &[&v0::Channel],
        members: Option<&Vec<v0::Member>>,
        ordering: &Ordering,
        cdn: Option<&str>,
    ) -> Self {
        let members = members.cloned().unwrap_or_default();

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
                    Some(ChannelView::build(channel, &[], Some(&members)))
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
            .map(|channel| ChannelView::build(channel, &[], Some(&members)))
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
            categories,
        }
    }
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
    /// Иконка канала: эмодзи, а не файл (в Stoat это `icon` + `default_permissions` нет).
    pub emoji: Option<String>,
    /// Id последнего сообщения — для сортировки ЛС
    pub last_message_id: Option<String>,
    /// Идёт ли голосовая сессия
    pub voice: bool,
}

impl ChannelView {
    fn build(channel: &v0::Channel, users: &[v0::User], members: Option<&Vec<v0::Member>>) -> Self {
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
                emoji: icon.as_ref().and_then(emoji_of),
                last_message_id: last_message_id.clone(),
                voice: voice.is_some(),
            },
            v0::Channel::DirectMessage {
                id,
                recipients,
                last_message_id,
                ..
            } => Self {
                id: id.clone(),
                name: recipient_name(recipients, users, members),
                kind: "dm".into(),
                description: None,
                emoji: None,
                last_message_id: last_message_id.clone(),
                voice: false,
            },
            v0::Channel::Group {
                id,
                name,
                description,
                icon,
                last_message_id,
                ..
            } => Self {
                id: id.clone(),
                name: name.clone(),
                kind: "group".into(),
                description: description.clone(),
                emoji: icon.as_ref().and_then(emoji_of),
                last_message_id: last_message_id.clone(),
                voice: false,
            },
            v0::Channel::SavedMessages { id, .. } => Self {
                id: id.clone(),
                name: "Избранное".into(),
                kind: "notes".into(),
                description: None,
                emoji: None,
                last_message_id: None,
                voice: false,
            },
        }
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
    /// Файлы
    pub attachments: Vec<AttachmentView>,
    /// Оформление текста по кускам
    pub segments: Segments,
    /// Цвет ника из роли или маски
    pub colour: Option<String>,
    /// Встраивания: превью ссылок, картинки, видео
    pub embeds: Vec<EmbedView>,
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
    /// Ширина картинки
    pub width: Option<usize>,
    /// Высота картинки
    pub height: Option<usize>,
}

impl ChatMessage {
    /// Собрать сообщение для показа.
    ///
    /// В моделях Stoat у сообщения нет поля времени: время закодировано в
    /// ULID-идентификаторе (первые 10 символов — миллисекунды эпохи).
    pub fn build(
        message: v0::Message,
        authors: &HashMap<String, UserView>,
        cdn: Option<&str>,
    ) -> Self {
        // Порядок как в клиенте Stoat: маска сообщения важнее всего, затем
        // вебхук (у него своё имя и аватар), затем участник, затем профиль.
        let masquerade = message.masquerade.as_ref();
        let webhook = message.webhook.as_ref();

        let author = masquerade
            .and_then(|mask| mask.name.clone())
            .or_else(|| webhook.map(|hook| hook.name.clone()))
            .or_else(|| message.member.as_ref().and_then(|m| m.nickname.clone()))
            .or_else(|| message.user.as_ref().map(display_name))
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
            .or_else(|| {
                message
                    .user
                    .as_ref()
                    .and_then(|user| user.avatar.as_ref())
                    .and_then(|file| file_url(file, cdn))
            })
            .or_else(|| {
                message
                    .member
                    .as_ref()
                    .and_then(|member| member.avatar.as_ref())
                    .and_then(|file| file_url(file, cdn))
            });

        let colour = masquerade.and_then(|mask| mask.colour.clone());
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

        let content = message.content.unwrap_or_default();

        Self {
            timestamp: ulid_time_ms(&message.id)
                .map(iso_from_ms)
                .unwrap_or_default(),
            segments: segments(&content),
            id: message.id,
            channel: message.channel,
            author_id: message.author,
            author,
            avatar,
            content,
            edited: message.edited.is_some(),
            system,
            attachments,
            colour,
            embeds,
        }
    }
}

impl EmbedView {
    fn build(embed: &v0::Embed) -> Option<Self> {
        match embed {
            v0::Embed::Website(website) => Some(Self {
                kind: "website".into(),
                url: website.url.clone().or_else(|| website.original_url.clone()),
                title: website.title.clone(),
                description: website.description.clone(),
                site: website.site_name.clone(),
                image: website.image.as_ref().map(|image| image.url.clone()),
                width: website.image.as_ref().map(|image| image.width),
                height: website.image.as_ref().map(|image| image.height),
            }),
            v0::Embed::Image(image) => Some(Self {
                kind: "image".into(),
                url: Some(image.url.clone()),
                title: None,
                description: None,
                site: None,
                image: Some(image.url.clone()),
                width: Some(image.width),
                height: Some(image.height),
            }),
            v0::Embed::Video(video) => Some(Self {
                kind: "video".into(),
                url: Some(video.url.clone()),
                title: None,
                description: None,
                site: None,
                image: None,
                width: Some(video.width),
                height: Some(video.height),
            }),
            v0::Embed::Text(text) => Some(Self {
                kind: "text".into(),
                url: text.url.clone(),
                title: text.title.clone(),
                description: text.description.clone(),
                site: None,
                image: None,
                width: None,
                height: None,
            }),
            v0::Embed::None => None,
        }
    }
}

/// Текст текстового эмбеда: в модели это `content`, а не `description`.
///
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
        Self {
            name: file.filename.clone(),
            url: file_url(file, cdn),
            kind: kind.into(),
            size: file.size as i64,
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
        .unwrap_or_else(|| format!("{}#{}", user.username, user.discriminator))
}

/// Стилизация текста сообщения (жирный, курсив, код, ссылка).
#[derive(Debug, Serialize, PartialEq)]
pub struct Segment {
    /// Вид: `text`, `bold`, `italic`, `strike`, `code`, `codeblock`, `spoiler`
    pub kind: String,
    /// Содержимое
    pub text: String,
    /// Адрес ссылки, если это ссылка
    pub href: Option<String>,
}

/// Разметка сообщения по «узлам», чтобы интерфейс не собирал HTML.
pub type Segments = Vec<Segment>;

/// Разобрать текст сообщения на оформленные куски.
///
/// Поддерживается то, что реально встречается в Stoat: `**жирный**`,
/// `*курсив*` и `_курсив_`, `~~зачёркнутый~~`, `` `код` ``, блоки кода
/// ```…```, `||спойлер||` и ссылки `[текст](адрес)`.
pub fn segments(text: &str) -> Segments {
    let mut out = Vec::new();

    // блоки кода разбираем первыми: внутри них разметка не действует
    let mut rest = text;
    loop {
        match rest.find("```") {
            Some(open) => {
                push_text(&mut out, &rest[..open]);
                let after = &rest[open + 3..];
                match after.find("```") {
                    Some(close) => {
                        out.push(Segment {
                            kind: "codeblock".into(),
                            text: after[..close].trim_matches('\n').to_string(),
                            href: None,
                        });
                        rest = &after[close + 3..];
                    }
                    None => {
                        // незакрытый блок — показываем как обычный текст
                        push_text(&mut out, &rest[open..]);
                        return out;
                    }
                }
            }
            None => {
                push_text(&mut out, rest);
                return out;
            }
        }
    }
}

/// Разметка внутри строки.
///
/// Ищем ближайший открывающий маркер, а не «первый попавшийся» символ:
/// из-за этого раньше терялся текст между `**…**` и `` `…` ``.
fn push_text(out: &mut Segments, text: &str) {
    let mut plain = String::new();
    let mut rest = text;

    while let Some((at, marker, kind)) = next_marker(rest) {
        // текст до маркера
        plain.push_str(&rest[..at]);

        let after = &rest[at + marker.len()..];
        let closing = if kind == "link" {
            None
        } else {
            after.find(marker)
        };

        match kind {
            // ссылка: [текст](адрес)
            "link" => {
                let parsed = after
                    .find("](")
                    .and_then(|close| after[close + 2..].find(')').map(|end| (close, end)))
                    .map(|(close, end)| {
                        let title = after[..close].to_string();
                        let href = after[close + 2..close + 2 + end].to_string();
                        (title, href, close + 2 + end + 1)
                    })
                    .filter(|(_, href, _)| href.starts_with("http"));

                match parsed {
                    Some((title, href, used)) => {
                        push_plain(out, &mut plain);
                        out.push(Segment {
                            kind: "link".into(),
                            text: title,
                            href: Some(href),
                        });
                        rest = &after[used..];
                    }
                    // это не ссылка — оставляем скобку как текст
                    None => {
                        plain.push('[');
                        rest = &rest[at + 1..];
                    }
                }
            }
            _ => match closing {
                Some(end) if end > 0 => {
                    push_plain(out, &mut plain);
                    out.push(Segment {
                        kind: kind.into(),
                        text: after[..end].to_string(),
                        href: None,
                    });
                    rest = &after[end + marker.len()..];
                }
                // закрывающего маркера нет — считаем символ обычным текстом
                _ => {
                    plain.push_str(marker);
                    rest = after;
                }
            },
        }
    }

    plain.push_str(rest);
    push_plain(out, &mut plain);
}

/// Ближайший маркер разметки: (позиция, маркер, вид).
fn next_marker(text: &str) -> Option<(usize, &'static str, &'static str)> {
    const MARKERS: [(&str, &str); 6] = [
        ("```", "codeblock"),
        ("`", "code"),
        ("**", "bold"),
        ("~~", "strike"),
        ("||", "spoiler"),
        ("*", "italic"),
    ];

    let mut best: Option<(usize, &'static str, &'static str)> = None;
    for (marker, kind) in MARKERS {
        // одиночная «*» не должна перебивать «**»
        if marker == "*" && text.starts_with("**") {
            continue;
        }
        if let Some(at) = text.find(marker) {
            let better = match best {
                None => true,
                // при равной позиции предпочитаем длинный маркер
                Some((best_at, best_marker, _)) => {
                    at < best_at || (at == best_at && marker.len() > best_marker.len())
                }
            };
            if better {
                best = Some((at, marker, kind));
            }
        }
    }

    // «_курсив_» отдельно: подчёркивания часто встречаются в словах и ссылках
    if let Some(at) = text.find('_')
        && let Some((best_at, _, _)) = best
        && at < best_at
        && text[at + 1..].contains('_')
    {
        best = Some((at, "_", "italic"));
    }

    // ссылка
    if let Some(at) = text.find('[')
        && text[at..].contains("](")
    {
        let better = match best {
            None => true,
            Some((best_at, _, _)) => at < best_at,
        };
        if better {
            best = Some((at, "[", "link"));
        }
    }

    // позицию ссылки отмечаем отдельно: маркер «[» имеет длину 1
    best.map(|(at, marker, kind)| {
        if kind == "link" {
            (at, "[", "link")
        } else {
            (at, marker, kind)
        }
    })
}

fn push_plain(out: &mut Segments, plain: &mut String) {
    if !plain.is_empty() {
        out.push(Segment {
            kind: "text".into(),
            text: std::mem::take(plain),
            href: None,
        });
    }
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

/// Имя файла эмодзи, если «иконка» канала на самом деле эмодзи.
///
/// В Stoat иконка канала — это файл с тегом `emojis` и именем вида `1f600.webp`:
/// по имени и определяется, что показать вместо «#».
pub fn emoji_of(file: &v0::File) -> Option<String> {
    let name = file.filename.rsplit('/').next().unwrap_or(&file.filename);
    let codepoint = name.split('.').next().unwrap_or(name).trim().to_lowercase();
    if codepoint.is_empty() {
        return None;
    }
    let valid = codepoint
        .split('-')
        .all(|part| !part.is_empty() && part.chars().all(|symbol| symbol.is_ascii_hexdigit()));
    valid.then_some(codepoint)
}

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
    fn markdown_becomes_segments() {
        let parts = segments("привет **мир** и `код` со [ссылкой](https://stoat.chat)");
        let kinds: Vec<&str> = parts.iter().map(|part| part.kind.as_str()).collect();
        assert_eq!(kinds, vec!["text", "bold", "text", "code", "text", "link"]);

        let bold = parts.iter().find(|part| part.kind == "bold").unwrap();
        assert_eq!(bold.text, "мир");

        let link = parts.iter().find(|part| part.kind == "link").unwrap();
        assert_eq!(link.href.as_deref(), Some("https://stoat.chat"));
        assert_eq!(link.text, "ссылкой");
    }

    #[test]
    fn markdown_keeps_all_text() {
        // раньше здесь терялось « между »
        let text = "начало **жирный** между `код` и *курсив* конец";
        let parts = segments(text);
        let joined: String = parts.iter().map(|part| part.text.as_str()).collect();
        assert!(
            joined.contains("между"),
            "текст между разметкой не должен теряться"
        );
        assert!(joined.contains("начало"));
        assert!(joined.contains("конец"));
        assert_eq!(parts.iter().filter(|part| part.kind == "bold").count(), 1);
        assert_eq!(parts.iter().filter(|part| part.kind == "italic").count(), 1);
    }

    #[test]
    fn multiple_bold_pairs_are_split() {
        let parts = segments("**один** и **два**");
        let bold: Vec<&str> = parts
            .iter()
            .filter(|part| part.kind == "bold")
            .map(|part| part.text.as_str())
            .collect();
        assert_eq!(bold, vec!["один", "два"]);
    }

    #[test]
    fn unmatched_marker_stays_text() {
        let parts = segments("2 * 2 = 4 и [скобка без ссылки");
        let joined: String = parts.iter().map(|part| part.text.as_str()).collect();
        assert!(joined.contains("2 * 2 = 4"));
        assert!(joined.contains("[скобка без ссылки"));
    }

    #[test]
    fn code_block_and_spoiler_are_separate() {
        let parts = segments(
            "```
let a = 1;
``` после ||тайна||",
        );
        assert_eq!(parts[0].kind, "codeblock");
        assert_eq!(parts[0].text, "let a = 1;");
        assert!(
            parts
                .iter()
                .any(|part| part.kind == "spoiler" && part.text == "тайна")
        );
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
            "friend#0002"
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

        let view = ChatMessage::build(message, &HashMap::new(), None);
        assert_eq!(view.content, "привет");
        assert_eq!(view.author, "Я");
        assert!(!view.edited);
        assert!(!view.system);
        assert!(view.timestamp.ends_with('Z'), "время должно быть ISO-8601");
    }
}

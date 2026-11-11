//! Права на сервере и в канале — так же, как их считает API
//! (`calculate_server_permissions`, `calculate_channel_permissions`).
//!
//! Нужны интерфейсу, чтобы показывать только доступные разделы настроек
//! и пункты меню (ответить, отреагировать, закрепить, удалить чужое);
//! окончательно права проверяет сервер. Значения битов интерфейс знает сам
//! (`PERMISSIONS` в `settings.js`).

use iso8601_timestamp::Timestamp;
use revolt_models::v0;

/// Всё, что может владелец (`GrantAllSafe`).
pub const GRANT_ALL_SAFE: u64 = 0x000F_FFFF_FFFF_FFFF;

const MANAGE_CHANNEL: u64 = 1 << 0;
const VIEW_CHANNEL: u64 = 1 << 20;
const READ_MESSAGE_HISTORY: u64 = 1 << 21;
const SEND_MESSAGE: u64 = 1 << 22;
const INVITE_OTHERS: u64 = 1 << 25;
const SEND_EMBEDS: u64 = 1 << 26;
const UPLOAD_FILES: u64 = 1 << 27;
const REACT: u64 = 1 << 29;
const CONNECT: u64 = 1 << 30;
const SPEAK: u64 = 1 << 31;
const VIDEO: u64 = 1 << 32;
const LISTEN: u64 = 1 << 36;

/// Только смотреть и читать историю (`DEFAULT_PERMISSION_VIEW_ONLY`);
/// столько же остаётся участнику на тайм-ауте (`ALLOW_IN_TIMEOUT`).
const VIEW_ONLY: u64 = VIEW_CHANNEL | READ_MESSAGE_HISTORY;

/// `DEFAULT_PERMISSION`
const DEFAULT_PERMISSION: u64 = VIEW_ONLY
    | SEND_MESSAGE
    | INVITE_OTHERS
    | SEND_EMBEDS
    | UPLOAD_FILES
    | CONNECT
    | SPEAK
    | VIDEO
    | LISTEN;

/// `DEFAULT_PERMISSION_DIRECT_MESSAGE`
const DEFAULT_PERMISSION_DIRECT_MESSAGE: u64 = DEFAULT_PERMISSION | REACT | MANAGE_CHANNEL;

/// Разрешить `allow`, затем запретить `deny` — как `PermissionValue::apply`.
fn apply(value: u64, allow: i64, deny: i64) -> u64 {
    (value | allow as u64) & !(deny as u64)
}

/// Участник на тайм-ауте может только читать.
fn timed_out(member: &v0::Member) -> bool {
    member
        .timeout
        .as_ref()
        .is_some_and(|until| *until > Timestamp::now_utc())
}

/// Роли участника от младшей к старшей: у старшей меньший `rank`.
fn roles_by_priority<'a>(server: &'a v0::Server, member: &v0::Member) -> Vec<&'a v0::Role> {
    let mut roles: Vec<&v0::Role> = member
        .roles
        .iter()
        .filter_map(|id| server.roles.get(id))
        .collect();
    roles.sort_by_key(|role| std::cmp::Reverse(role.rank));
    roles
}

/// Права пользователя на сервере.
///
/// Владелец получает всё. Остальным: права по умолчанию, затем роли от
/// младшей к старшей (у старшей меньший `rank`) — каждая сначала добавляет
/// разрешённое, затем убирает запрещённое.
pub fn server(server: &v0::Server, user_id: Option<&str>, member: Option<&v0::Member>) -> u64 {
    if user_id.is_some() && user_id == Some(server.owner.as_str()) {
        return GRANT_ALL_SAFE;
    }
    let Some(member) = member else {
        return 0;
    };

    let mut value = server.default_permissions as u64;
    for role in roles_by_priority(server, member) {
        value = apply(value, role.permissions.a, role.permissions.d);
    }
    if timed_out(member) {
        value &= VIEW_ONLY;
    }
    value
}

/// Кто я для прав в канале.
pub struct Viewer<'a> {
    /// Мой профиль
    pub me: Option<&'a v0::User>,
    /// Известные пользователи: собеседник в личных сообщениях
    pub users: &'a [v0::User],
}

/// Мои права в канале.
///
/// - «Заметки» — всё.
/// - Личные сообщения: писать можно другу (и боту — по общему каналу),
///   остальным — только читать.
/// - Группа: владельцу всё, остальным — чтение и права группы.
/// - Канал сервера: права сервера по умолчанию, затем права канала по
///   умолчанию, затем роли на сервере и роли в канале от младшей к старшей;
///   без `ViewChannel` не остаётся ничего.
pub fn channel(
    channel: &v0::Channel,
    viewer: &Viewer,
    server: Option<&v0::Server>,
    member: Option<&v0::Member>,
) -> u64 {
    let me = viewer.me.map(|user| user.id.as_str());
    match channel {
        v0::Channel::SavedMessages { .. } => GRANT_ALL_SAFE,
        v0::Channel::DirectMessage { recipients, .. } => {
            let other = recipients
                .iter()
                .find(|id| Some(id.as_str()) != me)
                .and_then(|id| viewer.users.iter().find(|user| &user.id == id));
            if can_message(viewer.me, other) {
                DEFAULT_PERMISSION_DIRECT_MESSAGE
            } else {
                VIEW_ONLY
            }
        }
        v0::Channel::Group {
            owner, permissions, ..
        } => {
            if Some(owner.as_str()) == me {
                GRANT_ALL_SAFE
            } else {
                VIEW_ONLY
                    | permissions.map_or(DEFAULT_PERMISSION_DIRECT_MESSAGE, |value| value as u64)
            }
        }
        v0::Channel::TextChannel {
            default_permissions,
            role_permissions,
            ..
        } => {
            let Some(server) = server else {
                return 0;
            };
            if me == Some(server.owner.as_str()) {
                return GRANT_ALL_SAFE;
            }
            let Some(member) = member else {
                return 0;
            };

            let roles = roles_by_priority(server, member);
            let mut value = server.default_permissions as u64;
            if let Some(field) = default_permissions {
                value = apply(value, field.a, field.d);
            }
            for role in &roles {
                value = apply(value, role.permissions.a, role.permissions.d);
            }
            for role in &roles {
                if let Some(field) = role_permissions.get(&role.id) {
                    value = apply(value, field.a, field.d);
                }
            }
            if timed_out(member) {
                value &= VIEW_ONLY;
            }
            if value & VIEW_CHANNEL == 0 {
                return 0;
            }
            value
        }
    }
}

/// Можно ли писать собеседнику (`calculate_user_permissions`, бит `SendMessage`):
/// другу — да, заблокированному — нет, боту или от имени бота — раз уж
/// есть общий канал.
fn can_message(me: Option<&v0::User>, other: Option<&v0::User>) -> bool {
    let Some(other) = other else {
        return false;
    };
    match other.relationship {
        v0::RelationshipStatus::Friend | v0::RelationshipStatus::User => true,
        v0::RelationshipStatus::Blocked | v0::RelationshipStatus::BlockedOther => false,
        _ => other.bot.is_some() || me.is_some_and(|user| user.bot.is_some()),
    }
}

/// Ранг старшей роли участника: им ограничено, какие роли он может менять.
///
/// Владельцу доступно всё (`i64::MIN`), участнику без ролей — ничего (`i64::MAX`).
pub fn top_rank(server: &v0::Server, user_id: &str, member: Option<&v0::Member>) -> i64 {
    if server.owner == user_id {
        return i64::MIN;
    }
    member
        .into_iter()
        .flat_map(|member| member.roles.iter())
        .filter_map(|id| server.roles.get(id))
        .map(|role| role.rank)
        .min()
        .unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MANAGE_ROLE: u64 = 1 << 3;
    const CHANGE_NICKNAME: u64 = 1 << 10;

    fn server() -> v0::Server {
        serde_json::from_str(
            r#"{"_id":"s1","owner":"boss","name":"С","channels":[],
                "roles":{
                    "mod":{"_id":"mod","name":"Модератор","permissions":{"a":8,"d":0},"rank":1},
                    "muted":{"_id":"muted","name":"Без ников","permissions":{"a":0,"d":1024},"rank":5}
                },
                "default_permissions":1024,"approximate_member_count":3}"#,
        )
        .unwrap()
    }

    fn member(roles: &[&str]) -> v0::Member {
        serde_json::from_value(serde_json::json!({
            "_id": {"server": "s1", "user": "u1"},
            "joined_at": "2026-01-01T00:00:00Z",
            "roles": roles,
        }))
        .unwrap()
    }

    #[test]
    fn owner_gets_everything() {
        assert_eq!(super::server(&server(), Some("boss"), None), GRANT_ALL_SAFE);
        assert_eq!(top_rank(&server(), "boss", None), i64::MIN);
    }

    #[test]
    fn roles_apply_from_lowest_to_highest() {
        let plain = member(&[]);
        assert_eq!(
            super::server(&server(), Some("u1"), Some(&plain)),
            CHANGE_NICKNAME
        );

        let both = member(&["mod", "muted"]);
        let value = super::server(&server(), Some("u1"), Some(&both));
        assert_eq!(value & MANAGE_ROLE, MANAGE_ROLE, "модератор может роли");
        assert_eq!(
            value & CHANGE_NICKNAME,
            0,
            "запрет младшей роли снимает право"
        );
        assert_eq!(top_rank(&server(), "u1", Some(&both)), 1);
        assert_eq!(top_rank(&server(), "u1", Some(&plain)), i64::MAX);
    }

    #[test]
    fn stranger_has_nothing() {
        assert_eq!(super::server(&server(), Some("x"), None), 0);
    }

    fn user(id: &str, relationship: &str, bot: bool) -> v0::User {
        let mut value = serde_json::json!({
            "_id": id, "username": id, "discriminator": "0001",
            "relationship": relationship, "online": false,
        });
        if bot {
            value["bot"] = serde_json::json!({"owner": "someone"});
        }
        serde_json::from_value(value).unwrap()
    }

    fn dm(other: &str) -> v0::Channel {
        serde_json::from_value(serde_json::json!({
            "channel_type": "DirectMessage", "_id": "dm", "active": true,
            "recipients": ["me", other],
        }))
        .unwrap()
    }

    #[test]
    fn direct_messages_follow_relationship() {
        let me = user("me", "User", false);
        let users = [
            user("friend", "Friend", false),
            user("stranger", "None", false),
            user("blocked", "Blocked", false),
            user("bot", "None", true),
        ];
        let viewer = Viewer {
            me: Some(&me),
            users: &users,
        };
        let of = |other: &str| channel(&dm(other), &viewer, None, None);

        assert_eq!(of("friend"), DEFAULT_PERMISSION_DIRECT_MESSAGE);
        assert_eq!(of("bot"), DEFAULT_PERMISSION_DIRECT_MESSAGE);
        assert_eq!(of("stranger"), VIEW_ONLY, "незнакомцу писать нельзя");
        assert_eq!(of("blocked"), VIEW_ONLY);
        assert_eq!(of("friend") & REACT, REACT);
    }

    #[test]
    fn group_owner_gets_everything() {
        let group: v0::Channel = serde_json::from_value(serde_json::json!({
            "channel_type": "Group", "_id": "g", "name": "Г", "owner": "me",
            "recipients": ["me", "u1"], "permissions": SEND_MESSAGE,
        }))
        .unwrap();
        let me = user("me", "User", false);
        let other = user("u1", "User", false);
        let mine = Viewer {
            me: Some(&me),
            users: &[],
        };
        let theirs = Viewer {
            me: Some(&other),
            users: &[],
        };
        assert_eq!(channel(&group, &mine, None, None), GRANT_ALL_SAFE);
        assert_eq!(
            channel(&group, &theirs, None, None),
            VIEW_ONLY | SEND_MESSAGE,
            "права группы плюс чтение"
        );
    }

    #[test]
    fn channel_overrides_apply_after_server() {
        const MANAGE_MESSAGES: u64 = 1 << 23;
        let server: v0::Server = serde_json::from_value(serde_json::json!({
            "_id": "s1", "owner": "boss", "name": "С", "channels": ["c1"],
            "roles": {"mod": {"_id": "mod", "name": "Модератор", "permissions": {"a": 0, "d": 0}, "rank": 1}},
            "default_permissions": VIEW_ONLY | SEND_MESSAGE | REACT,
            "approximate_member_count": 2,
        }))
        .unwrap();
        let text = |overrides: serde_json::Value| -> v0::Channel {
            let mut value = serde_json::json!({
                "channel_type": "TextChannel", "_id": "c1", "server": "s1", "name": "общий",
            });
            for (key, item) in overrides.as_object().unwrap() {
                value[key] = item.clone();
            }
            serde_json::from_value(value).unwrap()
        };
        let me = user("u1", "None", false);
        let viewer = Viewer {
            me: Some(&me),
            users: &[],
        };
        let plain = member(&[]);
        let moderator = member(&["mod"]);

        // в канале «только чтение» писать нельзя, модератору роль канала разрешает
        let readonly = text(serde_json::json!({
            "default_permissions": {"a": 0, "d": SEND_MESSAGE | REACT},
            "role_permissions": {"mod": {"a": SEND_MESSAGE | MANAGE_MESSAGES, "d": 0}},
        }));
        let value = channel(&readonly, &viewer, Some(&server), Some(&plain));
        assert_eq!(value & SEND_MESSAGE, 0);
        assert_eq!(value & REACT, 0);
        let value = channel(&readonly, &viewer, Some(&server), Some(&moderator));
        assert_eq!(
            value & (SEND_MESSAGE | MANAGE_MESSAGES),
            SEND_MESSAGE | MANAGE_MESSAGES
        );

        // скрытый канал не даёт ничего
        let hidden = text(serde_json::json!({"default_permissions": {"a": 0, "d": VIEW_CHANNEL}}));
        assert_eq!(channel(&hidden, &viewer, Some(&server), Some(&plain)), 0);

        // владельцу всё, чужому — ничего
        let boss = user("boss", "User", false);
        let owner = Viewer {
            me: Some(&boss),
            users: &[],
        };
        assert_eq!(
            channel(&hidden, &owner, Some(&server), None),
            GRANT_ALL_SAFE
        );
        assert_eq!(channel(&readonly, &viewer, Some(&server), None), 0);
    }

    #[test]
    fn timeout_leaves_only_reading() {
        let mut muted = member(&["mod"]);
        muted.timeout = serde_json::from_value(serde_json::json!("2999-01-01T00:00:00Z")).unwrap();
        assert_eq!(super::server(&server(), Some("u1"), Some(&muted)), 0);
    }
}

//! Права на сервере — так же, как их считает API (`calculate_server_permissions`).
//!
//! Нужны интерфейсу, чтобы показывать только доступные разделы настроек
//! сервера и действия над участниками; окончательно права проверяет сервер.
//! Значения битов интерфейс знает сам (`PERMISSIONS` в `server-settings.js`).

use revolt_models::v0;

/// Всё, что может владелец (`GrantAllSafe`).
pub const GRANT_ALL_SAFE: u64 = 0x000F_FFFF_FFFF_FFFF;

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

    let mut roles: Vec<&v0::Role> = member
        .roles
        .iter()
        .filter_map(|id| server.roles.get(id))
        .collect();
    roles.sort_by(|a, b| b.rank.cmp(&a.rank));

    let mut value = server.default_permissions as u64;
    for role in roles {
        value |= role.permissions.a as u64;
        value &= !(role.permissions.d as u64);
    }
    value
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
}

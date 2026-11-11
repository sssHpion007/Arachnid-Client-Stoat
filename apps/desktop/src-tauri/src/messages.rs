//! Действия над сообщением из контекстного меню (`MessageContextMenu.tsx`):
//! реакции, закрепление, «Пометить как непрочитанное» и жалоба
//! (`ReportContent.tsx`), поиск и закреплённые сообщения канала
//! (`TextSearchSidebar.tsx`), новая группа (`CreateGroup.tsx`).
//! Сетевая часть — в `stoat_core::http`.

use std::sync::Arc;

use serde_json::json;
use tauri::State;

use crate::views::HistoryView;
use crate::{AppState, CmdResult, CommandError, history_view, http_client};

/// Поставить реакцию: юникод-эмодзи или id своего эмодзи.
#[tauri::command]
pub async fn react_message(
    channel_id: String,
    message_id: String,
    emoji: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<()> {
    let http = http_client(&state).await?;
    http.react(&channel_id, &message_id, &emoji).await?;
    Ok(())
}

/// Убрать свою реакцию; с `remove_all` — этот эмодзи у всех
/// («Убрать реакцию» в меню, нужно право «Управлять сообщениями»).
#[tauri::command]
pub async fn unreact_message(
    channel_id: String,
    message_id: String,
    emoji: String,
    remove_all: Option<bool>,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<()> {
    let http = http_client(&state).await?;
    http.unreact(
        &channel_id,
        &message_id,
        &emoji,
        remove_all.unwrap_or(false),
    )
    .await?;
    Ok(())
}

/// «Убрать все реакции».
#[tauri::command]
pub async fn clear_reactions(
    channel_id: String,
    message_id: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<()> {
    let http = http_client(&state).await?;
    http.clear_reactions(&channel_id, &message_id).await?;
    Ok(())
}

/// Закрепить или открепить сообщение.
#[tauri::command]
pub async fn pin_message(
    channel_id: String,
    message_id: String,
    pinned: bool,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<()> {
    let http = http_client(&state).await?;
    http.set_pinned(&channel_id, &message_id, pinned).await?;
    Ok(())
}

/// «Пометить как непрочитанное»: отметка прочитанного ставится на это
/// сообщение, всё после него снова новое (`message.ack` в браузере).
#[tauri::command]
pub async fn mark_unread(
    channel_id: String,
    message_id: String,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<()> {
    let http = http_client(&state).await?;
    http.ack_message(&channel_id, &message_id).await?;
    state.cache.mark_unread(&channel_id, &message_id).await;
    Ok(())
}

/// Тело поиска (`DataMessageSearch`): строка или закреплённые сообщения.
///
/// Строка поиска у сервера — от 1 до 64 символов; закреплённые всегда
/// идут от новых к старым, как в браузерном клиенте.
fn search_body(
    query: Option<&str>,
    pinned: bool,
    sort: &str,
) -> Result<serde_json::Value, CommandError> {
    let sort = match sort {
        "Relevance" | "Latest" | "Oldest" => sort,
        _ => return Err(CommandError::new("invalid", "неизвестный порядок поиска")),
    };
    if pinned {
        return Ok(json!({ "pinned": true, "sort": "Latest", "limit": 100 }));
    }
    let query = query.map(str::trim).unwrap_or_default();
    if query.is_empty() || query.chars().count() > 64 {
        return Err(CommandError::new(
            "invalid",
            "строка поиска — от 1 до 64 символов",
        ));
    }
    Ok(json!({ "query": query, "sort": sort, "limit": 100 }))
}

/// Найти сообщения в канале или показать закреплённые.
#[tauri::command]
pub async fn search_messages(
    channel_id: String,
    query: Option<String>,
    pinned: Option<bool>,
    sort: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<HistoryView> {
    let body = search_body(
        query.as_deref(),
        pinned.unwrap_or(false),
        sort.as_deref().unwrap_or("Latest"),
    )?;
    let http = http_client(&state).await?;
    let response = http.search_messages(&channel_id, &body).await?;
    Ok(history_view(&state, &channel_id, response, false).await)
}

/// Создать группу с выбранными друзьями; возвращает id нового канала.
#[tauri::command]
pub async fn create_group(
    name: String,
    users: Vec<String>,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CommandError::new("invalid", "укажите название группы"));
    }
    let http = http_client(&state).await?;
    let channel = http.create_group(name, &users).await?;
    let id = match &channel {
        revolt_models::v0::Channel::Group { id, .. } => id.clone(),
        _ => return Err(CommandError::new("internal", "сервер вернул не группу")),
    };
    state.cache.insert_channel(channel).await;
    Ok(id)
}

/// Добавить друзей в группу (AddMembersToGroup.tsx): по одному, как в оригинале.
#[tauri::command]
pub async fn add_group_members(
    group_id: String,
    users: Vec<String>,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<()> {
    let http = http_client(&state).await?;
    for user in &users {
        http.add_group_member(&group_id, user).await?;
    }
    Ok(())
}

/// Причины жалобы на сообщение или сервер (`CONTENT_REPORT_REASONS`).
const CONTENT_REASONS: [&str; 14] = [
    "Illegal",
    "IllegalGoods",
    "IllegalExtortion",
    "IllegalPornography",
    "IllegalHacking",
    "ExtremeViolence",
    "PromotesHarm",
    "UnsolicitedSpam",
    "Raid",
    "SpamAbuse",
    "ScamsFraud",
    "Malware",
    "Harassment",
    "NoneSpecified",
];

/// Причины жалобы на пользователя (`USER_REPORT_REASONS`).
const USER_REASONS: [&str; 7] = [
    "UnsolicitedSpam",
    "SpamAbuse",
    "InappropriateProfile",
    "Impersonation",
    "BanEvasion",
    "Underage",
    "NoneSpecified",
];

/// Тело `content` жалобы. Без причины или с «Другое» без подробностей
/// жалобу не отправить — так же проверяет браузерный клиент.
fn report_body(
    kind: &str,
    id: &str,
    reason: &str,
    detail: &str,
    context_message: Option<&str>,
) -> Result<serde_json::Value, CommandError> {
    let allowed: &[&str] = match kind {
        "Message" | "Server" => &CONTENT_REASONS,
        "User" => &USER_REASONS,
        _ => return Err(CommandError::new("invalid", "неизвестный вид жалобы")),
    };
    if !allowed.contains(&reason) || (reason == "NoneSpecified" && detail.trim().is_empty()) {
        return Err(CommandError::new(
            "NoReasonProvided",
            "укажите причину жалобы",
        ));
    }
    let mut content = json!({ "type": kind, "id": id, "report_reason": reason });
    if kind == "User"
        && let Some(message) = context_message
    {
        content["message_id"] = json!(message);
    }
    Ok(content)
}

/// Пожаловаться модераторам Stoat на сообщение, сервер или пользователя.
#[tauri::command]
pub async fn report_content(
    kind: String,
    id: String,
    reason: String,
    detail: String,
    message_id: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> CmdResult<()> {
    let content = report_body(&kind, &id, &reason, &detail, message_id.as_deref())?;
    let http = http_client(&state).await?;
    http.report_content(&content, detail.trim()).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_needs_reason() {
        let body = report_body("Message", "m1", "Malware", "", None).unwrap();
        assert_eq!(
            body,
            json!({"type": "Message", "id": "m1", "report_reason": "Malware"})
        );

        assert!(report_body("Message", "m1", "", "", None).is_err());
        assert!(report_body("Message", "m1", "NoneSpecified", "  ", None).is_err());
        assert!(report_body("Message", "m1", "NoneSpecified", "спам", None).is_ok());
        // причины для пользователя к сообщению не подходят
        assert!(report_body("Message", "m1", "Underage", "", None).is_err());

        let user = report_body("User", "u1", "Impersonation", "", Some("m1")).unwrap();
        assert_eq!(user["message_id"], "m1");
    }

    #[test]
    fn search_body_follows_api_limits() {
        assert_eq!(
            search_body(Some(" привет "), false, "Relevance").unwrap(),
            json!({"query": "привет", "sort": "Relevance", "limit": 100})
        );
        assert_eq!(
            search_body(None, true, "Oldest").unwrap(),
            json!({"pinned": true, "sort": "Latest", "limit": 100})
        );
        assert!(search_body(Some("   "), false, "Latest").is_err());
        assert!(search_body(Some(&"а".repeat(65)), false, "Latest").is_err());
        assert!(search_body(Some("текст"), false, "Random").is_err());
    }
}

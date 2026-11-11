//! Действия над сообщением из контекстного меню (`MessageContextMenu.tsx`):
//! реакции, закрепление, «Пометить как непрочитанное» и жалоба
//! (`ReportContent.tsx`). Сетевая часть — в `stoat_core::http`.

use std::sync::Arc;

use serde_json::json;
use tauri::State;

use crate::{AppState, CmdResult, CommandError, http_client};

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
}

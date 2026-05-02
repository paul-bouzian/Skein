use std::sync::OnceLock;

use crate::domain::conversation::ConversationItem;
use crate::infrastructure::database::AppDatabase;

static ITEM_STORE: OnceLock<AppDatabase> = OnceLock::new();

pub fn install(database: AppDatabase) {
    let _ = ITEM_STORE.set(database);
}

fn db() -> Option<&'static AppDatabase> {
    ITEM_STORE.get()
}

/// Persist durable local projection metadata and provider-missing activity.
/// Provider history usually returns messages, but not always the local
/// `turn_id`/work-activity metadata needed to rebuild grouped activity after
/// restart. User messages stay provider-owned to avoid duplicating optimistic
/// composer entries.
fn should_persist(item: &ConversationItem) -> bool {
    match item {
        ConversationItem::Tool(_)
        | ConversationItem::System(_)
        | ConversationItem::AutoApprovalReview(_)
        | ConversationItem::Reasoning(_) => true,
        ConversationItem::Message(message) => {
            message.role == crate::domain::conversation::ConversationRole::Assistant
                && message.turn_id.is_some()
        }
    }
}

pub fn save(thread_id: &str, item: &ConversationItem) {
    if !should_persist(item) {
        return;
    }
    let Some(database) = db() else {
        return;
    };
    if let Err(error) = database.save_conversation_item(thread_id, item) {
        tracing::warn!(thread_id, ?error, "failed to persist conversation item");
    }
}

pub fn load(thread_id: &str) -> Vec<ConversationItem> {
    let Some(database) = db() else {
        return Vec::new();
    };
    match database.load_conversation_items(thread_id) {
        Ok(items) => items,
        Err(error) => {
            tracing::warn!(
                thread_id,
                ?error,
                "failed to load persisted conversation items"
            );
            Vec::new()
        }
    }
}

#[allow(dead_code)]
pub fn remove(thread_id: &str) {
    let Some(database) = db() else {
        return;
    };
    if let Err(error) = database.delete_conversation_items(thread_id) {
        tracing::warn!(
            thread_id,
            ?error,
            "failed to delete persisted conversation items"
        );
    }
}

pub fn remove_turn(thread_id: &str, turn_id: &str) {
    let Some(database) = db() else {
        return;
    };
    if let Err(error) = database.delete_conversation_items_for_turn(thread_id, turn_id) {
        tracing::warn!(
            thread_id,
            turn_id,
            ?error,
            "failed to delete persisted conversation items for turn"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::conversation::{
        AutoApprovalReviewStatus, ConversationAutoApprovalReviewItem, ConversationMessageItem,
        ConversationReasoningItem, ConversationRole,
    };

    #[test]
    fn persists_assistant_turn_metadata_but_not_provider_owned_user_messages() {
        let assistant = ConversationItem::Message(ConversationMessageItem {
            id: "assistant-1".to_string(),
            turn_id: Some("turn-1".to_string()),
            role: ConversationRole::Assistant,
            text: "Je cherche la météo.".to_string(),
            images: None,
            is_streaming: false,
        });
        let assistant_without_turn = ConversationItem::Message(ConversationMessageItem {
            id: "assistant-2".to_string(),
            turn_id: None,
            role: ConversationRole::Assistant,
            text: "Réponse historique.".to_string(),
            images: None,
            is_streaming: false,
        });
        let user = ConversationItem::Message(ConversationMessageItem {
            id: "user-1".to_string(),
            turn_id: Some("turn-1".to_string()),
            role: ConversationRole::User,
            text: "Fais une recherche météo.".to_string(),
            images: None,
            is_streaming: false,
        });

        assert!(should_persist(&assistant));
        assert!(!should_persist(&assistant_without_turn));
        assert!(!should_persist(&user));
    }

    #[test]
    fn persists_reasoning_activity_for_history_rebuilds() {
        let reasoning = ConversationItem::Reasoning(ConversationReasoningItem {
            id: "reasoning-1".to_string(),
            turn_id: Some("turn-1".to_string()),
            summary: "Thinking".to_string(),
            content: String::new(),
            is_streaming: false,
        });

        assert!(should_persist(&reasoning));
    }

    #[test]
    fn persists_auto_approval_review_items() {
        let review = ConversationItem::AutoApprovalReview(ConversationAutoApprovalReviewItem {
            id: "auto-review-1".to_string(),
            turn_id: Some("turn-1".to_string()),
            review_id: "review-1".to_string(),
            target_item_id: Some("tool-1".to_string()),
            action_kind: "command".to_string(),
            title: "Command auto-review".to_string(),
            status: AutoApprovalReviewStatus::Approved,
            risk_level: None,
            user_authorization: None,
            rationale: None,
            summary: "git push origin feature".to_string(),
        });

        assert!(should_persist(&review));
    }
}

import type { ConversationItem, ConversationReasoningItem } from "../../lib/types";

export function hasVisibleReasoningContent(item: ConversationReasoningItem) {
  return (
    item.isStreaming ||
    item.summary.trim().length > 0 ||
    item.content.trim().length > 0
  );
}

export function shouldRenderConversationItem(item: ConversationItem) {
  if (item.kind !== "reasoning") {
    return true;
  }

  return hasVisibleReasoningContent(item);
}

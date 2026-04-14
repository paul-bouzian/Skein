import type { EnvironmentRecord, ThreadConversationSnapshot, ThreadRecord } from "../../lib/types";
import {
  labelForConversationStatus,
  toneForConversationStatus,
} from "../../lib/conversation-status";
import { CloseIcon } from "../../shared/Icons";
import { Tooltip } from "../../shared/Tooltip";

type Props = {
  environment: EnvironmentRecord;
  thread: ThreadRecord;
  snapshot?: ThreadConversationSnapshot | null;
  connectionState?: "idle" | "connecting" | "error";
  onRetryConnection?: (() => void) | null;
  onClose?: (() => void) | null;
};

export function ConversationMeta({
  environment,
  thread,
  snapshot = null,
  connectionState = "idle",
  onRetryConnection = null,
  onClose = null,
}: Props) {
  return (
    <div className="tx-conversation__meta">
      <div>
        <h2 className="tx-conversation__title">{thread.title}</h2>
        <p className="tx-conversation__subtitle">
          {environment.name}
          {(snapshot?.codexThreadId ?? thread.codexThreadId) ? (
            <> · {snapshot?.codexThreadId ?? thread.codexThreadId}</>
          ) : null}
        </p>
      </div>
      <div className="tx-conversation__status-group">
        {snapshot ? (
          <span className={`tx-pill tx-pill--${toneForConversationStatus(snapshot.status)}`}>
            {labelForConversationStatus(snapshot.status)}
          </span>
        ) : null}
        {connectionState === "connecting" ? (
          <span className="tx-pill tx-pill--neutral tx-pill--connecting">
            Connecting…
          </span>
        ) : null}
        {connectionState === "error" ? (
          onRetryConnection ? (
            <button
              type="button"
              className="tx-pill tx-pill--neutral tx-pill--action"
              onClick={onRetryConnection}
            >
              Reconnect
            </button>
          ) : (
            <span className="tx-pill tx-pill--failed">Reconnect needed</span>
          )
        ) : null}
        {snapshot?.tokenUsage ? (
          <span className="tx-pill tx-pill--neutral">
            {snapshot.tokenUsage.total.totalTokens.toLocaleString()} tokens
          </span>
        ) : null}
        {onClose ? (
          <Tooltip content="Close pane" side="bottom">
            <button
              type="button"
              aria-label="Close pane"
              className="tx-conversation__close"
              onClick={onClose}
            >
              <CloseIcon size={12} />
            </button>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}

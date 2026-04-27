import { useEffect, useRef, useState } from "react";

import type { ProviderKind } from "../../lib/types";
import { ChevronRightIcon } from "../../shared/Icons";
import { ConversationItemRow } from "./ConversationItemRow";
import type {
  ConversationWorkActivityGroup as ConversationWorkActivityGroupData,
  WorkActivityStatus,
} from "./conversation-work-activity";

type Props = {
  group: ConversationWorkActivityGroupData;
  provider: ProviderKind;
};

const LIVE_TIMER_INTERVAL_MS = 500;

function isActiveStatus(status: WorkActivityStatus): boolean {
  return status === "running" || status === "waiting";
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0
    ? `${hours}h`
    : `${hours}h ${remainingMinutes}m`;
}

export function ConversationWorkActivityGroup({ group, provider }: Props) {
  const isActive = isActiveStatus(group.status);
  const [expanded, setExpanded] = useState(isActive);
  const wasActiveRef = useRef(isActive);
  const [, forceTick] = useState(0);

  // Auto-collapse when work transitions from active → done.
  useEffect(() => {
    if (wasActiveRef.current && !isActive) {
      setExpanded(false);
    }
    wasActiveRef.current = isActive;
  }, [isActive]);

  // Tick once a second while active so the live timer updates.
  useEffect(() => {
    if (!isActive || !group.startedAt) return undefined;
    const id = window.setInterval(
      () => forceTick((value) => (value + 1) % 1000),
      LIVE_TIMER_INTERVAL_MS,
    );
    return () => window.clearInterval(id);
  }, [isActive, group.startedAt]);

  const headerLabel = buildHeaderLabel(
    group.status,
    group.startedAt,
    group.finishedAt,
  );

  const hasContent = group.items.length > 0;

  return (
    <section className="tx-work-activity">
      <button
        type="button"
        className={`tx-work-activity__toggle ${
          expanded ? "tx-work-activity__toggle--expanded" : ""
        } tx-work-activity__toggle--${group.status}`}
        aria-expanded={expanded}
        aria-label="Toggle work activity"
        onClick={() => setExpanded((value) => !value)}
        disabled={!hasContent}
      >
        <ChevronRightIcon
          size={11}
          className={`tx-work-activity__chevron ${
            expanded ? "tx-work-activity__chevron--expanded" : ""
          }`}
        />
        <span className="tx-work-activity__label">{headerLabel}</span>
      </button>
      {expanded && hasContent ? (
        <div className="tx-work-activity__body">
          {group.items.map((item) => (
            <ConversationItemRow
              key={item.id}
              item={item}
              compact
              provider={provider}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function buildHeaderLabel(
  status: WorkActivityStatus,
  startedAt: number | null,
  finishedAt: number | null,
): string {
  if (status === "running" || status === "waiting") {
    if (!startedAt) return "Working…";
    return `Working for ${formatElapsed(Date.now() - startedAt)}`;
  }
  const duration =
    startedAt && finishedAt
      ? ` for ${formatElapsed(finishedAt - startedAt)}`
      : "";
  if (status === "failed") return `Failed${duration}`;
  if (status === "interrupted") return `Interrupted${duration}`;
  return duration ? `Worked${duration}` : "Worked";
}

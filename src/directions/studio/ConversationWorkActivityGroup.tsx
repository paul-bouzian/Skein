import { useEffect, useMemo, useRef, useState } from "react";

import type { SubagentThreadSnapshot } from "../../lib/types";
import { ChevronRightIcon } from "../../shared/Icons";
import { ConversationItemRow } from "./ConversationItemRow";
import { ConversationTaskCard } from "./ConversationTaskCard";
import type {
  ConversationWorkActivityGroup as ConversationWorkActivityGroupData,
  WorkActivityStatus,
} from "./conversation-work-activity";

type Props = {
  group: ConversationWorkActivityGroupData;
};

export function ConversationWorkActivityGroup({ group }: Props) {
  const [expanded, setExpanded] = useState(false);
  const sectionRef = useRef<HTMLElement | null>(null);
  const summary = useMemo(() => buildSummary(group), [group]);

  // When the user opens the panel, make sure the expanded body is visible
  // above the composer. scrollIntoView only scrolls the nearest scrollable
  // ancestor, so it targets the timeline without disturbing the window.
  useEffect(() => {
    if (!expanded) {
      return;
    }
    const section = sectionRef.current;
    if (!section) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      section.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [expanded]);

  return (
    <section ref={sectionRef} className="tx-work-activity">
      <button
        type="button"
        className="tx-work-activity__toggle"
        aria-expanded={expanded}
        aria-label={expanded ? "Hide work activity details" : "Show work activity details"}
        onClick={() => setExpanded((value) => !value)}
      >
        <div className="tx-work-activity__header">
          <span className="tx-item__header-main">
            <ChevronRightIcon
              size={12}
              className={`tx-item__chevron ${expanded ? "tx-item__chevron--expanded" : ""}`}
            />
            Work activity
          </span>
          <span className={`tx-pill tx-pill--${group.status}`}>
            {labelForStatus(group.status)}
          </span>
        </div>
        {summary ? <p className="tx-work-activity__summary">{summary}</p> : null}
      </button>
      {expanded ? (
        <div className="tx-work-activity__body">
          {group.taskPlan ? <ConversationTaskCard taskPlan={group.taskPlan} compact /> : null}
          {group.subagents.length > 0 ? (
            <div className="tx-work-activity__subagents">
              <div className="tx-item__header">Subagents</div>
              <div className="tx-work-activity__subagent-list">
                {group.subagents.map((subagent) => (
                  <div key={subagent.threadId} className="tx-work-activity__subagent">
                    <div className="tx-work-activity__subagent-copy">
                      <span className="tx-work-activity__subagent-name">
                        {labelForSubagent(subagent)}
                      </span>
                      {subagent.role ? (
                        <span className="tx-work-activity__subagent-role">{subagent.role}</span>
                      ) : null}
                    </div>
                    <span className={`tx-pill tx-pill--${toneForSubagent(subagent.status)}`}>
                      {labelForSubagentStatus(subagent.status)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {group.items.map((item) => (
            <ConversationItemRow key={item.id} item={item} compact />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function buildSummary(group: ConversationWorkActivityGroupData) {
  const parts = [
    formatCount(group.counts.updateCount + group.counts.systemCount, "update", "updates"),
    formatCount(group.counts.reasoningCount, "thinking", "thinking"),
    formatCount(group.counts.toolCount, "tool call", "tool calls"),
    formatCount(group.counts.subagentCount, "subagent", "subagents"),
  ].filter(Boolean);

  if (parts.length === 0 && group.taskPlan) {
    return "Task tracker";
  }

  return parts.join(" · ");
}

function formatCount(value: number, singular: string, plural: string) {
  if (value <= 0) {
    return "";
  }
  return `${value} ${value === 1 ? singular : plural}`;
}

function labelForStatus(status: WorkActivityStatus) {
  switch (status) {
    case "waiting":
      return "Waiting";
    case "interrupted":
      return "Interrupted";
    case "failed":
      return "Failed";
    case "completed":
      return "Completed";
    default:
      return "Running";
  }
}

function labelForSubagent(subagent: SubagentThreadSnapshot) {
  return subagent.nickname ?? subagent.role ?? subagent.threadId.slice(0, 8);
}

function labelForSubagentStatus(status: SubagentThreadSnapshot["status"]) {
  if (status === "running") return "Running";
  if (status === "failed") return "Failed";
  return "Completed";
}

function toneForSubagent(status: SubagentThreadSnapshot["status"]) {
  if (status === "running") return "running";
  if (status === "failed") return "failed";
  return "completed";
}

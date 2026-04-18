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
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const summary = useMemo(() => buildSummary(group), [group]);

  // On open, scroll the body to the end (newest content) so the panel
  // doesn't push the timeline around with old content.
  useEffect(() => {
    if (!expanded) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const body = bodyRef.current;
      if (body) {
        body.scrollTop = body.scrollHeight;
      }
      const prefersReducedMotion =
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      sectionRef.current?.scrollIntoView?.({
        behavior: prefersReducedMotion ? "auto" : "smooth",
        block: "nearest",
      });
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
        {summary ? <span className="tx-work-activity__summary">{summary}</span> : null}
      </button>
      <div
        className={`tx-work-activity__body-wrap ${expanded ? "tx-work-activity__body-wrap--open" : ""}`}
        aria-hidden={!expanded}
        inert={!expanded || undefined}
      >
        <div ref={bodyRef} className="tx-work-activity__body">
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
      </div>
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

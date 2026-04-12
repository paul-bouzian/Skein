import { useMemo, useState } from "react";

import type { SubagentThreadSnapshot } from "../../lib/types";
import { ChevronRightIcon } from "../../shared/Icons";
import "./SubagentStrip.css";

type Props = {
  subagents: SubagentThreadSnapshot[];
};

export function SubagentStrip({ subagents }: Props) {
  const [expanded, setExpanded] = useState(false);
  const runningCount = subagents.filter((subagent) => subagent.status === "running").length;
  const summary = useMemo(
    () => buildSummary(subagents, runningCount),
    [runningCount, subagents],
  );

  if (subagents.length === 0) {
    return null;
  }

  return (
    <div className={`tx-subagents ${expanded ? "tx-subagents--expanded" : ""}`}>
      <button
        type="button"
        className="tx-subagents__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="tx-subagents__header">
          <ChevronRightIcon
            size={12}
            className={`tx-subagents__chevron ${expanded ? "tx-subagents__chevron--expanded" : ""}`}
          />
          <span className="tx-subagents__title tx-section-label">Subagents</span>
        </span>
        <span className="tx-subagents__summary">{summary}</span>
      </button>
      {expanded ? (
        <div className="tx-subagents__list">
          {subagents.map((subagent) => (
            <div key={subagent.threadId} className="tx-subagents__item">
              <div className="tx-subagents__item-copy">
                <span className="tx-subagents__item-name">{labelForSubagent(subagent)}</span>
                {subagent.role ? (
                  <span className="tx-subagents__item-role">{subagent.role}</span>
                ) : null}
              </div>
              <span
                className={`tx-subagents__status tx-subagents__status--${subagent.status}`}
              >
                {statusLabel(subagent.status)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function labelForSubagent(subagent: SubagentThreadSnapshot) {
  return subagent.nickname ?? subagent.role ?? subagent.threadId.slice(0, 8);
}

function buildSummary(
  subagents: SubagentThreadSnapshot[],
  runningCount: number,
) {
  const names = subagents.slice(0, 3).map(labelForSubagent).join(", ");
  const countLabel = `${subagents.length} subagent${subagents.length === 1 ? "" : "s"}`;
  const statusLabel =
    runningCount > 0 ? `${countLabel} (${runningCount} running)` : countLabel;

  return names ? `${statusLabel} · ${names}` : statusLabel;
}

function statusLabel(status: SubagentThreadSnapshot["status"]) {
  if (status === "running") return "Running";
  if (status === "failed") return "Failed";
  return "Completed";
}

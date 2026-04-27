import { useState } from "react";

import type {
  ConversationStatus,
  ConversationTaskSnapshot,
  ProposedPlanStep,
  SubagentThreadSnapshot,
} from "../../lib/types";
import { CheckIcon, ChecklistIcon, ChevronRightIcon } from "../../shared/Icons";
import "./ConversationActiveTasksPanel.css";

type Props = {
  taskPlan: ConversationTaskSnapshot | null;
  subagents: SubagentThreadSnapshot[];
  status: ConversationStatus;
  activeTurnId: string | null;
};

export function ConversationActiveTasksPanel({
  taskPlan,
  subagents,
  status,
  activeTurnId,
}: Props) {
  const [expanded, setExpanded] = useState(true);
  const [agentsExpanded, setAgentsExpanded] = useState(false);

  const isWorking =
    status === "running" || status === "waitingForExternalAction";
  const hasActiveTaskPlan =
    taskPlan?.status === "running" &&
    (activeTurnId === null || taskPlan.turnId === activeTurnId);
  const steps = hasActiveTaskPlan ? taskPlan.steps : [];
  const fallbackTaskText = hasActiveTaskPlan ? taskPlanFallbackText(taskPlan) : null;
  const hasTasks = steps.length > 0;
  const hasTaskContent = hasTasks || fallbackTaskText !== null;
  const hasSubagents = subagents.length > 0;

  if (!isWorking || (!hasTaskContent && !hasSubagents)) {
    return null;
  }

  const completedCount = steps.filter(
    (step) => step.status === "completed",
  ).length;
  const headerLabel = hasTasks
    ? `${completedCount} out of ${steps.length} task${steps.length === 1 ? "" : "s"} completed`
    : "Working…";

  return (
    <aside
      className={`tx-active-tasks ${expanded ? "tx-active-tasks--expanded" : ""}`}
    >
      <button
        type="button"
        className="tx-active-tasks__header"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="tx-active-tasks__title">
          <ChecklistIcon size={14} className="tx-active-tasks__title-icon" />
          <span>{headerLabel}</span>
        </span>
        <ChevronRightIcon
          size={12}
          className={`tx-active-tasks__chevron ${
            expanded ? "tx-active-tasks__chevron--expanded" : ""
          }`}
        />
      </button>
      {expanded ? (
        <div className="tx-active-tasks__body">
          {hasTasks ? (
            <ol className="tx-active-tasks__list">
              {steps.map((step, index) => (
                <li
                  key={`${activeTurnId}-${index}`}
                  className={`tx-active-tasks__item tx-active-tasks__item--${step.status}`}
                >
                  <StepMarker status={step.status} index={index + 1} />
                  <span className="tx-active-tasks__step">{step.step}</span>
                </li>
              ))}
            </ol>
          ) : fallbackTaskText ? (
            <p className="tx-active-tasks__summary">{fallbackTaskText}</p>
          ) : null}
          {hasSubagents ? (
            <BackgroundAgentsSection
              subagents={subagents}
              expanded={agentsExpanded}
              onToggle={() => setAgentsExpanded((value) => !value)}
            />
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

function taskPlanFallbackText(taskPlan: ConversationTaskSnapshot) {
  const explanation = taskPlan.explanation.trim();
  if (explanation) return explanation;
  const markdown = taskPlan.markdown.trim();
  return markdown || null;
}

function StepMarker({
  status,
  index,
}: {
  status: ProposedPlanStep["status"];
  index: number;
}) {
  if (status === "completed") {
    return (
      <span
        className="tx-active-tasks__marker tx-active-tasks__marker--completed"
        aria-hidden="true"
      >
        <CheckIcon size={11} />
      </span>
    );
  }
  if (status === "inProgress") {
    return (
      <span
        className="tx-active-tasks__marker tx-active-tasks__marker--inProgress"
        aria-hidden="true"
      >
        <span className="tx-active-tasks__marker-spinner" />
      </span>
    );
  }
  return (
    <span
      className="tx-active-tasks__marker tx-active-tasks__marker--pending"
      aria-hidden="true"
    >
      <span className="tx-active-tasks__marker-index">{index}</span>
    </span>
  );
}

function BackgroundAgentsSection({
  subagents,
  expanded,
  onToggle,
}: {
  subagents: SubagentThreadSnapshot[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const runningCount = subagents.filter(
    (subagent) => subagent.status === "running",
  ).length;
  const totalLabel = `${subagents.length} agent${subagents.length === 1 ? "" : "s"}`;
  const summary =
    runningCount > 0 ? `${totalLabel} · ${runningCount} running` : totalLabel;

  return (
    <div
      className={`tx-active-tasks__agents ${
        expanded ? "tx-active-tasks__agents--expanded" : ""
      }`}
    >
      <button
        type="button"
        className="tx-active-tasks__agents-header"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="tx-active-tasks__agents-title">
          <ChevronRightIcon
            size={11}
            className={`tx-active-tasks__agents-chevron ${
              expanded ? "tx-active-tasks__agents-chevron--expanded" : ""
            }`}
          />
          <span>Background agents</span>
        </span>
        <span className="tx-active-tasks__agents-summary">{summary}</span>
      </button>
      {expanded ? (
        <ul className="tx-active-tasks__agents-list">
          {subagents.map((subagent, index) => (
            <li
              key={subagent.threadId}
              className="tx-active-tasks__agent-item"
            >
              <div className="tx-active-tasks__agent-copy">
                <span className="tx-active-tasks__agent-name">
                  {labelForSubagent(subagent, index)}
                </span>
                {subagent.role && subagent.nickname ? (
                  <span className="tx-active-tasks__agent-role">
                    {subagent.role}
                  </span>
                ) : null}
              </div>
              <span
                className={`tx-active-tasks__agent-status tx-active-tasks__agent-status--${subagent.status}`}
              >
                {labelForSubagentStatus(subagent.status)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function labelForSubagent(subagent: SubagentThreadSnapshot, index: number) {
  const nickname = subagent.nickname?.trim();
  if (nickname) return nickname;
  const role = subagent.role?.trim();
  if (role) return role;
  return `Agent ${index + 1}`;
}

function labelForSubagentStatus(status: SubagentThreadSnapshot["status"]) {
  if (status === "running") return "Running";
  if (status === "failed") return "Failed";
  return "Done";
}

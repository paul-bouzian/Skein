import type { ProposedPlanSnapshot } from "../../lib/types";
import { ConversationMarkdown } from "./ConversationMarkdown";
import { ConversationPlanSteps } from "./ConversationPlanSteps";

type Props = {
  plan: ProposedPlanSnapshot;
  disabled?: boolean;
  onApprove: () => void;
  onRefine: () => void;
};

export function ConversationPlanCard({
  plan,
  disabled = false,
  onApprove,
  onRefine,
}: Props) {
  const canAct = plan.isAwaitingDecision && plan.status === "ready" && !disabled;

  return (
    <section className="tx-plan-card">
      <div className="tx-plan-card__header">
        <div>
          <span className="tx-item__header">Proposed plan</span>
          {plan.explanation ? (
            <p className="tx-plan-card__explanation">{plan.explanation}</p>
          ) : null}
        </div>
        <span className={`tx-pill tx-pill--${labelToneForPlan(plan.status)}`}>
          {labelForPlanStatus(plan.status)}
        </span>
      </div>
      <ConversationPlanSteps turnId={plan.turnId} steps={plan.steps} />
      {plan.markdown ? (
        <ConversationMarkdown
          markdown={plan.markdown}
          className="tx-plan-card__markdown"
        />
      ) : (
        <p className="tx-plan-card__placeholder">Codex is still shaping the plan…</p>
      )}
      {plan.isAwaitingDecision ? (
        <div className="tx-plan-card__actions">
          <button
            type="button"
            className="tx-button tx-button--secondary"
            disabled={disabled}
            onClick={onRefine}
          >
            Refine
          </button>
          <button
            type="button"
            className="tx-button"
            disabled={!canAct}
            onClick={onApprove}
          >
            Approve plan
          </button>
        </div>
      ) : null}
    </section>
  );
}

function labelForPlanStatus(status: ProposedPlanSnapshot["status"]) {
  switch (status) {
    case "approved":
      return "Approved";
    case "ready":
      return "Ready";
    case "superseded":
      return "Superseded";
    default:
      return "Streaming";
  }
}

function labelToneForPlan(status: ProposedPlanSnapshot["status"]) {
  switch (status) {
    case "approved":
      return "completed";
    case "ready":
      return "running";
    case "superseded":
      return "neutral";
    default:
      return "neutral";
  }
}

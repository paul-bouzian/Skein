import { ChevronRightIcon } from "../../shared/Icons";
import type { ProposedPlanSnapshot } from "../../lib/types";
import { ConversationMarkdown } from "./ConversationMarkdown";

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
      {plan.steps.length > 0 ? (
        <ol className="tx-plan-card__steps">
          {plan.steps.map((step, index) => (
            <li key={`${plan.turnId}-${index}`} className="tx-plan-card__step">
              <span
                className={`tx-plan-card__step-marker tx-plan-card__step-marker--${step.status}`}
                aria-hidden="true"
              >
                <ChevronRightIcon size={10} />
              </span>
              <div>
                <p className="tx-plan-card__step-title">{step.step}</p>
                <span className="tx-plan-card__step-status">
                  {labelForStepStatus(step.status)}
                </span>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
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

function labelForStepStatus(status: string) {
  if (status === "inProgress") return "In progress";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

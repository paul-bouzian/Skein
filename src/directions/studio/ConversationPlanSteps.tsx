import { ChevronRightIcon } from "../../shared/Icons";
import type { ProposedPlanStep } from "../../lib/types";

type Props = {
  turnId: string;
  steps: ProposedPlanStep[];
};

export function ConversationPlanSteps({ turnId, steps }: Props) {
  if (steps.length === 0) {
    return null;
  }

  return (
    <ol className="tx-plan-card__steps">
      {steps.map((step, index) => (
        <li key={`${turnId}-${index}`} className="tx-plan-card__step">
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
  );
}

function labelForStepStatus(status: ProposedPlanStep["status"]) {
  if (status === "inProgress") return "In progress";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

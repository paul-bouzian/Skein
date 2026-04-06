import type { ConversationTaskSnapshot } from "../../lib/types";
import { ConversationLinkedText } from "./ConversationLinkedText";
import { ConversationMarkdown } from "./ConversationMarkdown";
import { ConversationPlanSteps } from "./ConversationPlanSteps";

type Props = {
  taskPlan: ConversationTaskSnapshot;
};

export function ConversationTaskCard({ taskPlan }: Props) {
  return (
    <section className="tx-plan-card tx-task-card">
      <div className="tx-plan-card__header">
        <div>
          <span className="tx-item__header">Tasks</span>
          {taskPlan.explanation ? (
            <ConversationLinkedText
              as="p"
              className="tx-plan-card__explanation"
              text={taskPlan.explanation}
            />
          ) : null}
        </div>
        <span className={`tx-pill tx-pill--${labelToneForTask(taskPlan.status)}`}>
          {labelForTaskStatus(taskPlan.status)}
        </span>
      </div>
      <ConversationPlanSteps turnId={taskPlan.turnId} steps={taskPlan.steps} />
      {taskPlan.markdown ? (
        <ConversationMarkdown
          markdown={taskPlan.markdown}
          className="tx-plan-card__markdown"
        />
      ) : null}
    </section>
  );
}

function labelForTaskStatus(status: ConversationTaskSnapshot["status"]) {
  switch (status) {
    case "completed":
      return "Completed";
    case "interrupted":
      return "Interrupted";
    case "failed":
      return "Failed";
    default:
      return "Running";
  }
}

function labelToneForTask(status: ConversationTaskSnapshot["status"]) {
  switch (status) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "failed";
    default:
      return "running";
  }
}

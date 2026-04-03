import { Fragment } from "react";

import { ChevronRightIcon } from "../../shared/Icons";
import type { ProposedPlanSnapshot } from "../../lib/types";

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
        <div className="tx-plan-card__markdown">
          <PlanMarkdown markdown={plan.markdown} />
        </div>
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

function PlanMarkdown({ markdown }: { markdown: string }) {
  const blocks = parseMarkdownBlocks(markdown);

  return (
    <>
      {blocks.map((block, index) => {
        if (block.kind === "heading") {
          return (
            <h4 key={`${block.kind}-${index}`} className="tx-plan-card__markdown-heading">
              {block.text}
            </h4>
          );
        }

        if (block.kind === "unorderedList") {
          return (
            <ul key={`${block.kind}-${index}`} className="tx-plan-card__markdown-list">
              {block.items.map((item, itemIndex) => (
                <li key={`${item}-${itemIndex}`}>{renderInlineText(item)}</li>
              ))}
            </ul>
          );
        }

        if (block.kind === "orderedList") {
          return (
            <ol key={`${block.kind}-${index}`} className="tx-plan-card__markdown-list">
              {block.items.map((item, itemIndex) => (
                <li key={`${item}-${itemIndex}`}>{renderInlineText(item)}</li>
              ))}
            </ol>
          );
        }

        return (
          <p key={`${block.kind}-${index}`} className="tx-plan-card__markdown-paragraph">
            {renderInlineText(block.text)}
          </p>
        );
      })}
    </>
  );
}

type MarkdownBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "unorderedList"; items: string[] }
  | { kind: "orderedList"; items: string[] };

function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]?.trim() ?? "";
    if (!line) {
      index += 1;
      continue;
    }

    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      blocks.push({ kind: "heading", text: heading[1] });
      index += 1;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const [items, nextIndex] = consumeListItems(lines, index, /^[-*]\s*(.*)$/);
      index = nextIndex;
      if (items.length > 0) {
        blocks.push({ kind: "unorderedList", items });
      }
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const [items, nextIndex] = consumeListItems(lines, index, /^\d+\.\s*(.*)$/);
      index = nextIndex;
      if (items.length > 0) {
        blocks.push({ kind: "orderedList", items });
      }
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const candidate = lines[index]?.trim() ?? "";
      if (!candidate || /^#{1,6}\s+/.test(candidate) || /^[-*]\s+/.test(candidate) || /^\d+\.\s+/.test(candidate)) {
        break;
      }
      paragraphLines.push(candidate);
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks;
}

function consumeListItems(lines: string[], startIndex: number, pattern: RegExp) {
  const items: string[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const candidate = lines[index]?.trim() ?? "";
    const match = candidate.match(pattern);
    if (!match) {
      break;
    }
    const item = match[1]?.trim() ?? "";
    if (item) {
      items.push(item);
    }
    index += 1;
  }

  return [items, index] as const;
}

function renderInlineText(text: string) {
  const parts = text.split(/(`[^`]+`)/g).filter(Boolean);

  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={`${part}-${index}`} className="tx-plan-card__markdown-code">
          {part.slice(1, -1)}
        </code>
      );
    }

    return <Fragment key={`${part}-${index}`}>{part}</Fragment>;
  });
}

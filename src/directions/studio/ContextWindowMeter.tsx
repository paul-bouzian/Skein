import { deriveContextWindowSnapshot, formatContextWindowTokens } from "../../lib/context-window";
import type { ThreadTokenUsageSnapshot } from "../../lib/types";
import "./ContextWindowMeter.css";

type Props = {
  usage?: ThreadTokenUsageSnapshot | null;
};

export function ContextWindowMeter({ usage }: Props) {
  const snapshot = deriveContextWindowSnapshot(usage);
  if (!snapshot) {
    return null;
  }

  const percentageLabel = formatPercentageLabel(snapshot.usedPercentage);
  const radius = 10;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (snapshot.usedPercentage / 100) * circumference;

  return (
    <div className="tx-context-meter">
      <button
        type="button"
        className="tx-context-meter__trigger"
        aria-label={`Context window ${percentageLabel}% used`}
      >
        <span className="tx-context-meter__visual">
          <svg viewBox="0 0 28 28" className="tx-context-meter__ring" aria-hidden="true">
            <circle
              cx="14"
              cy="14"
              r={radius}
              className="tx-context-meter__track"
            />
            <circle
              cx="14"
              cy="14"
              r={radius}
              className="tx-context-meter__progress"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
            />
          </svg>
          <span className="tx-context-meter__value">{percentageLabel}</span>
        </span>
      </button>
      <div className="tx-context-meter__tooltip" role="tooltip">
        <div className="tx-context-meter__tooltip-label">Context window</div>
        <div className="tx-context-meter__tooltip-line">
          {percentageLabel}% · {formatContextWindowTokens(snapshot.usedTokens)}/
          {formatContextWindowTokens(snapshot.maxTokens)} context used
        </div>
        {snapshot.totalProcessedTokens ? (
          <div className="tx-context-meter__tooltip-muted">
            Total processed: {formatContextWindowTokens(snapshot.totalProcessedTokens)} tokens
          </div>
        ) : null}
        <div className="tx-context-meter__tooltip-muted">
          Automatically compacts its context when needed.
        </div>
      </div>
    </div>
  );
}

function formatPercentageLabel(value: number) {
  return value < 10
    ? value.toFixed(1).replace(/\.0$/, "")
    : `${Math.round(value)}`;
}

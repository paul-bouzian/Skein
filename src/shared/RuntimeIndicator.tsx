import type { RuntimeState } from "../lib/types";
import "./RuntimeIndicator.css";

type RuntimeIndicatorTone =
  | "neutral"
  | "running"
  | "progress"
  | "completed"
  | "warning"
  | "failed"
  | "waiting";

type Props = {
  state?: RuntimeState;
  tone?: RuntimeIndicatorTone;
  size?: "sm" | "md";
  label?: boolean;
  labelText?: string;
};

const labels: Record<RuntimeState, string> = {
  running: "Running",
  stopped: "Stopped",
  exited: "Exited",
};

function toneFromRuntimeState(state: RuntimeState): RuntimeIndicatorTone {
  switch (state) {
    case "running":
      return "running";
    case "stopped":
      return "neutral";
    case "exited":
      return "warning";
  }
}

export function RuntimeIndicator({
  state = "stopped",
  tone,
  size = "sm",
  label = false,
  labelText,
}: Props) {
  const resolvedTone = tone ?? toneFromRuntimeState(state);
  const resolvedLabel = labelText ?? labels[state];

  return (
    <span className={`runtime-indicator runtime-indicator--${size}`}>
      <span className={`runtime-indicator__dot runtime-indicator__dot--${resolvedTone}`} />
      {label ? <span className="runtime-indicator__label">{resolvedLabel}</span> : null}
    </span>
  );
}

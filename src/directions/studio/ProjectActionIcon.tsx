import type { ProjectActionIcon } from "../../lib/types";
import {
  BugIcon,
  ChecklistIcon,
  HammerIcon,
  PlayIcon,
  TestTubeIcon,
  WrenchIcon,
} from "../../shared/Icons";

type Props = {
  icon: ProjectActionIcon;
  size?: number;
  className?: string;
};

export function ProjectActionIcon({ icon, size = 16, className }: Props) {
  if (icon === "test") {
    return <TestTubeIcon size={size} className={className} />;
  }
  if (icon === "lint") {
    return <ChecklistIcon size={size} className={className} />;
  }
  if (icon === "configure") {
    return <WrenchIcon size={size} className={className} />;
  }
  if (icon === "build") {
    return <HammerIcon size={size} className={className} />;
  }
  if (icon === "debug") {
    return <BugIcon size={size} className={className} />;
  }
  return <PlayIcon size={size} className={className} />;
}

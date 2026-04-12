import type { OpenTarget } from "../../lib/types";
import { FolderIcon, OpenInIcon } from "../../shared/Icons";

type Props = {
  target: OpenTarget;
  iconUrl?: string | null;
  size?: number;
  className?: string;
};

export function OpenTargetIcon({
  target,
  iconUrl,
  size = 16,
  className,
}: Props) {
  if (iconUrl) {
    return (
      <img
        src={iconUrl}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        className={className}
      />
    );
  }

  if (target.kind === "fileManager") {
    return <FolderIcon size={size} className={className} />;
  }

  return <OpenInIcon size={size} className={className} />;
}

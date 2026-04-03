type IconProps = {
  size?: number;
  className?: string;
};

export function FolderIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path
        d="M2 4a1 1 0 011-1h3.586a1 1 0 01.707.293L8.414 4.414A1 1 0 009.12 4.707H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1V4z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

export function SearchIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <circle cx="7" cy="7" r="4" stroke="currentColor" strokeWidth="1.2" />
      <path d="M10 10l3.5 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function SettingsIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path
        d="M6.86 2h2.28l.32 1.6a5 5 0 011.18.68l1.54-.52.98 1.7-1.22 1.08a5 5 0 010 1.36l1.22 1.08-.98 1.7-1.54-.52a5 5 0 01-1.18.68L9.14 14H6.86l-.32-1.6a5 5 0 01-1.18-.68l-1.54.52-.98-1.7 1.22-1.08a5 5 0 010-1.36L2.84 7.02l.98-1.7 1.54.52a5 5 0 011.18-.68L6.86 2z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

export function SunIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function MoonIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ChevronRightIcon({ size = 12, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" className={className}>
      <path d="M4.5 2.5l3.5 3.5-3.5 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PlusIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function CloseIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function CheckIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path
        d="M3.5 8.5 6.5 11.5 12.5 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PanelRightIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M10 3v10" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export function PlayIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M5 3.5v9l7-4.5-7-4.5z" fill="currentColor" />
    </svg>
  );
}

export function SendIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path
        d="M13.5 2.5 7 13l-1.5-4.5L1 7l12.5-4.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function StopIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" />
    </svg>
  );
}

export function ThreadIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <path
        d="M3 3h10v7a1 1 0 01-1 1H6l-3 2.5V3z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function GitBranchIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <circle cx="5" cy="4" r="1.5" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="5" cy="12" r="1.5" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="11" cy="7" r="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5 5.5v5M5 5.5c0 2 1 2.5 4.5 1.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

import type { ReactNode } from "react";

type Props = {
  title: string;
  description?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
  layout?: "inline" | "stacked";
  tone?: "default" | "muted";
  className?: string;
};

export function SettingsRow({
  title,
  description,
  control,
  children,
  layout = "inline",
  tone = "default",
  className,
}: Props) {
  const classes = [
    "settings-row",
    `settings-row--${layout}`,
    tone === "muted" ? "settings-row--muted" : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes}>
      <div className="settings-row__head">
        <div className="settings-row__copy">
          <h3 className="settings-row__title">{title}</h3>
          {description ? (
            <p className="settings-row__description">{description}</p>
          ) : null}
        </div>
        {control ? <div className="settings-row__control">{control}</div> : null}
      </div>
      {children ? <div className="settings-row__body">{children}</div> : null}
    </div>
  );
}

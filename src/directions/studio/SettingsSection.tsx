import type { ReactNode } from "react";

type Props = {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
};

export function SettingsSection({ title, description, action, children }: Props) {
  return (
    <section className="settings-section">
      <header className="settings-section__header">
        <div className="settings-section__heading">
          <h2 className="settings-section__title">{title}</h2>
          {description ? (
            <p className="settings-section__description">{description}</p>
          ) : null}
        </div>
        {action ? <div className="settings-section__action">{action}</div> : null}
      </header>
      <div className="settings-section__rows">{children}</div>
    </section>
  );
}

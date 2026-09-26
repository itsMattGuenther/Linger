import { type ReactNode, useId } from "react";
import "./SettingRow.css";

/**
 * One setting: its name, a line saying what it does, and its control at the
 * end. The control is labelled by the name, so a `Switch` here needs no
 * separate label of its own.
 */
export function SettingRow({
  title,
  description,
  control,
}: {
  title: string;
  description?: string;
  /** A `Switch`, a `Button`, a select. */
  control: ReactNode;
}) {
  const id = useId();
  return (
    <div className="k-setting" data-kit="SettingRow" role="group" aria-labelledby={id}>
      <span className="k-setting-text">
        <span id={id} className="k-setting-title">
          {title}
        </span>
        {description ? <span className="k-setting-description">{description}</span> : null}
      </span>
      <span className="k-setting-control">{control}</span>
    </div>
  );
}

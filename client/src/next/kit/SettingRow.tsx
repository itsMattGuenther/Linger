import { type ReactNode, useId } from "react";
import "./SettingRow.css";

/**
 * One setting: its name, a line saying what it does, and its control at the
 * end. The control is labelled by the name, so a `Switch` here needs no
 * separate label of its own.
 *
 * `wide` is for a control that needs the row's width, like a `Slider`: it
 * goes on a line of its own under the words, as wide as the row, rather than
 * squeezing them in a narrow window.
 */
export function SettingRow({
  title,
  description,
  control,
  wide = false,
}: {
  title: string;
  description?: string;
  /** A `Switch`, a `Button`, a select; with `wide`, a slider. */
  control: ReactNode;
  wide?: boolean;
}) {
  const id = useId();
  return (
    <div className="k-setting" data-kit="SettingRow" data-wide={wide ? "" : undefined} role="group" aria-labelledby={id}>
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

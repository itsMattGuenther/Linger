import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import "./Notice.css";

/**
 * A small card that comes and goes on its own: "Callie came into #general",
 * "Jules knocked". It is announced politely and asks for nothing.
 */
export function Notice({ icon, children, tag }: { icon: IconName; children: ReactNode; tag?: ReactNode }) {
  return (
    <div className="k-notice" data-kit="Notice" role="status">
      <span className="k-notice-icon">
        <Icon name={icon} size="md" />
      </span>
      <span className="k-notice-text">{children}</span>
      {tag ? <span className="k-notice-tag">{tag}</span> : null}
    </div>
  );
}

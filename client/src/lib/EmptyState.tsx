import type { ReactNode } from "react";
import PorchMark from "./PorchMark";

/** A quiet starting point, shown only when there is genuinely nothing to display. */
export default function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <PorchMark decorative />
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}

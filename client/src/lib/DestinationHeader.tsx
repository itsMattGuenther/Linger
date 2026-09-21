import type { ReactNode } from "react";
import Button from "./Button";
import "./destination-header.css";

/** Give destinations the same heading and dismissal without changing their content. */
export default function DestinationHeader({
  title,
  description,
  closeLabel = "Close",
  onClose,
  children,
}: {
  title: string;
  description?: ReactNode;
  closeLabel?: string;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <header className="stream-header destination-header">
      <h2 className="destination-title">{title}</h2>
      <Button
        className="destination-close"
        icon="close"
        aria-label={closeLabel}
        onClick={onClose}
      >
        Close
      </Button>
      {description ? <p className="destination-description meta">{description}</p> : null}
      {children}
    </header>
  );
}

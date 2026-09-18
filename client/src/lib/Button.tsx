import type { ButtonHTMLAttributes, ComponentProps } from "react";
import { ActionIcon } from "./icons";

/** Share action hierarchy and states between the app and its review guide. */
export default function Button({
  variant = "secondary",
  icon,
  className = "",
  children,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary";
  icon?: ComponentProps<typeof ActionIcon>["name"];
}) {
  return (
    <button
      {...props}
      type={type}
      className={`ui-action ${variant === "primary" ? "ui-primary" : ""} ${className}`}
    >
      {icon ? <ActionIcon name={icon} /> : null}
      {children}
    </button>
  );
}

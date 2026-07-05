import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "default" | "primary" | "ghost";
export type ButtonSize = "default" | "small" | "lg";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  square?: boolean;
  icon?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = "default",
  size = "default",
  square,
  icon,
  children,
  ...rest
}: ButtonProps) {
  const cls = ["wf-btn"];
  if (variant === "primary") cls.push("primary");
  if (variant === "ghost") cls.push("ghost");
  if (size === "small") cls.push("small");
  if (size === "lg") cls.push("lg");
  if (square) cls.push("square");
  if (icon) cls.push("icon");
  return (
    <button data-wf="Button" className={cls.join(" ")} {...rest}>
      {children}
    </button>
  );
}

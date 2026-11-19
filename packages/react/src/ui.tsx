import type { ButtonHTMLAttributes } from "react";

/** Class names come from table.css (the `btn` piece). `primary` is the one brass button per screen. */
const variants = {
  primary: "btn primary",
  secondary: "btn",
  danger: "btn danger",
};

export function Button({
  variant = "secondary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof variants }) {
  return <button type="button" className={`${variants[variant]} ${className}`.trim()} {...props} />;
}

/** Inputs and selects are styled by element in table.css, so this adds nothing. */
export const inputClass = "";

/** A slip of paper lying on the felt. */
export const cardClass = "paper slip";

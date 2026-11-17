import type { ButtonHTMLAttributes } from "react";

const base =
  "inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-50";
const variants = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-500 disabled:hover:bg-indigo-600",
  secondary:
    "border border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700",
  danger:
    "border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950",
};

export function Button({
  variant = "secondary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof variants }) {
  return (
    <button type="button" className={`${base} ${variants[variant]} ${className}`} {...props} />
  );
}

export const inputClass =
  "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-base text-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-indigo-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100";

export const cardClass =
  "rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900";

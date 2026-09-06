import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type Props = InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
  error?: string;
};

export const Input = forwardRef<HTMLInputElement, Props>(function Input(
  { className, label, hint, error, id, ...rest },
  ref,
) {
  const inputId = id ?? rest.name;
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;

  return (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={inputId} className="block text-xs font-medium text-secondary">
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          "w-full h-10 px-3 rounded-[var(--radius)] bg-input text-primary text-sm",
          "border border-subtle placeholder:text-tertiary",
          "focus:border-accent focus:outline-none focus-visible:outline-none",
          "transition-colors",
          error && "border-danger",
          className,
        )}
        {...rest}
      />
      {error ? (
        // Errors are announced: a form that only shows a colour change is
        // invisible to a screen reader and easy to miss on a dense page.
        <p id={`${inputId}-error`} role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="text-xs text-tertiary">
          {hint}
        </p>
      ) : null}
    </div>
  );
});

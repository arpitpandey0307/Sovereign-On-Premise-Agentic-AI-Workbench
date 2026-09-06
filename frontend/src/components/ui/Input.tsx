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
    <div>
      {label && (
        <label htmlFor={inputId} className="field-label">
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn("input", error && "err", className)}
        {...rest}
      />
      {error ? (
        // Errors are announced: a form that only shows a colour change is
        // invisible to a screen reader and easy to miss on a dense page.
        <p
          id={`${inputId}-error`}
          role="alert"
          className="mt-1.5 text-[12.5px]"
          style={{ color: "var(--danger-text)" }}
        >
          {error}
        </p>
      ) : hint ? (
        <p
          id={`${inputId}-hint`}
          className="mt-1.5 text-[12.5px]"
          style={{ color: "var(--text-mute)" }}
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
});

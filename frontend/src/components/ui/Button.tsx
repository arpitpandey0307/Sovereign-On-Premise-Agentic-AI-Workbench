import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

// The vocabulary is the `front` design system's: `.btn` is the neutral base,
// and a modifier tints it. `secondary` is the bare base with no modifier.
const VARIANTS: Record<Variant, string> = {
  primary: "btn-primary",
  secondary: "",
  ghost: "btn-ghost",
  danger: "btn-danger",
};

const SIZES: Record<Size, string> = {
  sm: "btn-sm",
  md: "",
  lg: "btn-lg",
};

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { className, variant = "primary", size = "md", loading, disabled, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      // A loading button stays disabled so a slow request cannot be fired twice.
      disabled={disabled || loading}
      className={cn("btn", VARIANTS[variant], SIZES[size], className)}
      {...rest}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
});

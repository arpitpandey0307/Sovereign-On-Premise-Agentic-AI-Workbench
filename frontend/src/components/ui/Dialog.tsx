/**
 * A modal dialog.
 *
 * Built on the native `<dialog>` element rather than a portal and a stack of
 * hand-written listeners, because the platform already implements the parts
 * that are easy to get subtly wrong: the top layer, the inert backdrop, focus
 * containment, and Escape.
 *
 * The application's most important dialog is the approval gate, where someone
 * authorises an agent to act. Focus must be trapped and the choice must be
 * deliberate, so a dialog marked `decision` does not close on a backdrop click
 * or on Escape -- a stray click cannot count as an answer.
 */

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  decision = false,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** An answer is required; dismissing by accident is not one. */
  decision?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    // Escape fires `cancel` before `close`. Preventing it there is the only
    // way to refuse the dismissal rather than undo it afterwards.
    const onCancel = (event: Event) => {
      if (decision) event.preventDefault();
      else onClose();
    };
    const onNativeClose = () => onClose();

    node.addEventListener("cancel", onCancel);
    node.addEventListener("close", onNativeClose);
    return () => {
      node.removeEventListener("cancel", onCancel);
      node.removeEventListener("close", onNativeClose);
    };
  }, [decision, onClose]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="dialog-title"
      className={cn(
        "m-auto w-[min(36rem,calc(100vw-2rem))] rounded-[var(--radius)] p-0",
        "border border-subtle bg-panel text-primary shadow-2xl",
        "backdrop:bg-black/60 backdrop:backdrop-blur-sm",
        className,
      )}
      onClick={(event) => {
        // A click on the element itself, rather than on its contents, is a
        // click on the backdrop: `<dialog>` fills the viewport.
        if (!decision && event.target === ref.current) onClose();
      }}
    >
      <div className="flex items-start justify-between gap-4 border-b border-subtle px-5 py-4">
        <div className="min-w-0">
          <h2 id="dialog-title" className="text-sm font-semibold">
            {title}
          </h2>
          {description && (
            <p className="mt-1 text-xs text-tertiary">{description}</p>
          )}
        </div>
        {!decision && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-tertiary transition hover:bg-subtle hover:text-primary"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      {children && <div className="px-5 py-4 text-sm">{children}</div>}

      {footer && (
        <div className="flex justify-end gap-2 border-t border-subtle px-5 py-3">
          {footer}
        </div>
      )}
    </dialog>
  );
}

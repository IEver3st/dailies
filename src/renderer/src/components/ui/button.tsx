import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Tooltip as T } from "radix-ui";
import { cn } from "@/lib/format";

type Variant = "primary" | "quiet" | "ghost" | "danger";

const variants: Record<Variant, string> = {
  primary: "bg-amber text-amber-ink hover:brightness-110 disabled:bg-raised disabled:text-faint",
  quiet: "bg-raised text-text hover:bg-hover disabled:text-faint",
  ghost: "text-soft hover:bg-raised hover:text-text disabled:text-faint",
  danger: "bg-raised text-red hover:bg-hover",
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }>(function Button(
  { variant = "quiet", size = "md", className, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        "no-drag inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-semibold whitespace-nowrap transition-colors disabled:cursor-default",
        size === "md" ? "h-8 px-3.5 text-[13.5px]" : "h-7 px-2.5 text-[12.5px]",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
});

export function Tip({ label, keys, children, side = "top" }: { label: string; keys?: string; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <T.Root delayDuration={350}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content side={side} sideOffset={6} className="z-50 flex items-center gap-2 rounded-md bg-raised px-2.5 py-1.5 text-[12.5px] text-text shadow-[0_6px_24px_rgba(0,0,0,.45)]">
          {label}
          {keys && <span className="rounded bg-ink px-1.5 py-px text-[11.5px] text-soft">{keys}</span>}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; keys?: string; active?: boolean; side?: "top" | "bottom" | "left" | "right" }>(
  function IconButton({ label, keys, active, side, className, children, ...props }, ref) {
    return (
      <Tip label={label} keys={keys} side={side}>
        <button
          ref={ref}
          aria-label={label}
          aria-pressed={active}
          className={cn(
            "no-drag grid size-8 shrink-0 place-items-center rounded-lg transition-colors disabled:text-faint [&_svg]:size-[17px]",
            active ? "bg-raised text-amber" : "text-soft hover:bg-raised hover:text-text",
            className,
          )}
          {...props}
        >
          {children}
        </button>
      </Tip>
    );
  },
);

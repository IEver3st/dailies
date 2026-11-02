import { Tabs as R } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "@/lib/format";

export const Tabs = R.Root;
export const TabsContent = R.Content;

export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  return <R.List className={cn("flex gap-5 px-5", className)}>{children}</R.List>;
}

export function Tab({ value, children, count }: { value: string; children: ReactNode; count?: number }) {
  return (
    <R.Trigger
      value={value}
      className="relative py-3 font-medium text-dim transition-colors hover:text-soft data-[state=active]:text-text data-[state=active]:after:absolute data-[state=active]:after:inset-x-0 data-[state=active]:after:bottom-0 data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-full data-[state=active]:after:bg-amber"
    >
      {children}
      {count ? <span className="ml-1.5 text-faint">{count}</span> : null}
    </R.Trigger>
  );
}

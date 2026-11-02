import type { ReactNode } from "react";
import { cn } from "@/lib/format";

export function Heading({ children, count, className }: { children: ReactNode; count?: number; className?: string }) {
  return (
    <h2 className={cn("flex items-baseline gap-2.5 text-[15px] font-semibold", className)}>
      {children}
      {count !== undefined && <span className="text-[13px] font-medium text-faint">{count}</span>}
    </h2>
  );
}

import { DropdownMenu as D } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "@/lib/format";

export const Menu = D.Root;
export const MenuTrigger = D.Trigger;

export function MenuContent({ children, align = "end" }: { children: ReactNode; align?: "start" | "end" | "center" }) {
  return (
    <D.Portal>
      <D.Content align={align} sideOffset={6} className="z-50 min-w-48 rounded-xl bg-raised p-1.5 shadow-[0_12px_40px_rgba(0,0,0,.5)]">
        {children}
      </D.Content>
    </D.Portal>
  );
}

export function MenuItem({ children, onSelect, danger, disabled }: { children: ReactNode; onSelect?: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <D.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn("flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 outline-none data-[disabled]:text-faint data-[highlighted]:bg-hover [&_svg]:size-4", danger ? "text-red" : "text-text")}
    >
      {children}
    </D.Item>
  );
}

export const MenuSeparator = () => <D.Separator className="mx-1 my-1 h-px bg-line" />;

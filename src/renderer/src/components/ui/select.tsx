import { Select as S } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/format";

export type Option<T extends string> = { value: T; label: string };

export function Select<T extends string>({ value, options, onChange, label, disabled, className }: { value: T; options: Option<T>[]; onChange: (v: T) => void; label: string; disabled?: boolean; className?: string }) {
  return (
    <S.Root value={value} onValueChange={(v) => onChange(v as T)} disabled={disabled}>
      <S.Trigger
        aria-label={label}
        className={cn(
          "no-drag inline-flex h-8 min-w-36 shrink-0 items-center justify-between gap-3 rounded-lg bg-raised pr-2.5 pl-3 text-[13px] font-medium text-text outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-amber/70 disabled:text-faint data-[state=open]:bg-hover",
          className,
        )}
      >
        <S.Value />
        <S.Icon>
          <ChevronDown className="size-3.5 text-dim" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content position="popper" side="bottom" align="end" sideOffset={6} className="z-[60] min-w-[var(--radix-select-trigger-width)] rounded-xl bg-raised p-1.5 shadow-[0_12px_40px_rgba(0,0,0,.5)]">
          <S.Viewport>
            {options.map((o) => (
              <S.Item
                key={o.value}
                value={o.value}
                className="relative flex cursor-default items-center gap-2.5 rounded-lg py-2 pr-8 pl-2.5 text-[13px] text-text outline-none data-[highlighted]:bg-hover data-[state=checked]:font-semibold"
              >
                <S.ItemText>{o.label}</S.ItemText>
                <S.ItemIndicator className="absolute right-2.5">
                  <Check className="size-3.5 text-amber" strokeWidth={2.5} />
                </S.ItemIndicator>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}

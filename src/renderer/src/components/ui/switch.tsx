import { Switch as S } from "radix-ui";

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <S.Root
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={label}
      className="no-drag relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full bg-line transition-colors data-[state=checked]:bg-amber disabled:opacity-40"
    >
      <S.Thumb className="block size-4 translate-x-[3px] rounded-full bg-soft shadow-[0_1px_3px_rgba(0,0,0,.4)] transition-[translate,background-color] duration-150 data-[state=checked]:translate-x-[19px] data-[state=checked]:bg-amber-ink" />
    </S.Root>
  );
}

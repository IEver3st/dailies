import { Slider as S } from "radix-ui";

export function Slider({ value, min, max, step, onChange, label }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; label: string }) {
  return (
    <S.Root value={[value]} min={min} max={max} step={step} onValueChange={(v) => onChange(v[0])} className="relative flex h-5 flex-1 touch-none items-center select-none" aria-label={label}>
      <S.Track className="relative h-1 grow rounded-full bg-line">
        <S.Range className="absolute h-full rounded-full bg-soft" />
      </S.Track>
      <S.Thumb className="block size-3.5 rounded-full bg-text shadow-[0_0_0_3px_var(--color-ink)] outline-none focus-visible:ring-2 focus-visible:ring-amber" />
    </S.Root>
  );
}

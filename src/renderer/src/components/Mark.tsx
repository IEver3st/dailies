export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect x="7.4" y="3.6" width="9.2" height="16.8" rx="1.6" fill="none" stroke="var(--color-amber)" strokeWidth="1.8" />
      <circle cx="16.6" cy="3.9" r="2.9" fill="var(--color-amber)" stroke="var(--color-ink)" strokeWidth="1.1" />
    </svg>
  );
}

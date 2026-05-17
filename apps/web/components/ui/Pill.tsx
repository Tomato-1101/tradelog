import type { ReactNode } from 'react';

export type PillTone = 'pos' | 'neg' | 'primary' | 'neutral';

const TONE: Record<PillTone, string> = {
  pos: 'bg-[var(--pos-bg)] text-[var(--pos)]',
  neg: 'bg-[var(--neg-bg)] text-[var(--neg)]',
  primary: 'bg-[var(--primary-soft)] text-[var(--primary)]',
  neutral: 'bg-[var(--surface-muted)] text-[var(--muted-strong)]',
};

export default function Pill({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: PillTone;
}) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONE[tone]}`}>
      {children}
    </span>
  );
}

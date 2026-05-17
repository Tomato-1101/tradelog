import type { ReactNode } from 'react';

export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={
        'rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-[0_1px_2px_rgba(0,0,0,0.03)] ' +
        className
      }
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  right,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-[var(--border)] px-5 py-3">
      <div>
        <div className="text-sm font-semibold tracking-tight">{title}</div>
        {subtitle && <div className="mt-0.5 text-xs text-[var(--muted)]">{subtitle}</div>}
      </div>
      {right && <div className="text-xs text-[var(--muted)]">{right}</div>}
    </div>
  );
}

export function CardBody({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={'p-5 ' + className}>{children}</div>;
}

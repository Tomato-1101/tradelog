'use client';
// 全画面共通の上部ヘッダ。moomoo の見た目を参考に、ロゴ + 横長ナビ + テーマ切替。
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import ThemeToggle from './ThemeToggle';

const NAV = [
  { href: '/', label: 'ダッシュボード' },
  { href: '/trades', label: 'トレード' },
  { href: '/stats', label: '統計' },
  { href: '/import', label: '取り込み' },
];

export default function AppHeader() {
  const pathname = usePathname() ?? '';

  return (
    <header className="sticky top-0 z-20 border-b border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-6 px-6 py-3">
        <Link href="/" className="flex items-center gap-2">
          <span
            aria-hidden
            className="grid h-8 w-8 place-items-center rounded-lg font-bold"
            style={{ background: 'var(--primary)', color: 'var(--primary-foreground)' }}
          >
            T
          </span>
          <span className="text-base font-semibold tracking-tight">tradelog</span>
        </Link>

        <nav className="flex items-center gap-1 text-sm">
          {NAV.map((item) => {
            const active =
              item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={
                  'rounded-md px-3 py-1.5 transition-colors ' +
                  (active
                    ? 'bg-[var(--primary-soft)] text-[var(--primary)] font-medium'
                    : 'text-[var(--muted-strong)] hover:bg-[var(--surface-muted)]')
                }
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2 text-xs">
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

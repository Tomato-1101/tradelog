'use client';

import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

function getCurrentTheme(): Theme {
  if (typeof document === 'undefined') return 'light';
  const t = document.documentElement.dataset.theme;
  return t === 'dark' ? 'dark' : 'light';
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('light');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setTheme(getCurrentTheme());
    setMounted(true);
  }, []);

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      window.localStorage.setItem('theme', next);
    } catch {
      /* ignore */
    }
    setTheme(next);
  };

  // SSR hydration ミスマッチ防止: mounted まではダミー
  if (!mounted) {
    return (
      <button
        type="button"
        aria-label="テーマ切替"
        className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--muted)]"
      >
        …
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === 'dark' ? 'ライトテーマに切替' : 'ダークテーマに切替'}
      title={theme === 'dark' ? 'ライトテーマに切替' : 'ダークテーマに切替'}
      className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs text-[var(--muted-strong)] transition hover:bg-[var(--surface-muted)]"
    >
      {theme === 'dark' ? '☾ Dark' : '☀ Light'}
    </button>
  );
}

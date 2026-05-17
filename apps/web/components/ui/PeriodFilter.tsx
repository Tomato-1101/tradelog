'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  PERIOD_PRESETS,
  getPresetLabel,
  isPeriodPreset,
  type Period,
  type PeriodPreset,
} from '@/lib/period';

type Props = {
  /** localStorage で前回選択を保持するキー (ページごとに分ける) */
  storageKey: string;
};

function readStoredPeriod(key: string): Period | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Period;
    if (!isPeriodPreset(parsed.preset)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredPeriod(key: string, p: Period) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(p));
  } catch {
    /* quota / private mode を握りつぶす */
  }
}

export default function PeriodFilter({ storageKey }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const urlPresetRaw = searchParams.get('preset');
  const urlFrom = searchParams.get('from') ?? '';
  const urlTo = searchParams.get('to') ?? '';
  const urlPreset: PeriodPreset | null = isPeriodPreset(urlPresetRaw) ? urlPresetRaw : null;

  // 初回マウント時に URL が空なら localStorage から復元
  useEffect(() => {
    if (urlPreset) {
      writeStoredPeriod(storageKey, {
        preset: urlPreset,
        from: urlFrom || undefined,
        to: urlTo || undefined,
      });
      return;
    }
    const stored = readStoredPeriod(storageKey);
    if (!stored) return;
    const sp = new URLSearchParams(searchParams.toString());
    sp.set('preset', stored.preset);
    if (stored.preset === 'custom') {
      if (stored.from) sp.set('from', stored.from);
      if (stored.to) sp.set('to', stored.to);
    } else {
      sp.delete('from');
      sp.delete('to');
    }
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activePreset: PeriodPreset = urlPreset ?? 'all';
  const [customFrom, setCustomFrom] = useState(urlFrom);
  const [customTo, setCustomTo] = useState(urlTo);

  const onPresetClick = (p: PeriodPreset) => {
    const sp = new URLSearchParams(searchParams.toString());
    sp.set('preset', p);
    if (p !== 'custom') {
      sp.delete('from');
      sp.delete('to');
    }
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
    writeStoredPeriod(storageKey, {
      preset: p,
      from: p === 'custom' ? customFrom || undefined : undefined,
      to: p === 'custom' ? customTo || undefined : undefined,
    });
  };

  const onCustomApply = () => {
    const sp = new URLSearchParams(searchParams.toString());
    sp.set('preset', 'custom');
    if (customFrom) sp.set('from', customFrom);
    else sp.delete('from');
    if (customTo) sp.set('to', customTo);
    else sp.delete('to');
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
    writeStoredPeriod(storageKey, {
      preset: 'custom',
      from: customFrom || undefined,
      to: customTo || undefined,
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {PERIOD_PRESETS.filter((p) => p !== 'custom').map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onPresetClick(p)}
          className={`rounded-full px-3 py-1 text-xs transition ${
            activePreset === p
              ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
              : 'border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] hover:bg-[var(--surface-muted)]'
          }`}
        >
          {getPresetLabel(p)}
        </button>
      ))}
      <div className="ml-1 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onPresetClick('custom')}
          className={`rounded-full px-3 py-1 text-xs transition ${
            activePreset === 'custom'
              ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
              : 'border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] hover:bg-[var(--surface-muted)]'
          }`}
        >
          カスタム
        </button>
        {activePreset === 'custom' && (
          <>
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
            />
            <span className="text-xs text-[var(--muted)]">〜</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
            />
            <button
              type="button"
              onClick={onCustomApply}
              className="rounded bg-[var(--primary)] px-2 py-1 text-xs text-[var(--primary-foreground)] hover:opacity-90"
            >
              適用
            </button>
          </>
        )}
      </div>
    </div>
  );
}

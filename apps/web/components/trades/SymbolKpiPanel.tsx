'use client';

import { useEffect, useState } from 'react';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import Stat from '@/components/ui/Stat';
import { fmtDuration, fmtMoney, fmtPercent, fmtRatio } from '@/lib/format';

export type SymbolKpis = {
  totalPnlJpy: number;
  netPnlJpy: number;
  totalFeesJpy: number;
  winRate: number;
  wins: number;
  losses: number;
  flats: number;
  closedRounds: number;
  avgWin: number;
  avgLoss: number;
  maxWin: number;
  maxLoss: number;
  expectancyJpy: number;
  profitFactor: number;
  payoffRatio: number;
  maxDrawdownJpy: number;
  maxDrawdownPct: number;
  avgHoldSeconds: number | null;
  maxWinStreak: number;
  maxLossStreak: number;
};

type KpiKey =
  | 'totalPnlJpy'
  | 'netPnlJpy'
  | 'winRate'
  | 'closedRounds'
  | 'expectancyJpy'
  | 'profitFactor'
  | 'payoffRatio'
  | 'maxDrawdownJpy'
  | 'avgWin'
  | 'avgLoss'
  | 'maxWin'
  | 'maxLoss'
  | 'avgHoldSeconds'
  | 'maxWinStreak'
  | 'maxLossStreak'
  | 'totalFeesJpy';

const KPI_LABELS: Record<KpiKey, string> = {
  totalPnlJpy: '実現損益 (JPY)',
  netPnlJpy: 'ネット損益 (手数料控除)',
  winRate: '勝率',
  closedRounds: 'トレード件数',
  expectancyJpy: '期待値 / ラウンド',
  profitFactor: 'プロフィットファクター',
  payoffRatio: 'ペイオフレシオ',
  maxDrawdownJpy: '最大ドローダウン',
  avgWin: '平均勝ち',
  avgLoss: '平均負け',
  maxWin: '最大勝ち',
  maxLoss: '最大負け',
  avgHoldSeconds: '平均保有時間',
  maxWinStreak: '最大連勝',
  maxLossStreak: '最大連敗',
  totalFeesJpy: '手数料計',
};

const DEFAULT_SELECTION: KpiKey[] = [
  'netPnlJpy',
  'winRate',
  'closedRounds',
  'expectancyJpy',
  'profitFactor',
  'maxDrawdownJpy',
  'avgWin',
  'avgLoss',
];

const ALL_KEYS = Object.keys(KPI_LABELS) as KpiKey[];

const STORAGE_KEY = 'tradesKpiSelection';

function readSelection(): KpiKey[] {
  if (typeof window === 'undefined') return DEFAULT_SELECTION;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SELECTION;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return DEFAULT_SELECTION;
    const valid = arr.filter((k): k is KpiKey => ALL_KEYS.includes(k as KpiKey));
    return valid.length ? valid : DEFAULT_SELECTION;
  } catch {
    return DEFAULT_SELECTION;
  }
}

function writeSelection(sel: KpiKey[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sel));
  } catch {
    /* ignore */
  }
}

function renderStat(key: KpiKey, k: SymbolKpis) {
  switch (key) {
    case 'totalPnlJpy':
      return <Stat label={KPI_LABELS[key]} value={fmtMoney(k.totalPnlJpy, 'JPY')} tone={k.totalPnlJpy >= 0 ? 'pos' : 'neg'} />;
    case 'netPnlJpy':
      return <Stat label={KPI_LABELS[key]} value={fmtMoney(k.netPnlJpy, 'JPY')} tone={k.netPnlJpy >= 0 ? 'pos' : 'neg'} sub={`手数料 ${fmtMoney(k.totalFeesJpy, 'JPY')}`} />;
    case 'winRate':
      return <Stat label={KPI_LABELS[key]} value={fmtPercent(k.winRate)} sub={`${k.wins}勝 ${k.losses}敗 ${k.flats}引分`} />;
    case 'closedRounds':
      return <Stat label={KPI_LABELS[key]} value={String(k.closedRounds)} />;
    case 'expectancyJpy':
      return <Stat label={KPI_LABELS[key]} value={fmtMoney(k.expectancyJpy, 'JPY')} tone={k.expectancyJpy >= 0 ? 'pos' : 'neg'} />;
    case 'profitFactor':
      return <Stat label={KPI_LABELS[key]} value={fmtRatio(k.profitFactor)} sub="総勝ち / |総負け|" />;
    case 'payoffRatio':
      return <Stat label={KPI_LABELS[key]} value={fmtRatio(k.payoffRatio)} sub="平均勝ち / |平均負け|" />;
    case 'maxDrawdownJpy':
      return <Stat label={KPI_LABELS[key]} value={fmtMoney(k.maxDrawdownJpy, 'JPY')} tone="neg" sub={fmtPercent(k.maxDrawdownPct)} />;
    case 'avgWin':
      return <Stat label={KPI_LABELS[key]} value={fmtMoney(k.avgWin, 'JPY')} tone="pos" />;
    case 'avgLoss':
      return <Stat label={KPI_LABELS[key]} value={fmtMoney(k.avgLoss, 'JPY')} tone="neg" />;
    case 'maxWin':
      return <Stat label={KPI_LABELS[key]} value={fmtMoney(k.maxWin, 'JPY')} tone="pos" />;
    case 'maxLoss':
      return <Stat label={KPI_LABELS[key]} value={fmtMoney(k.maxLoss, 'JPY')} tone="neg" />;
    case 'avgHoldSeconds':
      return <Stat label={KPI_LABELS[key]} value={fmtDuration(k.avgHoldSeconds)} />;
    case 'maxWinStreak':
      return <Stat label={KPI_LABELS[key]} value={`${k.maxWinStreak}`} tone="pos" />;
    case 'maxLossStreak':
      return <Stat label={KPI_LABELS[key]} value={`${k.maxLossStreak}`} tone="neg" />;
    case 'totalFeesJpy':
      return <Stat label={KPI_LABELS[key]} value={fmtMoney(k.totalFeesJpy, 'JPY')} />;
  }
}

export default function SymbolKpiPanel({ kpis, symbol }: { kpis: SymbolKpis; symbol: string }) {
  const [selection, setSelection] = useState<KpiKey[]>(DEFAULT_SELECTION);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setSelection(readSelection());
    setMounted(true);
  }, []);

  const toggle = (key: KpiKey) => {
    setSelection((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      // 表示順は ALL_KEYS の定義順に揃える
      const ordered = ALL_KEYS.filter((k) => next.includes(k));
      writeSelection(ordered);
      return ordered;
    });
  };

  // SSR と一致させるため初期は DEFAULT_SELECTION
  const active = mounted ? selection : DEFAULT_SELECTION;

  return (
    <Card>
      <CardHeader
        title={`${symbol} のパフォーマンス`}
        subtitle="選択期間内のクローズ済ラウンドを集計 (手数料は ccy 混在の概算)"
      />
      <CardBody>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
          {active.map((k) => (
            <Card key={k}>
              <CardBody>{renderStat(k, kpis)}</CardBody>
            </Card>
          ))}
        </div>
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-[var(--muted)] hover:text-[var(--foreground)]">
            表示する指標をカスタマイズ
          </summary>
          <div className="mt-2 flex flex-wrap gap-2">
            {ALL_KEYS.map((k) => (
              <label
                key={k}
                className={`flex items-center gap-1 rounded-full border px-2 py-1 text-xs transition ${
                  active.includes(k)
                    ? 'border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--primary)]'
                    : 'border-[var(--border)] bg-[var(--surface)] text-[var(--muted-strong)]'
                }`}
              >
                <input
                  type="checkbox"
                  checked={active.includes(k)}
                  onChange={() => toggle(k)}
                  className="h-3 w-3"
                />
                {KPI_LABELS[k]}
              </label>
            ))}
          </div>
        </details>
      </CardBody>
    </Card>
  );
}

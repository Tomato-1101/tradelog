import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { RoundFilter } from '@/lib/round-filter';
import { ROUND_FILTER_COOKIE_KEYS, hasAnyFilter } from '@/lib/round-filter';

// 「ブローカー / 商品種別 / 取引区分」絞り込みフォーム (Server Component)。
// Server Action で cookie に保存 + URL を更新 (basePath?broker=... 形式) してから redirect。
// これによりページ遷移 (例: /stats → /) でも cookie 側に残った値が次ページで効く。
// preset/from/to 等の周辺パラメータは hidden input で引き継ぐ。
type Props = {
  basePath: string;
  filter: RoundFilter;
  /** 周辺で維持したいクエリ (preset, from, to, sort 等) */
  preserve?: Record<string, string | undefined>;
};

// cookie の有効期間 (秒)。1 年。
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

// FormData 由来の遷移先はそのまま redirect すると外部サイトへ飛ばせてしまう
// (`//evil.example` はプロトコル相対 URL)。アプリ内の絶対パスだけ許可する。
function safeBasePath(raw: FormDataEntryValue | null): string {
  const v = typeof raw === 'string' ? raw : '';
  if (v.startsWith('/') && !v.startsWith('//')) return v;
  return '/';
}

async function applyRoundFilterAction(formData: FormData): Promise<void> {
  'use server';
  const basePath = safeBasePath(formData.get('__basePath'));
  const broker = String(formData.get('broker') ?? '');
  const instKind = String(formData.get('instKind') ?? '');
  const marginType = String(formData.get('marginType') ?? '');

  const c = await cookies();
  const setOrDelete = (name: string, value: string) => {
    if (value) {
      c.set(name, value, { path: '/', maxAge: ONE_YEAR_SECONDS, sameSite: 'lax' });
    } else {
      c.delete(name);
    }
  };
  setOrDelete(ROUND_FILTER_COOKIE_KEYS.broker, broker);
  setOrDelete(ROUND_FILTER_COOKIE_KEYS.instKind, instKind);
  setOrDelete(ROUND_FILTER_COOKIE_KEYS.marginType, marginType);

  // 周辺で維持したい hidden input を URL にも反映
  const usp = new URLSearchParams();
  for (const [k, v] of formData.entries()) {
    if (k === '__basePath') continue;
    if (k === 'broker' || k === 'instKind' || k === 'marginType') {
      if (typeof v === 'string' && v) usp.set(k, v);
      continue;
    }
    if (typeof v === 'string' && v) usp.set(k, v);
  }
  const qs = usp.toString();
  redirect(qs ? `${basePath}?${qs}` : basePath);
}

async function clearRoundFilterAction(formData: FormData): Promise<void> {
  'use server';
  const basePath = safeBasePath(formData.get('__basePath'));
  const c = await cookies();
  c.delete(ROUND_FILTER_COOKIE_KEYS.broker);
  c.delete(ROUND_FILTER_COOKIE_KEYS.instKind);
  c.delete(ROUND_FILTER_COOKIE_KEYS.marginType);

  const usp = new URLSearchParams();
  for (const [k, v] of formData.entries()) {
    if (k === '__basePath') continue;
    if (typeof v === 'string' && v) usp.set(k, v);
  }
  const qs = usp.toString();
  redirect(qs ? `${basePath}?${qs}` : basePath);
}

export default function RoundFilterForm({ basePath, filter, preserve }: Props) {
  return (
    <div className="flex flex-wrap items-end gap-2 text-xs">
      <form action={applyRoundFilterAction} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="__basePath" value={basePath} />
        {Object.entries(preserve ?? {}).map(([k, v]) =>
          v ? <input key={k} type="hidden" name={k} value={v} /> : null,
        )}
        <label className="font-medium text-[var(--muted)]">
          <span className="block">ブローカー</span>
          <select
            name="broker"
            defaultValue={filter.broker ?? ''}
            className="mt-0.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm"
          >
            <option value="">すべて</option>
            <option value="SBI">SBI</option>
            <option value="MOOMOO">MOOMOO</option>
          </select>
        </label>
        <label className="font-medium text-[var(--muted)]">
          <span className="block">商品種別</span>
          <select
            name="instKind"
            defaultValue={filter.instKind ?? ''}
            className="mt-0.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm"
          >
            <option value="">すべて</option>
            <option value="EQUITY_JP">日本株</option>
            <option value="EQUITY_US">米株</option>
            <option value="OPTION_US">米株オプション</option>
          </select>
        </label>
        <label className="font-medium text-[var(--muted)]">
          <span className="block">取引区分</span>
          <select
            name="marginType"
            defaultValue={filter.marginType ?? ''}
            className="mt-0.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm"
          >
            <option value="">すべて</option>
            <option value="CASH">現物</option>
            <option value="MARGIN_LONG">信用買</option>
            <option value="MARGIN_SHORT">信用売</option>
          </select>
        </label>
        <button
          type="submit"
          className="rounded-md bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--primary-foreground)] hover:opacity-90"
        >
          絞り込み
        </button>
      </form>
      {hasAnyFilter(filter) && (
        <form action={clearRoundFilterAction}>
          <input type="hidden" name="__basePath" value={basePath} />
          {Object.entries(preserve ?? {}).map(([k, v]) =>
            v ? <input key={k} type="hidden" name={k} value={v} /> : null,
          )}
          <button
            type="submit"
            className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs hover:bg-[var(--surface-muted)]"
          >
            クリア
          </button>
        </form>
      )}
    </div>
  );
}

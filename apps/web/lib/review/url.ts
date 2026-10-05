// 画面の URL（クエリ）の組み立て・読み取り。

export type SP = Record<string, string | string[] | undefined>;

export function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** 値が undefined / 空文字のキーは落として href を作る */
export function buildHref(path: string, params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, v);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

export type SourceKey = 'PAPER' | 'SBI' | 'REPLAY';

/** sbi → 本番、replay → リプレイ、それ以外（無指定を含む）はペーパー */
export function parseSource(v: string | string[] | undefined): SourceKey {
  const s = first(v);
  return s === 'sbi' ? 'SBI' : s === 'replay' ? 'REPLAY' : 'PAPER';
}

export function sourceParam(s: SourceKey): 'paper' | 'sbi' | 'replay' {
  return s === 'SBI' ? 'sbi' : s === 'REPLAY' ? 'replay' : 'paper';
}

/** 画面の表示名（タブ・取引詳細のチップ） */
export const SOURCE_LABEL: Record<SourceKey, string> = { PAPER: 'ペーパー', SBI: '本番(SBI)', REPLAY: 'リプレイ' };

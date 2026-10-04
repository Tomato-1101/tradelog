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

export function parseSource(v: string | string[] | undefined): 'PAPER' | 'SBI' {
  return first(v) === 'sbi' ? 'SBI' : 'PAPER';
}

export function sourceParam(s: 'PAPER' | 'SBI'): 'paper' | 'sbi' {
  return s === 'SBI' ? 'sbi' : 'paper';
}

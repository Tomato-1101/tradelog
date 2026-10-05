// 発注時スクショのサイドカー（shots/YYYY-MM-DD/<order id>.ocr.json）の読み取り。
// 小窓が order 行の後に非同期で書くので、daily の時点で無い・書きかけのこともある（そのときは次回の daily で拾う）。
// 使うのは auto（画面全体の自動読み取り）だけ。items（OCR の生の文字列と位置）は人と AI が直接読む。

import fs from 'node:fs';
import path from 'node:path';

export type SidecarAuto = {
  price: string | null;
  priceText: string | null;
  /** 画面に出ていた現在値の時刻（HH:MM） */
  priceTime: string | null;
  symbol: string | null;
  source: 'region' | 'label' | null;
};

const PRICE = /^(0|[1-9]\d*)(\.\d+)?$/;
const HHMM = /^\d{2}:\d{2}$/;

/** サイドカーの JSON 文字列 → auto。形式が違えば理由を返す */
export function parseSidecar(text: string): { ok: true; auto: SidecarAuto } | { ok: false; message: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, message: 'JSON として読めない（書きかけの可能性）' };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return { ok: false, message: 'JSON オブジェクトでない' };
  const o = json as Record<string, unknown>;
  if (o.v !== 1) return { ok: false, message: `未対応のバージョン v=${JSON.stringify(o.v)}` };
  const a = o.auto;
  if (a === null || a === undefined) return { ok: true, auto: { price: null, priceText: null, priceTime: null, symbol: null, source: null } };
  if (typeof a !== 'object' || Array.isArray(a)) return { ok: false, message: 'auto がオブジェクトでない' };
  const r = a as Record<string, unknown>;
  // キーが無いものは null（読めなかった）として扱う
  const s = (k: string, re?: RegExp): string | null => {
    const v = r[k];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string' || (re && !re.test(v))) throw new Error(`auto.${k} の形式が不正: ${JSON.stringify(v)}`);
    return v;
  };
  try {
    const source = s('source');
    if (source !== null && source !== 'region' && source !== 'label') throw new Error(`auto.source は region / label / null: ${JSON.stringify(source)}`);
    const price = s('price', PRICE);
    if (price !== null && Number(price) <= 0) throw new Error('auto.price が 0 以下');
    return { ok: true, auto: { price, priceText: s('price_text'), priceTime: s('price_time', HHMM), symbol: s('symbol'), source } };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/**
 * paperDir 配下のサイドカーを読む。無ければ null（まだ書かれていない）。読めなければ ok: false（例外にしない）。
 * ocrPath は契約で data/paper/ からの相対パス（events.ts で絶対パス・.. は弾き済み）。
 */
export function readSidecar(paperDir: string, ocrPath: string): { ok: true; auto: SidecarAuto } | { ok: false; message: string } | null {
  const base = path.resolve(paperDir);
  const full = path.resolve(base, ocrPath);
  if (!full.startsWith(base + path.sep)) return { ok: false, message: `ocr_path が data/paper の外: ${ocrPath}` };
  let text: string;
  try {
    text = fs.readFileSync(full, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // 権限・ディレクトリ等で読めなくても daily 全体は止めない（読めなかった扱いで前回の値を残し、次回読み直す）
    return { ok: false, message: `読み取れない: ${(e as Error).message}` };
  }
  return parseSidecar(text);
}

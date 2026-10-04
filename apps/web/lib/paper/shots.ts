// 発注時スクショ（data/paper/shots/ 配下の PNG）の置き場所と、配信してよいパスの検査。
// パストラバーサル防止: URL のセグメントを正規化 → shots ディレクトリ配下か（シンボリックリンク解決後も）→ 拡張子 .png だけ。

import fs from 'node:fs';
import path from 'node:path';

/** data/paper の場所。検証用に環境変数で差し替えられる（既定は apps/web から ../../data/paper） */
export function paperDir(): string {
  return process.env.TRADELOG_PAPER_DIR ? path.resolve(process.env.TRADELOG_PAPER_DIR) : path.resolve(process.cwd(), '../../data/paper');
}

export function shotsDir(): string {
  return path.join(paperDir(), 'shots');
}

/**
 * `shots/` 配下の PNG の実ファイルパスを返す。許可できない・存在しなければ null。
 * segments は URL の（デコード済みの）パス要素。
 */
export function resolveShotFile(root: string, segments: string[]): string | null {
  if (segments.length === 0) return null;
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..' || s.includes('/') || s.includes('\\') || s.includes('\0')) return null;
  }
  const rel = segments.join('/');
  if (!rel.toLowerCase().endsWith('.png')) return null;
  const base = path.resolve(root);
  const full = path.resolve(base, rel);
  if (!full.startsWith(base + path.sep)) return null;
  let real: string;
  let realBase: string;
  try {
    real = fs.realpathSync(full);
    realBase = fs.realpathSync(base);
  } catch {
    return null;
  }
  if (!real.startsWith(realBase + path.sep) || !real.toLowerCase().endsWith('.png')) return null;
  try {
    if (!fs.statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return real;
}

/** DB の Shot.path（data/paper/ からの相対。`shots/YYYY-MM-DD/<id>.png`）→ 配信 URL。shots/ 配下でなければ null */
export function shotUrl(dbPath: string): string | null {
  const parts = dbPath.split('/');
  if (parts[0] !== 'shots' || parts.length < 2) return null;
  return '/shots/' + parts.slice(1).map(encodeURIComponent).join('/');
}

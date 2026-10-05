// 発注時スクショ（data/paper/shots/ 配下の PNG）と、リプレイの録画フレーム（data/paper/replay/shots/ 配下の PNG）の
// 置き場所と、配信してよいパスの検査。配信 URL は /shots/<shots 配下> と /shots/replay/<replay/shots 配下>。
// パストラバーサル防止: URL のセグメントを正規化 → shots ディレクトリ配下か（シンボリックリンク解決後も）→ 拡張子 .png だけ。

import fs from 'node:fs';
import path from 'node:path';

/** data/paper の場所。検証用に環境変数で差し替えられる（既定は apps/web から ../../data/paper） */
export function paperDir(): string {
  return process.env.TRADELOG_PAPER_DIR ? path.resolve(process.env.TRADELOG_PAPER_DIR) : path.resolve(process.cwd(), '../../data/paper');
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

/**
 * 配信 URL のセグメント → 実ファイル。先頭が `replay` なら data/paper/replay/shots/ 配下、それ以外は data/paper/shots/ 配下。
 * どちらも resolveShotFile と同じ検査（その shots ディレクトリの外・.png 以外は null）。
 */
export function resolveShotUrlFile(paperRoot: string, segments: string[]): string | null {
  if (segments[0] === 'replay') return resolveShotFile(path.join(paperRoot, 'replay', 'shots'), segments.slice(1));
  return resolveShotFile(path.join(paperRoot, 'shots'), segments);
}

/**
 * DB の Shot.path（data/paper/ からの相対）→ 配信 URL。
 * `shots/YYYY-MM-DD/<id>.png` → `/shots/YYYY-MM-DD/<id>.png`、`replay/shots/YYYY-MM-DD/<id>.png` → `/shots/replay/YYYY-MM-DD/<id>.png`。
 * どちらの shots/ 配下でもなければ null
 */
export function shotUrl(dbPath: string): string | null {
  const parts = dbPath.split('/');
  const enc = (xs: string[]) => xs.map(encodeURIComponent).join('/');
  if (parts[0] === 'shots' && parts.length >= 2) return '/shots/' + enc(parts.slice(1));
  if (parts[0] === 'replay' && parts[1] === 'shots' && parts.length >= 3) return '/shots/replay/' + enc(parts.slice(2));
  return null;
}

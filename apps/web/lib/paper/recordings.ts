// 録画のメタ（data/paper/replay/recordings/YYYY-MM-DD/<rec_id>.json。小窓が書く。形は docs/paper-events.md）の読み取り。
//  - リプレイの未決済の評価（MAE/MFE・チャート・AI 書き出し）を、録画の終わりで止めるため（見ていない値動きを入れない）
//  - 録画した日の銘柄（ウィンドウタイトルの「(5803)」）の 1 分足を、発注が無くても取っておくため

import fs from 'node:fs';
import path from 'node:path';
import { addDays, jstYmd } from '@/lib/time';

type MetaLite = {
  id?: unknown;
  started_at?: unknown;
  ended_at?: unknown;
  planned_minutes?: unknown;
  samples?: Array<{ windows?: Array<{ title?: unknown }> }>;
};

/** タイトルの「(5803)」「（5803）」（小窓の BoardReader と同じ形） */
const TITLE_CODE = /[(（]([0-9][0-9A-Z][0-9][0-9A-Z])[)）]/;

function recordingsDir(paperDir: string): string {
  return path.join(paperDir, 'replay', 'recordings');
}

function readMeta(file: string): MetaLite | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return j && typeof j === 'object' ? (j as MetaLite) : null;
  } catch {
    return null;
  }
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** rec_id（YYYYMMDD-HHMMSS[-n]）のメタ。置き場所の日付フォルダは id の日付。無い・読めなければ null */
export function readRecordingMeta(paperDir: string, recordingId: string): MetaLite | null {
  const m = /^(\d{4})(\d{2})(\d{2})-\d{6}(-\d+)?$/.exec(recordingId);
  if (!m) return null;
  return readMeta(path.join(recordingsDir(paperDir), `${m[1]}-${m[2]}-${m[3]}`, `${recordingId}.json`));
}

/**
 * 録画の中で見られた時間の終わり。ended_at → 無ければ started_at ＋ planned_minutes → どちらも無ければ null（評価しない）。
 * ended_at が無いのは録画中か、途中で落ちた録画
 */
export function replayEvalEnd(meta: MetaLite | null): Date | null {
  if (!meta) return null;
  const ended = parseDate(meta.ended_at);
  if (ended) return ended;
  const started = parseDate(meta.started_at);
  const minutes = meta.planned_minutes;
  if (started && typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0) return new Date(started.getTime() + minutes * 60_000);
  return null;
}

export type ReplayEndResolver = (recordingId: string | null) => Date | null;

/** 録画 ID → 録画の終わり（同じ録画は 1 回だけ読む） */
export function replayEndResolver(paperDir: string): ReplayEndResolver {
  const cache = new Map<string, Date | null>();
  return (id) => {
    if (!id) return null;
    if (!cache.has(id)) cache.set(id, replayEvalEnd(readRecordingMeta(paperDir, id)));
    return cache.get(id) ?? null;
  };
}

/**
 * 直近 days 日の録画に映っていた銘柄 × 録画の日（重複なし）。日付は started_at の JST 日付（無ければフォルダ名）。
 * タイトルにコードがあるウィンドウ（全板・チャート等）すべてから拾う
 */
export function recordedSymbolDays(paperDir: string, now: Date, days = 30): Array<{ symbol: string; date: string }> {
  const root = recordingsDir(paperDir);
  const since = addDays(jstYmd(now), -days);
  let dayDirs: string[];
  try {
    dayDirs = fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= since);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: Array<{ symbol: string; date: string }> = [];
  for (const day of dayDirs.sort()) {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(root, day)).filter((n) => n.endsWith('.json'));
    } catch {
      continue;
    }
    for (const n of names.sort()) {
      const meta = readMeta(path.join(root, day, n));
      if (!meta) continue;
      const started = parseDate(meta.started_at);
      const date = started ? jstYmd(started) : day;
      if (date < since) continue;
      for (const s of Array.isArray(meta.samples) ? meta.samples : []) {
        for (const w of Array.isArray(s?.windows) ? s.windows : []) {
          const code = typeof w?.title === 'string' ? TITLE_CODE.exec(w.title)?.[1] : undefined;
          if (!code || seen.has(`${code}|${date}`)) continue;
          seen.add(`${code}|${date}`);
          out.push({ symbol: code, date });
        }
      }
    }
  }
  return out;
}

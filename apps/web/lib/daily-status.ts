// daily の実行結果（DB と同じディレクトリの daily-status.json）。daily が毎回書き、web は上部に
// 「失敗」「一部失敗」「2 営業日以上動いていない」のときだけ小さく警告を出す（正常なら何も出さない）。
// launchd で裏で回るので、ログを見に行かなくても画面で気づけるようにするため。

import fs from 'node:fs';
import path from 'node:path';
import { addDays, isWeekend, jstAt, jstHm, jstYmd } from '@/lib/time';

export type DailyResult = 'ok' | 'partial' | 'failed';
export type DailyStatus = {
  v: 1;
  startedAt: string;
  finishedAt: string;
  result: DailyResult;
  /** 失敗時の例外メッセージ（1 行に切り詰め） */
  error: string | null;
  /** 足の取得に失敗した（銘柄 × 足種）の件数 */
  barFailures: number;
  /** サイドカー（ocr.json）が読めなかった件数 */
  sidecarErrors: number;
  /** events.jsonl から取り込んだ注文の数 */
  ordersIngested: number;
  /** events.jsonl（通常のペーパーとリプレイの合計）で契約違反として捨てた行の数（この項目が無い古い状態ファイルは 0 とみなす） */
  eventErrors?: number;
};
export type DailyAlert = { kind: 'failed' | 'partial' | 'stale' | 'missing'; message: string };

/** daily の定時（launchd の 15:45）。これを 2 回過ぎても成功記録が更新されていなければ未実行とみなす */
const DAILY_MINUTE = 15 * 60 + 45;

/** DATABASE_URL（file:...）と同じディレクトリ。検証で一時 DB に向けたときに本物の状態を上書きしないため */
export function dailyStatusPath(dbUrl: string): string {
  return path.join(path.dirname(dbUrl.replace(/^file:/, '')), 'daily-status.json');
}

export function dailyResult(c: { barFailures: number; sidecarErrors: number; eventErrors?: number }, error: string | null): DailyResult {
  if (error !== null) return 'failed';
  return c.barFailures > 0 || c.sidecarErrors > 0 || (c.eventErrors ?? 0) > 0 ? 'partial' : 'ok';
}

export function writeDailyStatus(file: string, s: DailyStatus): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** 無ければ null、読めなければ 'unreadable' */
export function readDailyStatus(file: string): DailyStatus | null | 'unreadable' {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable';
  }
  try {
    const j = JSON.parse(text) as DailyStatus;
    if (j?.v !== 1 || typeof j.finishedAt !== 'string' || !['ok', 'partial', 'failed'].includes(j.result)) return 'unreadable';
    return j;
  } catch {
    return 'unreadable';
  }
}

/** last より後、now 以前に過ぎた平日 15:45 の回数 */
function missedRuns(last: Date, now: Date): number {
  let n = 0;
  for (let ymd = jstYmd(last); ymd <= jstYmd(now); ymd = addDays(ymd, 1)) {
    const t = jstAt(ymd, DAILY_MINUTE);
    if (!isWeekend(ymd) && t > last && t <= now) n++;
  }
  return n;
}

const fmt = (iso: string) => `${jstYmd(new Date(iso)).slice(5).replace('-', '/')} ${jstHm(new Date(iso))}`;

export function dailyAlert(s: DailyStatus | null | 'unreadable', now: Date): DailyAlert | null {
  if (s === null) return { kind: 'missing', message: 'daily の実行記録が無い' };
  if (s === 'unreadable') return { kind: 'failed', message: 'daily の状態ファイルが読めない' };
  if (missedRuns(new Date(s.finishedAt), now) >= 2) {
    return { kind: 'stale', message: `daily が 2 営業日以上動いていない（最終 ${fmt(s.finishedAt)}）` };
  }
  if (s.result === 'failed') return { kind: 'failed', message: `daily が失敗（${fmt(s.finishedAt)}）: ${s.error ?? '理由不明'}` };
  if (s.result === 'partial') {
    const parts = [
      s.barFailures > 0 ? `足の取得失敗 ${s.barFailures} 件` : null,
      s.sidecarErrors > 0 ? `サイドカー読めず ${s.sidecarErrors} 件` : null,
      (s.eventErrors ?? 0) > 0 ? `events の契約違反 ${s.eventErrors} 行（取り込まずに捨てた）` : null,
    ];
    return { kind: 'partial', message: `daily が一部失敗（${fmt(s.finishedAt)}）: ${parts.filter((x) => x !== null).join('・')}` };
  }
  return null;
}

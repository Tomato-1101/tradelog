// 指摘10: daily の状態ファイル（data/daily-status.json）と、web 上部に出す警告の判定。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dailyAlert, dailyResult, dailyStatusPath, readDailyStatus, writeDailyStatus, type DailyStatus } from '@/lib/daily-status';

const jst = (s: string) => new Date(`${s}+09:00`);
const st = (p: Partial<DailyStatus>): DailyStatus => ({
  v: 1,
  startedAt: jst('2026-10-05T15:45:00').toISOString(),
  finishedAt: jst('2026-10-05T15:46:00').toISOString(),
  result: 'ok',
  error: null,
  barFailures: 0,
  sidecarErrors: 0,
  ordersIngested: 3,
  ...p,
});

describe('結果の分類', () => {
  it('例外があれば failed、足の取得失敗かサイドカー読めずがあれば partial、無ければ ok', () => {
    expect(dailyResult({ barFailures: 0, sidecarErrors: 0 }, null)).toBe('ok');
    expect(dailyResult({ barFailures: 2, sidecarErrors: 0 }, null)).toBe('partial');
    expect(dailyResult({ barFailures: 0, sidecarErrors: 1 }, null)).toBe('partial');
    expect(dailyResult({ barFailures: 0, sidecarErrors: 0 }, 'boom')).toBe('failed');
  });
});

describe('警告の判定（正常時は何も出さない）', () => {
  const now = jst('2026-10-05T18:00:00'); // 月曜
  it('正常（直近の引け後に成功）なら null', () => {
    expect(dailyAlert(st({}), now)).toBeNull();
  });
  it('失敗・一部失敗は理由つきで出す', () => {
    expect(dailyAlert(st({ result: 'failed', error: 'DB が開けない' }), now)).toMatchObject({ kind: 'failed' });
    expect(dailyAlert(st({ result: 'failed', error: 'DB が開けない' }), now)?.message).toMatch(/DB が開けない/);
    const p = dailyAlert(st({ result: 'partial', barFailures: 2, sidecarErrors: 1 }), now);
    expect(p).toMatchObject({ kind: 'partial' });
    expect(p?.message).toMatch(/足の取得失敗 2.*サイドカー読めず 1/);
  });
  it('金曜の引け後に成功 → 月曜の夜は 1 営業日分しか抜けていないので出さない、火曜の引け後は出す', () => {
    const fri = st({ startedAt: jst('2026-10-02T15:45:00').toISOString(), finishedAt: jst('2026-10-02T15:46:00').toISOString() });
    expect(dailyAlert(fri, jst('2026-10-05T18:00:00'))).toBeNull();
    expect(dailyAlert(fri, jst('2026-10-06T15:44:00'))).toBeNull();
    expect(dailyAlert(fri, jst('2026-10-06T15:46:00'))).toMatchObject({ kind: 'stale' });
  });
  it('実行記録が無い・読めないときも出す', () => {
    expect(dailyAlert(null, now)).toMatchObject({ kind: 'missing' });
    expect(dailyAlert('unreadable', now)).toMatchObject({ kind: 'failed' });
  });
});

describe('状態ファイルの読み書き', () => {
  it('DB と同じディレクトリに置く', () => {
    expect(dailyStatusPath('file:/a/b/app.db')).toBe('/a/b/daily-status.json');
  });
  it('書いて読める・無ければ null・壊れていれば unreadable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tradelog-status-'));
    const f = path.join(dir, 'daily-status.json');
    expect(readDailyStatus(f)).toBeNull();
    writeDailyStatus(f, st({ result: 'partial', barFailures: 1 }));
    expect(readDailyStatus(f)).toEqual(st({ result: 'partial', barFailures: 1 }));
    fs.writeFileSync(f, '{"v":1,');
    expect(readDailyStatus(f)).toBe('unreadable');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// 本番エントリー記録（real_memo）のパースと、建て約定を選ぶ規則（純粋関数）。DB を通す確認は tests/rounds/sbi-timed.test.ts
import { describe, expect, it } from 'vitest';
import { LINK_WINDOW_SEC, parseRealEvents, pickEntryExecution } from '@/lib/real/memos';

const memo = (o: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    type: 'real_memo',
    id: '11111111-1111-4111-8111-111111111111',
    ts: '2026-11-11T09:21:32.123+09:00',
    tags: ['押し目'],
    shots: [{ path: 'shots/2026-11-11/x-1.png', window_title: 'チャート', process: 'HYPERSBI2', rect: [0, 0, 800, 600], method: 'print' }],
    active_window_title: 'HYPER SBI 2',
    ...o,
  });

describe('parseRealEvents', () => {
  it('契約どおりの行を読み、test・書きかけ・契約違反は取り込まない', () => {
    const text =
      '﻿' +
      [
        memo(),
        memo({ id: '22222222-2222-4222-8222-222222222222', test: true }),
        memo({ id: '33333333-3333-4333-8333-333333333333', tags: [], shots: [], capture_error: '撮影失敗' }),
        memo({ id: '44444444-4444-4444-8444-444444444444', ts: '2026-11-11 09:21:32' }),
        memo({ id: '55555555-5555-4555-8555-555555555555', type: 'memo' }),
        '{"v":1,"type":"real_memo","id":"6666',
        '',
      ].join('\n');
    const r = parseRealEvents(text);
    expect({ lines: r.lines, test: r.test, partial: r.partial }).toEqual({ lines: 6, test: 1, partial: 1 });
    expect(r.memos.map((m) => [m.id.slice(0, 1), m.ts.toISOString(), m.tags, m.shots.length, m.captureError])).toEqual([
      ['1', '2026-11-11T00:21:32.123Z', ['押し目'], 1, null],
      ['3', '2026-11-11T00:21:32.123Z', [], 0, '撮影失敗'],
    ]);
    expect(r.errors.map((e) => e.line)).toEqual([4, 5]);
  });
});

describe('pickEntryExecution', () => {
  const ts = new Date('2026-11-11T00:21:32.000Z');
  const at = (sec: number, id: string) => ({ id, executedAt: new Date(ts.getTime() + sec * 1000) });

  it(`前後 ${LINK_WINDOW_SEC} 秒以内で最も近い約定。範囲外しか無ければ null`, () => {
    expect(pickEntryExecution(ts, [at(-30, 'a'), at(5, 'b'), at(-8, 'c')])?.id).toBe('b');
    expect(pickEntryExecution(ts, [at(LINK_WINDOW_SEC, 'edge')])?.id).toBe('edge');
    expect(pickEntryExecution(ts, [at(LINK_WINDOW_SEC + 0.001, 'far'), at(-LINK_WINDOW_SEC - 1, 'far2')])).toBeNull();
    expect(pickEntryExecution(ts, [])).toBeNull();
  });

  it('同じ差なら約定の早い方、同時刻なら id の小さい方（入力順に依らない）', () => {
    expect(pickEntryExecution(ts, [at(3, 'late'), at(-3, 'early')])?.id).toBe('early');
    expect(pickEntryExecution(ts, [at(-3, 'early'), at(3, 'late')])?.id).toBe('early');
    expect(pickEntryExecution(ts, [at(2, 'z'), at(2, 'a')])?.id).toBe('a');
    expect(pickEntryExecution(ts, [at(2, 'a'), at(2, 'z')])?.id).toBe('a');
  });
});

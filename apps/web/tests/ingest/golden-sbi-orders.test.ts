// 実データのゴールデンテスト。data/raw/sbi-orders/ に注文履歴（詳細）の JSON があるときだけ動く（JSON はコミットしない）。
// 約定履歴照会 CSV（data/raw/sbi/SaveFile_*.csv）もあれば、時刻の割り当てとラウンドの損益が変わらないことも確かめる。

import fs from 'node:fs';
import path from 'node:path';
import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { parseSbiCsvBuffer } from '@/lib/ingest/sbi-csv';
import { matchOrderFills, parseSbiOrderFiles } from '@/lib/ingest/sbi-orders';
import { normalizedToExecForRound } from '@/lib/ingest/to-round';
import { buildSbiRounds } from '@/lib/rounds/builder';
import { jstYmd } from '@/lib/time';

const ORDERS_DIR = path.resolve(__dirname, '../../../../data/raw/sbi-orders');
const CSV_DIR = path.resolve(__dirname, '../../../../data/raw/sbi');
const jsons = fs.existsSync(ORDERS_DIR) ? fs.readdirSync(ORDERS_DIR).filter((f) => f.endsWith('.json')).sort() : [];
const csvs = fs.existsSync(CSV_DIR) ? fs.readdirSync(CSV_DIR).filter((f) => /^SaveFile_.*\.csv$/i.test(f)) : [];

describe.skipIf(jsons.length === 0)('ゴールデン: 実 JSON の注文履歴（詳細）', () => {
  const parsed = parseSbiOrderFiles(jsons.map((f) => ({ name: f, json: JSON.parse(fs.readFileSync(path.join(ORDERS_DIR, f), 'utf-8')) })));
  const byOrder = (no: string, date: string) => parsed.fills.filter((f) => f.orderNo === no && f.date === date);
  const brief = (no: string, date: string) => byOrder(no, date).map((f) => [f.symbol, f.kind, f.time, f.market, f.qty, f.price]);

  it('警告なしで読める', () => {
    expect(parsed.warnings).toEqual([]);
    expect(parsed.fills.length).toBeGreaterThan(0);
  });

  it('11/06 太陽誘電 6976 注文 10052: 09:21:32 PTS（X）100 株 5,870.8', () => {
    expect(brief('10052', '2026-11-06')).toEqual([['6976', '信新買', '09:21:32', 'PTS（X）', '100', '5870.8']]);
    expect(byOrder('10052', '2026-11-06')[0]).toMatchObject({ orderType: '指値', orderPrice: '5873' });
  });

  it('11/04 IHI 7013 注文 10000: SOR で PTS（X）と東証に 100 株ずつ', () => {
    expect(brief('10000', '2026-11-04')).toEqual([
      ['7013', '信新買', '13:05:24', 'PTS（X）', '100', '2151.9'],
      ['7013', '信新買', '13:05:24', '東証', '100', '2152'],
    ]);
  });

  it('11/06 キオクシア 285A 注文 10067（逆指値）: 09:36:42 に待機、09:36:45 に 8,318 で約定', () => {
    expect(brief('10067', '2026-11-06')).toEqual([['285A', '信返売', '09:36:45', '東証', '100', '8318']]);
    const f = byOrder('10067', '2026-11-06')[0];
    expect(f.orderKind).toBe('逆指値注文');
    expect(f.stopWaitAt?.toISOString()).toBe('2026-11-06T00:36:42.000Z');
  });

  it('11/06 フジクラ 5803 注文 10060（2 回訂正）: 最後の指値 2,713.5 で 09:32:14 に約定', () => {
    expect(brief('10060', '2026-11-06')).toEqual([['5803', '信返買', '09:32:14', '東証', '100', '2713.5']]);
    expect(byOrder('10060', '2026-11-06')[0].orderPrice).toBe('2713.5');
  });

  describe.skipIf(csvs.length === 0)('実 CSV との突き合わせ', () => {
    const execs = csvs.flatMap((f) => parseSbiCsvBuffer(fs.readFileSync(path.join(CSV_DIR, f))).executions);
    const symbols = new Map<string, number>();
    const byHash = new Map<string, ReturnType<typeof normalizedToExecForRound> & { market: string | null; symbol: string }>();
    for (const e of execs) {
      if (!symbols.has(e.instrument.symbol)) symbols.set(e.instrument.symbol, symbols.size + 1);
      const x = normalizedToExecForRound(e, symbols.get(e.instrument.symbol)!);
      const m = e.raw['市場'];
      byHash.set(x.id, { ...x, symbol: e.instrument.symbol, market: typeof m === 'string' && m !== '--' ? m : null });
    }
    const all = [...byHash.values()];
    const match = matchOrderFills(
      all.map((x) => ({ ...x, date: jstYmd(x.executedAt), marginType: x.marginType })),
      parsed.fills,
    );
    const at = new Map(match.assignments.map((a) => [a.id, a.executedAt]));

    it('11/06 太陽誘電 6976 の信用新規買 PTS（X）100 株 5,870.8 に 09:21:32 が付く', () => {
      const hit = all.filter(
        (x) => jstYmd(x.executedAt) === '2026-11-06' && x.symbol === '6976' && x.side === 'BUY' && x.marginType === 'MARGIN_LONG' && x.price === '5870.8',
      );
      expect(hit).toHaveLength(1);
      expect(at.get(hit[0].id)?.toISOString()).toBe('2026-11-06T00:21:32.000Z');
    });

    it('割り当てた約定は市場・単価・売買・日付が CSV 行と同じ。時刻を付けても（建玉が残っていない銘柄の）ラウンドの損益の合計は変わらない', () => {
      for (const a of match.assignments) {
        const x = byHash.get(a.id)!;
        for (const f of a.fills) {
          expect([f.date, f.symbol, f.side, f.marginType, f.market, new Decimal(f.price).eq(x.price!)]).toEqual([
            jstYmd(x.executedAt), x.symbol, x.side, x.marginType, x.market, true,
          ]);
        }
      }
      const timed = all.map((x) => (at.has(x.id) ? { ...x, executedAt: at.get(x.id)!, timePrecision: 'ms' as const } : x));
      // 建玉が残っている銘柄（銘柄 × 信用の種類）は比べない: 時刻が無いとその日の約定が 1 つの OPEN ラウンドにまとまり、
      // 途中までの損益の切り方が時刻付きと変わる（11-11 の ERTH・HENNGE の買い建てが持ち越しで発覚）。決済し切った銘柄は一致するはず
      const key = (r: { instrumentId: number; marginType: string | null }) => `${r.instrumentId} ${r.marginType}`;
      const open = new Set([...buildSbiRounds(all), ...buildSbiRounds(timed)].filter((r) => r.status === 'OPEN').map(key));
      const total = (xs: typeof all) => buildSbiRounds(xs).filter((r) => !open.has(key(r))).reduce((s, r) => s.plus(r.netPnl ?? 0), new Decimal(0));
      const count = (reason: string) => match.unmatchedExecs.filter((u) => u.reason === reason).length;
      console.log(
        `[golden-orders] 約定 ${parsed.fills.length} / 対象の CSV 行 ${match.candidates} / 時刻付き ${match.assignments.length} / ` +
          `注文履歴に無い ${count('no-fill')} / 見送り ${count('bucket-incomplete')} / 建玉が残る銘柄 ${open.size} / 損益合計 ${total(all)} → ${total(timed)}`,
      );
      expect(total(timed).toString()).toBe(total(all).toString());
    });
  });
});

// 実 CSV のゴールデンテスト。data/raw/sbi/ に約定履歴照会（SaveFile_*.csv）があるときだけ動く（CSV はコミットしない）。
// CSV の「決済損益」（信用返済行、SBI が計算した手数料込みの値）と builder の信用ラウンドの損益を突き合わせる。
//
// 合わせ込みはしない。既知の差は理由ごとに分けて検証し、説明できない差が 0 であることを確かめる。
//  1. 現引の行の「手数料/諸経費等」: builder はラウンドの手数料に入れるが、SBI は現引を決済損益に数えない。
//  2. 未決済ラウンド: SBI は建玉を個別に指定して返済する（どの建玉を返したかで損益が変わる）が、
//     builder は移動平均法。0 → 0 で閉じれば合計は一致するが、途中の実現損益は一致しない。

import fs from 'node:fs';
import path from 'node:path';
import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { parseSbiCsvBuffer } from '@/lib/ingest/sbi-csv';
import { normalizedToExecForRound } from '@/lib/ingest/to-round';
import type { NormalizedExecution } from '@/lib/ingest/types';
import { buildSbiRounds } from '@/lib/rounds/builder';

const DIR = path.resolve(__dirname, '../../../../data/raw/sbi');
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => /^SaveFile_.*\.csv$/i.test(f)) : [];

describe.skipIf(files.length === 0)('ゴールデン: 実 CSV の決済損益 と builder の信用ラウンド', () => {
  const execs: NormalizedExecution[] = [];
  for (const f of files) {
    const r = parseSbiCsvBuffer(fs.readFileSync(path.join(DIR, f)));
    expect(r.format).toBe('third-savefile');
    expect(r.warnings).toEqual([]);
    execs.push(...r.executions);
  }
  // 複数ファイルの期間が重なっても同じ約定は 1 つ（dedupeHash で寄せる）
  const symbols = new Map<string, number>();
  const byHash = new Map<string, { n: NormalizedExecution; id: number }>();
  for (const e of execs) {
    if (!symbols.has(e.instrument.symbol)) symbols.set(e.instrument.symbol, symbols.size + 1);
    const x = normalizedToExecForRound(e, symbols.get(e.instrument.symbol)!);
    byHash.set(x.id, { n: e, id: x.instrumentId });
  }
  const forRound = [...byHash.values()].map(({ n, id }) => normalizedToExecForRound(n, id));
  const rounds = buildSbiRounds(forRound).filter((r) => r.marginType !== 'CASH');
  const sum = (xs: Array<string | null | undefined>) => xs.reduce((a, x) => a.plus(x ?? 0), new Decimal(0));
  const brokerOf = (r: (typeof rounds)[number]) => sum(r.executions.map((x) => byHash.get(x.id)!.n.brokerPnl));
  const genbikiFees = (r: (typeof rounds)[number]) =>
    r.executions
      .map((x) => byHash.get(x.id)!.n)
      .filter((n) => n.roleSuffix?.startsWith('close-'))
      .reduce((a, n) => a.plus(n.fee).plus(n.tax), new Decimal(0));

  const csvTotal = sum([...byHash.values()].map((v) => v.n.brokerPnl));
  const builderTotal = sum(rounds.map((r) => r.netPnl));
  const closed = rounds.filter((r) => r.status === 'CLOSED');
  const open = rounds.filter((r) => r.status === 'OPEN');

  it('合計の差と内訳を出す（説明できない差が 0）', () => {
    const feeDiff = sum(closed.map((r) => genbikiFees(r).neg().toString()));
    const openDiff = sum(open.map((r) => new Decimal(r.netPnl ?? 0).minus(brokerOf(r)).toString()));
    const unexplained = builderTotal.minus(csvTotal).minus(feeDiff).minus(openDiff);
    console.log(
      [
        `[golden] ファイル ${files.length} 本・約定 ${byHash.size} 件・信用ラウンド ${rounds.length}（未決済 ${open.length}）`,
        `[golden] CSV 決済損益の合計 ${csvTotal} / builder 信用ラウンド netPnl の合計 ${builderTotal} / 差 ${builderTotal.minus(csvTotal)}`,
        `[golden]   うち 現引の諸経費 ${feeDiff}（${closed.filter((r) => !genbikiFees(r).isZero()).length} ラウンド）`,
        `[golden]   うち 未決済ラウンドの移動平均と個別建玉の差 ${openDiff}`,
        `[golden]   説明できない差 ${unexplained}`,
        `[golden] builder 信用ラウンド realizedPnl（手数料前）の合計 ${sum(rounds.map((r) => r.realizedPnl))}`,
      ].join('\n'),
    );
    expect(unexplained.toString()).toBe('0');
  });

  it('閉じたラウンドは 1 本ずつ一致する（現引の諸経費を除く）', () => {
    const bad = closed
      .filter((r) => !new Decimal(r.netPnl!).plus(genbikiFees(r)).eq(brokerOf(r)))
      .map((r) => ({ id: r.id, net: r.netPnl, broker: brokerOf(r).toString() }));
    expect(bad).toEqual([]);
  });

  it('価格の欠け・警告は無い', () => {
    expect(rounds.filter((r) => r.netPnl === null)).toEqual([]);
    expect(rounds.flatMap((r) => r.warnings)).toEqual([]);
  });
});

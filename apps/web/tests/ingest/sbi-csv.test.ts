import { describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import { parseSbiCsvBuffer, parseSbiCsvText } from '@/lib/ingest/sbi-csv';
import { makeDedupeHash, instrumentNaturalKey } from '@/lib/ingest/dedupe';

const HEADER =
  '"約定日","約定時刻","銘柄コード","銘柄名","市場","取引区分","数量[株]","約定単価","手数料[円]","税金[円]","注文番号","約定番号"';

const CSV_BASIC = [
  ',お客様の取引履歴一覧,',
  ',期間: 2026年5月1日 ～ 2026年5月14日',
  ',',
  HEADER,
  '"2026/05/14","09:00:30","7203","トヨタ自動車","東証P","株式現物買","100","2500","0","0","ORD001","FIL001"',
  '"2026/05/14","14:55:00","7203","トヨタ自動車","東証P","株式現物売","100","2550","0","0","ORD002","FIL002"',
  '"2026/05/15","10:00:00","9984","ソフトバンクＧ","東証P","信用新規買","200","8000","550","55","ORD003","FIL003"',
  '"2026/05/16","11:30:00","9984","ソフトバンクＧ","東証P","信用返済売","200","8100","550","55","ORD004","FIL004"',
].join('\n');

describe('parseSbiCsvText: basic', () => {
  it('現物買/売の往復をパースできる', () => {
    const { executions, warnings } = parseSbiCsvText(CSV_BASIC);
    expect(warnings).toEqual([]);
    expect(executions).toHaveLength(4);

    const e0 = executions[0];
    expect(e0.broker).toBe('SBI');
    expect(e0.instrument.kind).toBe('EQUITY_JP');
    expect(e0.instrument.symbol).toBe('7203');
    expect(e0.instrument.ccy).toBe('JPY');
    expect(e0.side).toBe('BUY');
    expect(e0.marginType).toBe('CASH');
    expect(e0.qty).toBe('100');
    expect(e0.price).toBe('2500');
    expect(e0.externalFillId).toBe('FIL001');
    // 09:00:30 JST = 00:00:30 UTC
    expect(e0.executedAt.toISOString()).toBe('2026-05-14T00:00:30.000Z');
  });

  it('信用新規買 → 信用返済売 が marginType=MARGIN_LONG で揃う', () => {
    const { executions } = parseSbiCsvText(CSV_BASIC);
    const e2 = executions[2];
    const e3 = executions[3];
    expect(e2.side).toBe('BUY');
    expect(e2.marginType).toBe('MARGIN_LONG');
    expect(e3.side).toBe('SELL');
    expect(e3.marginType).toBe('MARGIN_LONG');
    expect(e2.fee).toBe('550');
    expect(e2.tax).toBe('55');
  });

  it('時刻なしでも日付だけは取れる (時刻 09:00 JST = 00:00 UTC 相当に丸める)', () => {
    const csv = [
      HEADER.replace(',"約定時刻"', ''),
      '"2026/05/14","7203","トヨタ自動車","東証P","株式現物買","100","2500","0","0","ORD001","FIL001"',
    ].join('\n');
    const { executions, warnings } = parseSbiCsvText(csv);
    expect(warnings).toEqual([]);
    expect(executions).toHaveLength(1);
    expect(executions[0].executedAt.toISOString().startsWith('2026-05-14T')).toBe(true);
  });
});

describe('parseSbiCsvText: 数値・和暦', () => {
  it('カンマ区切り数値と円記号を Decimal 文字列に正規化', () => {
    const csv = [
      HEADER,
      '"2026/05/14","09:00","7203","トヨタ自動車","東証P","株式現物買","1,000","¥2,500","330","33","ORD001","FIL001"',
    ].join('\n');
    const { executions } = parseSbiCsvText(csv);
    expect(executions[0].qty).toBe('1000');
    expect(executions[0].price).toBe('2500');
    expect(executions[0].fee).toBe('330');
  });

  it('和暦 (令和) もパースできる', () => {
    const csv = [
      HEADER,
      '"R8/05/14","09:00","7203","トヨタ","東証P","株式現物買","100","2500","0","0","ORD001","FIL001"',
    ].join('\n');
    const { executions, warnings } = parseSbiCsvText(csv);
    expect(warnings).toEqual([]);
    // R8 = 2026
    expect(executions[0].executedAt.toISOString().startsWith('2026-05-14T')).toBe(true);
  });

  it('信用新規売 → 信用返済買 が MARGIN_SHORT', () => {
    const csv = [
      HEADER,
      '"2026/05/14","09:00","7203","トヨタ","東証P","信用新規売","100","2500","330","33","ORD005","FIL005"',
      '"2026/05/16","09:30","7203","トヨタ","東証P","信用返済買","100","2400","330","33","ORD006","FIL006"',
    ].join('\n');
    const { executions } = parseSbiCsvText(csv);
    expect(executions[0].side).toBe('SELL');
    expect(executions[0].marginType).toBe('MARGIN_SHORT');
    expect(executions[1].side).toBe('BUY');
    expect(executions[1].marginType).toBe('MARGIN_SHORT');
  });
});

describe('parseSbiCsvText: 異常系', () => {
  it('ヘッダがない場合は警告を返して空', () => {
    const { executions, warnings } = parseSbiCsvText('aaa,bbb\n1,2\n');
    expect(executions).toHaveLength(0);
    expect(warnings[0].code).toBe('no-header');
  });

  it('未知の取引区分は警告で行スキップ', () => {
    const csv = [
      HEADER,
      '"2026/05/14","09:00","7203","トヨタ","東証P","お小遣い","100","2500","0","0","ORD007","FIL007"',
      '"2026/05/14","10:00","7203","トヨタ","東証P","株式現物買","100","2500","0","0","ORD008","FIL008"',
    ].join('\n');
    const { executions, warnings } = parseSbiCsvText(csv);
    expect(executions).toHaveLength(1);
    expect(warnings.find((w) => w.code === 'unknown-kind')).toBeTruthy();
  });
});

describe('parseSbiCsvText: 現引/現渡 (split kind)', () => {
  // 旧フォーマット (約定時刻あり) — 現引
  it('現引 1 行から MARGIN_LONG SELL + CASH BUY の 2 Execution を生成', () => {
    const csv = [
      HEADER,
      '"2026/05/01","09:00","6092","エンバイオHD","東証G","現引","100","798.3","0","0","ORD100","FIL100"',
    ].join('\n');
    const { executions, warnings } = parseSbiCsvText(csv);
    expect(warnings).toEqual([]);
    expect(executions).toHaveLength(2);

    const [margin, cash] = executions;
    expect(margin.side).toBe('SELL');
    expect(margin.marginType).toBe('MARGIN_LONG');
    expect(margin.roleSuffix).toBe('close-margin');
    expect(cash.side).toBe('BUY');
    expect(cash.marginType).toBe('CASH');
    expect(cash.roleSuffix).toBe('cash-receipt');

    // 同じ instrument / qty / price / executedAt
    expect(margin.instrument.symbol).toBe('6092');
    expect(cash.instrument.symbol).toBe('6092');
    expect(margin.qty).toBe('100');
    expect(cash.qty).toBe('100');
    expect(margin.price).toBe('798.3');
    expect(cash.price).toBe('798.3');
    expect(margin.executedAt.toISOString()).toBe(cash.executedAt.toISOString());

    // dedupeHash は別 (marginType + roleSuffix 違いで衝突しない)
    expect(makeDedupeHash(margin)).not.toBe(makeDedupeHash(cash));
  });

  it('現渡 1 行から MARGIN_SHORT BUY + CASH SELL の 2 Execution を生成', () => {
    const csv = [
      HEADER,
      '"2026/05/01","09:00","7203","トヨタ","東証P","現渡","100","2500","0","0","ORD101","FIL101"',
    ].join('\n');
    const { executions, warnings } = parseSbiCsvText(csv);
    expect(warnings).toEqual([]);
    expect(executions).toHaveLength(2);

    const [margin, cash] = executions;
    expect(margin.side).toBe('BUY');
    expect(margin.marginType).toBe('MARGIN_SHORT');
    expect(margin.roleSuffix).toBe('close-short');
    expect(cash.side).toBe('SELL');
    expect(cash.marginType).toBe('CASH');
    expect(cash.roleSuffix).toBe('cash-deliver');
  });

  // 新フォーマット (注文一覧_当日約定) — 現引 9 件分の fixture
  it('新フォーマット 9 行 (全部 現引) で 18 Execution + warnings 空', () => {
    const NEW_HEADER =
      '銘柄,銘柄,銘柄,取引区分,期限,預り区分,約定日,受渡日,株数,平均約定単価,手数料・諸経費等,課税額・譲渡益税,受渡金額・決済損益,受渡金額(日計り分)';
    const rows = [
      '6092,エンバイオ・ホールディングス,--,現引,６ヵ月,特定,2026/05/01,2026/05/08,100,798.3,55,--,"-79,885",--',
      '3803,イメージ情報開発,--,現引,６ヵ月,特定,2026/03/19,2026/03/24,100,711.9,10,--,"-71,200",--',
      '6356,日本ギア工業,--,現引,６ヵ月,特定,2026/03/09,2026/03/11,100,"2,195",16,--,"-219,516",--',
      '350A,デジタルグリッド,--,現引,６ヵ月,特定,2026/02/18,2026/02/20,200,915,14,--,"-183,014",--',
      '247A,Ａｉロボティクス,--,現引,６ヵ月,特定,2026/02/13,2026/02/17,100,"1,465",11,--,"-146,511",--',
      '7794,イーディーピー,--,現引,６ヵ月,特定,2026/02/06,2026/02/10,100,"1,047",8,--,"-104,708",--',
      '257A,ＳＭＴ　ＥＴＦ日本株厳選投資アクティブ,--,現引,日計り,特定,2026/01/19,2026/01/21,1,"5,860",--,--,"-5,860",--',
      '5707,東邦亜鉛,--,現引,６ヵ月,特定,2026/01/15,2026/01/19,100,"1,659",50,--,"-165,950",--',
      '4588,オンコリスバイオファーマ,--,現引,６ヵ月,特定,2026/01/09,2026/01/14,100,"1,632.4",25,--,"-163,265",--',
    ];
    const csv = [NEW_HEADER, ...rows].join('\n');
    const { executions, warnings } = parseSbiCsvText(csv);
    expect(warnings).toEqual([]);
    expect(executions).toHaveLength(18);

    // 全 18 件のうち、9 件は MARGIN_LONG SELL、9 件は CASH BUY
    const margins = executions.filter((e) => e.marginType === 'MARGIN_LONG');
    const cashes = executions.filter((e) => e.marginType === 'CASH');
    expect(margins).toHaveLength(9);
    expect(cashes).toHaveLength(9);
    margins.forEach((e) => {
      expect(e.side).toBe('SELL');
      // 新フォーマットでは現引 + 受渡損益 で合成 roleSuffix が付く
      expect(e.roleSuffix).toMatch(/^close-margin(\|pnl=-?\d+)?$/);
    });
    cashes.forEach((e) => {
      expect(e.side).toBe('BUY');
      expect(e.roleSuffix).toMatch(/^cash-receipt(\|pnl=-?\d+)?$/);
    });

    // 全 dedupeHash がユニーク
    const hashes = new Set(executions.map((e) => makeDedupeHash(e)));
    expect(hashes.size).toBe(18);
  });

  it('現引 row でも fee/tax は MARGIN_LONG 側に寄せ、CASH 側は 0', () => {
    const csv = [
      HEADER,
      '"2026/05/01","09:00","6092","エンバイオHD","東証G","現引","100","798.3","55","11","ORD100","FIL100"',
    ].join('\n');
    const { executions } = parseSbiCsvText(csv);
    const [margin, cash] = executions;
    expect(margin.fee).toBe('55');
    expect(margin.tax).toBe('11');
    expect(cash.fee).toBe('0');
    expect(cash.tax).toBe('0');
  });
});

describe('parseSbiCsvText: 新フォーマット (約定履歴) で受渡損益による dedupe', () => {
  const NEW_HEADER =
    '銘柄,銘柄,銘柄,取引区分,期限,預り区分,約定日,受渡日,株数,平均約定単価,手数料・諸経費等,課税額・譲渡益税,受渡金額・決済損益,受渡金額(日計り分)';

  it('同日同銘柄同価格同 side の信用返済売 2 行 (受渡損益違い) が別 dedupeHash になる', () => {
    const csv = [
      NEW_HEADER,
      // 4506 を 1666.8 で 100 株返済売 ×2、損益違い (-1262 と +348)
      '4506,住友ファーマ,PTS(O),信用返済売,６ヵ月,特定,2026/05/11,2026/05/13,100,"1,666.8",12,--,"-1,262",--',
      '4506,住友ファーマ,PTS(O),信用返済売,６ヵ月,特定,2026/05/11,2026/05/13,100,"1,666.8",12,--,"348",--',
    ].join('\n');
    const { executions, warnings } = parseSbiCsvText(csv);
    expect(warnings).toEqual([]);
    expect(executions).toHaveLength(2);
    expect(executions[0].roleSuffix).toBe('pnl=-1262');
    expect(executions[1].roleSuffix).toBe('pnl=348');
    expect(makeDedupeHash(executions[0])).not.toBe(makeDedupeHash(executions[1]));
  });

  it('受渡損益が "--" の同自然キー 2 行 → seq=2 で別 hash', () => {
    const csv = [
      NEW_HEADER,
      '4506,住友ファーマ,PTS(O),信用返済売,６ヵ月,特定,2026/05/11,2026/05/13,100,"1,666.8",12,--,--,--',
      '4506,住友ファーマ,PTS(O),信用返済売,６ヵ月,特定,2026/05/11,2026/05/13,100,"1,666.8",12,--,--,--',
    ].join('\n');
    const { executions, warnings } = parseSbiCsvText(csv);
    expect(warnings).toEqual([]);
    expect(executions).toHaveLength(2);
    expect(executions[0].roleSuffix).toBeUndefined();
    expect(executions[1].roleSuffix).toBe('seq=2');
    expect(makeDedupeHash(executions[0])).not.toBe(makeDedupeHash(executions[1]));
  });

  it('現引行 + 受渡損益あり → roleSuffix が close-margin|pnl=... の合成になる', () => {
    const csv = [
      NEW_HEADER,
      '6092,エンバイオHD,東G,現引,６ヵ月,特定,2026/05/01,2026/05/08,100,798.3,55,--,"-79,885",--',
    ].join('\n');
    const { executions, warnings } = parseSbiCsvText(csv);
    expect(warnings).toEqual([]);
    expect(executions).toHaveLength(2);
    expect(executions[0].roleSuffix).toBe('close-margin|pnl=-79885');
    expect(executions[1].roleSuffix).toBe('cash-receipt|pnl=-79885');
    expect(makeDedupeHash(executions[0])).not.toBe(makeDedupeHash(executions[1]));
  });

  it('注文照会 CSV (詳細,注文番号,...) は新フォーマットとして拾わず no-header warning', () => {
    const csv = [
      '詳細,注文番号,注文状況,約定状況,銘柄,銘柄,銘柄,市場,取引区分,期限,注文種別,預り区分,執行条件,注文日,注文期間,注文株数,未約定,注文単価',
      '詳細,6964,完了,全約定,1542,純銀ETF,東E,東証,信用新規買,６ヵ月,通常,特定,成行,2026/05/13,2026/05/14,2,--,--',
    ].join('\n');
    const { executions, warnings } = parseSbiCsvText(csv);
    expect(executions).toHaveLength(0);
    expect(warnings.some((w) => w.code === 'no-header')).toBe(true);
  });
});

describe('parseSbiCsvBuffer: SJIS デコード', () => {
  it('CP932 でエンコードされた CSV を扱える', () => {
    const buf = iconv.encode(CSV_BASIC, 'cp932');
    const { executions, warnings } = parseSbiCsvBuffer(buf);
    expect(warnings).toEqual([]);
    expect(executions).toHaveLength(4);
    expect(executions[0].instrument.name).toBe('トヨタ自動車');
  });
});

describe('dedupe', () => {
  it('同じ Execution は同じハッシュ', () => {
    const { executions } = parseSbiCsvText(CSV_BASIC);
    const h1 = makeDedupeHash(executions[0]);
    const h2 = makeDedupeHash({ ...executions[0] });
    expect(h1).toBe(h2);
  });

  it('order+fill ID が違えば別ハッシュ', () => {
    const { executions } = parseSbiCsvText(CSV_BASIC);
    const e = executions[0];
    const a = makeDedupeHash(e);
    const b = makeDedupeHash({ ...e, externalFillId: 'OTHER' });
    expect(a).not.toBe(b);
  });

  it('Order ID 無しでも自然キーで dedupe できる', () => {
    const { executions } = parseSbiCsvText(CSV_BASIC);
    const e = executions[0];
    const stripped = { ...e, externalOrderId: undefined, externalFillId: undefined };
    const h1 = makeDedupeHash(stripped);
    const h2 = makeDedupeHash({ ...stripped });
    expect(h1).toBe(h2);
    // executedAt が違えば別
    const h3 = makeDedupeHash({ ...stripped, executedAt: new Date(stripped.executedAt.getTime() + 1000) });
    expect(h1).not.toBe(h3);
  });

  it('instrumentNaturalKey: 現物とオプションを区別', () => {
    expect(instrumentNaturalKey({ kind: 'EQUITY_JP', symbol: '7203', ccy: 'JPY' })).toBe('EQUITY_JP:7203');
    expect(
      instrumentNaturalKey({
        kind: 'OPTION_US',
        symbol: 'AAPL',
        underlying: 'AAPL',
        expiry: new Date(Date.UTC(2026, 4, 15)),
        strike: '136',
        right: 'CALL',
        multiplier: 100,
        occSymbol: 'AAPL  260515C00136000',
        ccy: 'USD',
      }),
    ).toBe('OPT:AAPL:2026-05-15:136:CALL');
  });
});

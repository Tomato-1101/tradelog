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
    expect(e0.instrument.symbol).toBe('7203');
    expect(e0.timePrecision).toBe('ms');
    expect(e0.brokerPnl).toBeNull();
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
    expect(executions[0].timePrecision).toBe('day');
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
    // 現引の受渡金額は決済損益ではないので brokerPnl は持たない
    expect(margin.brokerPnl).toBeNull();
    expect(cash.brokerPnl).toBeNull();
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
    expect(executions.map((e) => e.brokerPnl)).toEqual(['-1262', '348']);
    expect(executions.every((e) => e.timePrecision === 'day')).toBe(true);
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

describe('parseSbiCsvText: 約定履歴照会 (SaveFile_*.csv) フォーマット', () => {
  const THIRD_HEADER =
    '約定日,銘柄,銘柄コード,市場,取引,期限,預り,課税,約定数量,約定単価,手数料/諸経費等,税額,受渡日,受渡金額/決済損益';
  const PREAMBLE = [
    '',
    '約定履歴照会 ',
    '',
    '商品指定,約定開始年月日,約定終了年月日,明細数,明細指定開始,明細指定終了',
    '"すべての商品","2024年01月01日","2026年12月17日","6944","1","6944"',
    '',
    '（注）明細数はご指定された期間の合計です。',
    '',
  ].join('\n');

  it('プリアンブル付きで現物売をパースできる (受渡金額が roleSuffix に乗る)', () => {
    const csv = [
      PREAMBLE,
      THIRD_HEADER,
      '"2024/05/02","東京電力ホールディングス","9501","--",株式現物売,"--"," 特定 ","申告",4,960,--,--,"2024/05/08",3840',
    ].join('\n');
    const { executions, warnings } = parseSbiCsvText(csv);
    expect(warnings).toEqual([]);
    expect(executions).toHaveLength(1);
    const e = executions[0];
    expect(e.broker).toBe('SBI');
    expect(e.instrument.symbol).toBe('9501');
    expect(e.instrument.name).toBe('東京電力ホールディングス');
    expect(e.side).toBe('SELL');
    expect(e.marginType).toBe('CASH');
    expect(e.qty).toBe('4');
    expect(e.price).toBe('960');
    expect(e.fee).toBe('0');
    expect(e.roleSuffix).toBe('pnl=3840');
    // 約定履歴照会には時刻が無い
    expect(e.timePrecision).toBe('day');
    // 現物売の受渡金額は決済損益ではない
    expect(e.brokerPnl).toBeNull();
  });

  it('信用返済売で同価格・同数量・異損益の 2 行が別 dedupeHash になる', () => {
    const csv = [
      PREAMBLE,
      THIRD_HEADER,
      '"2026/05/11","住友ファーマ","4506","東証",信用返済売,"６ヵ月"," 特定 ","--",100,"1,666.8",12,--,"2026/05/13","-1,262"',
      '"2026/05/11","住友ファーマ","4506","東証",信用返済売,"６ヵ月"," 特定 ","--",100,"1,666.8",12,--,"2026/05/13","348"',
    ].join('\n');
    const { executions, warnings } = parseSbiCsvText(csv);
    expect(warnings).toEqual([]);
    expect(executions).toHaveLength(2);
    expect(executions[0].roleSuffix).toBe('pnl=-1262');
    expect(executions[1].roleSuffix).toBe('pnl=348');
    expect(makeDedupeHash(executions[0])).not.toBe(makeDedupeHash(executions[1]));
  });

  it('MRF / 投信 / 入出庫 は警告を出さずに静かにスキップ', () => {
    const csv = [
      PREAMBLE,
      THIRD_HEADER,
      '"2024/05/02","野村ＭＲＦ",,,MRF解約,"--"," 特定 ","--",99944,1,--,--,"2024/05/07",99944',
      '"2024/05/02","野村ＭＲＦ",,,MRF買付,"--"," 特定 ","--",1000,1,--,--,"2024/05/07",1000',
      '"2024/05/02","野村ＭＲＦ",,,MRF再投資,"--"," 特定 ","--",100,1,--,--,"2024/05/07",100',
      '"2024/05/02","eMAXIS Slim","2557","--",投信金額買付,"--"," 特定 ","--",10000,1,--,--,"2024/05/07",10000',
      '"2024/05/02","eMAXIS Slim","2557","--",投信金額解約,"--"," 特定 ","--",10000,1,--,--,"2024/05/07",10000',
      '"2024/05/02","トヨタ自動車","7203","--",株式現物買,"--"," 特定 ","--",100,2500,--,--,"2024/05/07",250000',
    ].join('\n');
    const { executions, warnings } = parseSbiCsvText(csv);
    expect(warnings).toEqual([]);
    expect(executions).toHaveLength(1);
    expect(executions[0].instrument.symbol).toBe('7203');
    expect(executions[0].side).toBe('BUY');
  });

  it('現引行は MARGIN_LONG SELL + CASH BUY に分割され、受渡金額が両側に合成', () => {
    const csv = [
      PREAMBLE,
      THIRD_HEADER,
      '"2026/05/01","エンバイオHD","6092","東証",現引,"６ヵ月"," 特定 ","--",100,798.3,--,--,"2026/05/08","-79,885"',
    ].join('\n');
    const { executions, warnings } = parseSbiCsvText(csv);
    expect(warnings).toEqual([]);
    expect(executions).toHaveLength(2);
    expect(executions[0].marginType).toBe('MARGIN_LONG');
    expect(executions[0].side).toBe('SELL');
    expect(executions[0].roleSuffix).toBe('close-margin|pnl=-79885');
    expect(executions[1].marginType).toBe('CASH');
    expect(executions[1].side).toBe('BUY');
    expect(executions[1].roleSuffix).toBe('cash-receipt|pnl=-79885');
    expect(makeDedupeHash(executions[0])).not.toBe(makeDedupeHash(executions[1]));
  });

  it('受渡金額が "--" の同自然キー 2 行は seq=2 で別ハッシュ', () => {
    const csv = [
      PREAMBLE,
      THIRD_HEADER,
      '"2026/05/11","住友ファーマ","4506","東証",信用返済売,"６ヵ月"," 特定 ","--",100,"1,666.8",--,--,"2026/05/13",--',
      '"2026/05/11","住友ファーマ","4506","東証",信用返済売,"６ヵ月"," 特定 ","--",100,"1,666.8",--,--,"2026/05/13",--',
    ].join('\n');
    const { executions, warnings } = parseSbiCsvText(csv);
    expect(warnings).toEqual([]);
    expect(executions).toHaveLength(2);
    expect(executions[0].roleSuffix).toBeUndefined();
    expect(executions[1].roleSuffix).toBe('seq=2');
    expect(makeDedupeHash(executions[0])).not.toBe(makeDedupeHash(executions[1]));
  });

  it('信用 4 区分すべてが分類される', () => {
    const csv = [
      PREAMBLE,
      THIRD_HEADER,
      '"2026/01/01","X","1000","東証",信用新規買,"６ヵ月"," 特定 ","--",100,1000,--,--,"2026/01/03",100000',
      '"2026/01/02","X","1000","東証",信用返済売,"６ヵ月"," 特定 ","--",100,1100,--,--,"2026/01/06","10,000"',
      '"2026/02/01","Y","2000","東証",信用新規売,"６ヵ月"," 特定 ","--",100,2000,--,--,"2026/02/03",200000',
      '"2026/02/02","Y","2000","東証",信用返済買,"６ヵ月"," 特定 ","--",100,1900,--,--,"2026/02/06","10,000"',
    ].join('\n');
    const { executions, warnings } = parseSbiCsvText(csv);
    expect(warnings).toEqual([]);
    expect(executions).toHaveLength(4);
    expect(executions[0]).toMatchObject({ side: 'BUY', marginType: 'MARGIN_LONG' });
    expect(executions[1]).toMatchObject({ side: 'SELL', marginType: 'MARGIN_LONG' });
    expect(executions[2]).toMatchObject({ side: 'SELL', marginType: 'MARGIN_SHORT' });
    expect(executions[3]).toMatchObject({ side: 'BUY', marginType: 'MARGIN_SHORT' });
    // 決済損益は信用返済の行だけ
    expect(executions.map((e) => e.brokerPnl)).toEqual([null, '10000', null, '10000']);
    expect(executions.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });
});

describe('ParseResult: format / earliestDate / latestDate', () => {
  const NEW_HEADER =
    '銘柄,銘柄,銘柄,取引区分,期限,預り区分,約定日,受渡日,株数,平均約定単価,手数料・諸経費等,課税額・譲渡益税,受渡金額・決済損益,受渡金額(日計り分)';
  const THIRD_HEADER =
    '約定日,銘柄,銘柄コード,市場,取引,期限,預り,課税,約定数量,約定単価,手数料/諸経費等,税額,受渡日,受渡金額/決済損益';
  const THIRD_PREAMBLE = [
    '',
    '約定履歴照会 ',
    '',
    '商品指定,約定開始年月日,約定終了年月日,明細数,明細指定開始,明細指定終了',
    '"すべての商品","2024年01月01日","2026年12月17日","6944","1","6944"',
    '',
  ].join('\n');

  it('注文一覧_当日約定 (新フォーマット) は format=new-daily と earliest/latest を返す', () => {
    const csv = [
      NEW_HEADER,
      '7203,トヨタ自動車,東P,信用返済売,６ヵ月,特定,2026/05/18,2026/05/20,100,"2,500",10,--,"1,000",--',
      '9984,ソフトバンクＧ,東P,信用返済買,６ヵ月,特定,2026/05/18,2026/05/20,100,"8,000",10,--,"-500",--',
    ].join('\n');
    const result = parseSbiCsvText(csv);
    expect(result.format).toBe('new-daily');
    expect(result.executions).toHaveLength(2);
    expect(result.earliestDate?.toISOString().startsWith('2026-05-18')).toBe(true);
    expect(result.latestDate?.toISOString().startsWith('2026-05-18')).toBe(true);
  });

  it('約定履歴照会 (SaveFile_*.csv) は format=third-savefile と earliest/latest を返す', () => {
    const csv = [
      THIRD_PREAMBLE,
      THIRD_HEADER,
      '"2026/05/14","トヨタ","7203","東証",株式現物買,"--"," 特定 ","--",100,2500,--,--,"2026/05/16","-250,000"',
      '"2026/05/18","トヨタ","7203","東証",株式現物売,"--"," 特定 ","--",100,2550,--,--,"2026/05/20","255,000"',
    ].join('\n');
    const result = parseSbiCsvText(csv);
    expect(result.format).toBe('third-savefile');
    expect(result.executions).toHaveLength(2);
    expect(result.earliestDate?.toISOString().startsWith('2026-05-14')).toBe(true);
    expect(result.latestDate?.toISOString().startsWith('2026-05-18')).toBe(true);
  });

  it('レガシー (約定時刻あり) は format=legacy', () => {
    const result = parseSbiCsvText(CSV_BASIC);
    expect(result.format).toBe('legacy');
    expect(result.earliestDate?.toISOString().startsWith('2026-05-14')).toBe(true);
    expect(result.latestDate?.toISOString().startsWith('2026-05-16')).toBe(true);
  });

  it('ヘッダなしは format=unknown で executions/dates が空', () => {
    const result = parseSbiCsvText('aaa,bbb\n1,2\n');
    expect(result.format).toBe('unknown');
    expect(result.executions).toHaveLength(0);
    expect(result.earliestDate).toBeNull();
    expect(result.latestDate).toBeNull();
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

  it('instrumentNaturalKey: 旧版と同じ EQUITY_JP:コード の形', () => {
    expect(instrumentNaturalKey({ symbol: '7203' })).toBe('EQUITY_JP:7203');
    expect(instrumentNaturalKey({ symbol: '285A', name: 'キオクシア' })).toBe('EQUITY_JP:285A');
  });
});

// ImportBatch.source の判定ヘルパー。
// SBI CSV は取り込み経路ごとに 'sbi-csv' / 'sbi-csv-daily' / 'sbi-csv-savefile' と
// 枝分かれするので、由来判定は前方一致で行う (完全一致だと UI 経由の取り込みが漏れる)。

export function isSbiCsvSource(source: string | null | undefined): boolean {
  return typeof source === 'string' && source.startsWith('sbi-csv');
}

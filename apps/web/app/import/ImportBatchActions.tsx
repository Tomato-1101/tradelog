// ImportBatch (単体 or 集約) の操作 (非表示/再表示・削除) を 2 つの form にまとめた Server Component。
// 集約エントリ (moomoo API) は複数 batchId を内包し、CSV 一括/個別アクションで一括処理する。
// 削除確認ダイアログは廃止 (ユーザー要望)。

type Props = {
  batchIds: string[];
  hidden: boolean;
  setHiddenAction: (fd: FormData) => void | Promise<void>;
  deleteAction: (fd: FormData) => void | Promise<void>;
};

export default function ImportBatchActions({
  batchIds,
  hidden,
  setHiddenAction,
  deleteAction,
}: Props) {
  const idsCsv = batchIds.join(',');
  return (
    <div className="flex flex-col gap-1.5">
      <form action={setHiddenAction}>
        <input type="hidden" name="batchIds" value={idsCsv} />
        <input type="hidden" name="hidden" value={hidden ? 'false' : 'true'} />
        <button
          type="submit"
          className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-xs hover:bg-[var(--surface-muted)]"
        >
          {hidden ? '再表示' : '非表示'}
        </button>
      </form>
      <form action={deleteAction}>
        <input type="hidden" name="batchIds" value={idsCsv} />
        <button
          type="submit"
          className="w-full rounded-md border border-[var(--neg)] bg-[var(--neg-bg)] px-3 py-1 text-xs text-[var(--neg)] hover:opacity-90"
        >
          削除
        </button>
      </form>
    </div>
  );
}

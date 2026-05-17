'use client';

// ImportBatch 1 件分の操作 (非表示/再表示・削除) を 2 つの form にまとめた Client Component。
// 削除前に window.confirm を挟むため Client にしている。Server Action 自体は親 (page.tsx) で定義し
// props で受け取って <form action={...}> に渡す。

type Props = {
  batchId: string;
  hidden: boolean;
  newCount: number;
  setHiddenAction: (fd: FormData) => void | Promise<void>;
  deleteAction: (fd: FormData) => void | Promise<void>;
};

export default function ImportBatchActions({
  batchId,
  hidden,
  newCount,
  setHiddenAction,
  deleteAction,
}: Props) {
  return (
    <div className="flex flex-col gap-1.5">
      <form action={setHiddenAction}>
        <input type="hidden" name="batchId" value={batchId} />
        <input type="hidden" name="hidden" value={hidden ? 'false' : 'true'} />
        <button
          type="submit"
          className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-xs hover:bg-[var(--surface-muted)]"
        >
          {hidden ? '再表示' : '非表示'}
        </button>
      </form>
      <form
        action={deleteAction}
        onSubmit={(e) => {
          if (
            !window.confirm(
              `このバッチの Execution (新規 ${newCount} 件) を完全に削除します。よろしいですか?`,
            )
          ) {
            e.preventDefault();
          }
        }}
      >
        <input type="hidden" name="batchId" value={batchId} />
        <input type="hidden" name="confirm" value="yes" />
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

'use client';

// 保有ポジション行の削除ボタン。実体は構成 Execution の物理削除で元に戻せないため、
// 送信前に confirm を挟む (キャンセル時は submit させない)。

type Props = {
  /** 確認ダイアログに出す銘柄ラベル */
  label: string;
};

export default function DeleteRoundButton({ label }: Props) {
  return (
    <button
      type="submit"
      onClick={(e) => {
        if (!window.confirm(`${label} の約定データを削除します。元に戻せません。よろしいですか?`)) {
          e.preventDefault();
        }
      }}
      className="rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted-strong)] hover:bg-[var(--surface-muted)]"
      title="この Round を構成する Execution を物理削除する"
    >
      削除
    </button>
  );
}

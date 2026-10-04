'use client';
// 要確認・未確定の約定の価格を手入力して確定するフォーム（Server Action: confirmPriceAction）。

import { useActionState } from 'react';
import { confirmPriceAction, type ActionState } from '@/app/actions';

export default function ManualPriceForm({ executionId, initial, label = '確定' }: { executionId: string; initial?: string | null; label?: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(confirmPriceAction, null);
  return (
    <form action={action} className="inline">
      <input type="hidden" name="executionId" value={executionId} />
      <input type="text" name="price" inputMode="decimal" placeholder="約定価格" defaultValue={initial ?? ''} aria-label="約定価格" required />
      <input type="text" name="note" className="note" placeholder="メモ（任意）" aria-label="メモ" />
      <button type="submit" disabled={pending}>
        {pending ? '確定中…' : label}
      </button>
      {state && <span className={`msg ${state.ok ? 'muted' : 'warn'}`}>{state.message}</span>}
    </form>
  );
}

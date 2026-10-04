'use client';
// SBI の個別トレードに日足が無いとき、そのラウンドの前後の日足を取得する（Server Action: fetchDailyBarsAction）。

import { useActionState } from 'react';
import { fetchDailyBarsAction, type ActionState } from '@/app/actions';

export default function FetchDailyButton({ roundId }: { roundId: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(fetchDailyBarsAction, null);
  return (
    <form action={action} className="inline">
      <input type="hidden" name="roundId" value={roundId} />
      <button type="submit" disabled={pending}>
        {pending ? '取得中…' : '日足を取得'}
      </button>
      {state && <span className={`msg ${state.ok ? 'muted' : 'warn'}`}>{state.message}</span>}
    </form>
  );
}

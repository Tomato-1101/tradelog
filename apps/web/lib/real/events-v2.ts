// 本番の注文記録 v2（board_order / real_note。契約は docs/real-events.md）の 1 行を読む（純粋関数）。
// 行の振り分け（test・書きかけ・v）は lib/real/memos.ts の parseRealEvents が行い、v=2 の行だけここに来る。

const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;
const EVENTS = ['placed', 'appeared', 'cancel_requested', 'cancelled', 'reverted', 'filled', 'vanished'] as const;
export type BoardEventKind = (typeof EVENTS)[number];

export type BoardOrderEvent = {
  id: string;
  ts: Date;
  orderKey: string;
  event: BoardEventKind;
  side: 'BUY' | 'SELL';
  price: number | null;
  qty: number | null;
  pendingMs: number | null;
  symbol: string | null;
  symbolName: string | null;
  board: Array<Record<string, unknown>>;
  raw: string;
};

export type RealNoteEvent = {
  id: string;
  ts: Date;
  text: string;
  lastOrder: (Record<string, unknown> & { order_key: string }) | null;
  raw: string;
};

export type V2Parsed = { kind: 'board_order'; event: BoardOrderEvent } | { kind: 'real_note'; event: RealNoteEvent };

const isTs = (x: unknown): x is string => typeof x === 'string' && TS.test(x) && !Number.isNaN(Date.parse(x));
// 値が読めなかった欄は null。欄そのものが無い行も null として読む
const numOrNull = (x: unknown): x is number | null | undefined => x === null || x === undefined || (typeof x === 'number' && Number.isFinite(x));
const strOrNull = (x: unknown): x is string | null | undefined => x === null || x === undefined || typeof x === 'string';

/** v=2 の行を読む。契約違反ならその理由（文字列）を返す */
export function parseV2Event(e: Record<string, unknown>, raw: string): V2Parsed | string {
  const id = typeof e.id === 'string' && e.id ? e.id : null;
  if (e.type === 'board_order') {
    if (!id) return 'id が無い';
    if (!isTs(e.ts)) return `ts の形式が違う（${JSON.stringify(e.ts)}）`;
    if (typeof e.order_key !== 'string' || !e.order_key) return 'order_key が無い';
    if (!EVENTS.includes(e.event as BoardEventKind)) return `event が契約に無い（${JSON.stringify(e.event)}）`;
    if (e.side !== 'BUY' && e.side !== 'SELL') return `side が BUY / SELL でない（${JSON.stringify(e.side)}）`;
    for (const k of ['price', 'qty', 'pending_ms'] as const) if (!numOrNull(e[k])) return `${k} が数値か null でない（${JSON.stringify(e[k])}）`;
    for (const k of ['symbol', 'symbol_name'] as const) if (!strOrNull(e[k])) return `${k} が文字列か null でない`;
    if (!Array.isArray(e.board) || !e.board.every((x) => x && typeof x === 'object' && !Array.isArray(x))) return 'board がオブジェクトの配列でない';
    return {
      kind: 'board_order',
      event: {
        id,
        ts: new Date(e.ts),
        orderKey: e.order_key,
        event: e.event as BoardEventKind,
        side: e.side,
        price: (e.price as number | null | undefined) ?? null,
        qty: (e.qty as number | null | undefined) ?? null,
        pendingMs: (e.pending_ms as number | null | undefined) ?? null,
        symbol: (e.symbol as string | null | undefined) ?? null,
        symbolName: (e.symbol_name as string | null | undefined) ?? null,
        board: e.board as Array<Record<string, unknown>>,
        raw,
      },
    };
  }
  if (e.type === 'real_note') {
    if (!id) return 'id が無い';
    if (!isTs(e.ts)) return `ts の形式が違う（${JSON.stringify(e.ts)}）`;
    if (typeof e.text !== 'string' || !e.text.trim()) return 'text が空か文字列でない';
    const lo = e.last_order;
    if (lo !== null && lo !== undefined) {
      if (typeof lo !== 'object' || Array.isArray(lo) || typeof (lo as { order_key?: unknown }).order_key !== 'string') {
        return 'last_order が order_key を持つオブジェクトか null でない';
      }
    }
    return {
      kind: 'real_note',
      event: { id, ts: new Date(e.ts), text: e.text.trim(), lastOrder: (lo as RealNoteEvent['lastOrder']) ?? null, raw },
    };
  }
  return `type が board_order / real_note でない（${JSON.stringify(e.type)}）`;
}

// data/paper/events.jsonl（docs/paper-events.md が契約の正）の厳密パースと検証。純粋関数のみ。
// 契約違反の行はエラーとして報告し、その行だけ捨てて他の行は続ける。
// ファイルは追記専用なので、毎回全行を読み直して検証し、DB への書き込みは id で冪等にする（ingest.ts）。
// リプレイ（data/paper/replay/events.jsonl）も同じパーサで読む。違いは全行に `replay` キーが必須なことだけ
// （通常のファイルに `replay` があれば契約違反）。建玉の流れはファイルごとに独立に検証する。

import { closeOf, jstYmd } from '@/lib/time';

export type Shot = {
  path: string;
  /** 以下 4 つは手で囲んだ領域の読み取り結果（無ければ null） */
  priceText: string | null;
  price: string | null;
  symbolText: string | null;
  confidence: number | null;
  /** 任意フィールド（キーが無い行では undefined）。撮影完了時刻 */
  capturedAt?: Date | null;
  windowTitle?: string | null;
  /** サイドカー（data/paper/ からの相対パス）。order 行の後に非同期で書かれるので、ファイルが無いこともある */
  ocrPath?: string | null;
};

/** リプレイの行にだけ付く（docs/paper-events.md「リプレイ」） */
export type ReplayInfo = { recordingId: string; sessionId: string; videoMs: number };

/** replay はリプレイのファイルの行にだけある（通常の行では undefined） */
type Base = { id: string; ts: Date; raw: Record<string, unknown>; line: number; replay?: ReplayInfo };

export type OrderEvent = Base & {
  type: 'order';
  positionId: string;
  intent: 'open' | 'add' | 'close';
  symbol: string;
  side: 'buy' | 'sell';
  qty: string;
  orderType: 'market' | 'limit';
  limitPrice: string | null;
  shot: Shot | null;
};
export type FillMarkEvent = Base & { type: 'fill_mark'; orderId: string };
export type CancelEvent = Base & { type: 'cancel'; orderId: string };
export type MemoEvent = Base & { type: 'memo'; positionId: string; orderId: string | null; text: string };
export type PaperEvent = OrderEvent | FillMarkEvent | CancelEvent | MemoEvent;

export type EventError = { line: number; id: string | null; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ミリ秒付き・JST オフセット付き（契約どおり）
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+09:00$/;
const QTY = /^[1-9]\d*$/;
const PRICE = /^(0|[1-9]\d*)(\.\d+)?$/;
// 東証コード: 4 文字（数字始まり、2 文字目以降は数字か英大文字。例 7203 / 285A / 130A）
const SYMBOL = /^[0-9][0-9A-Z]{3}$/;
// 録画の rec_id: 録画開始の JST YYYYMMDD-HHMMSS（同じ秒に 2 本目があれば -2 等）
const RECORDING_ID = /^\d{8}-\d{6}(-\d+)?$/;
const REPLAY_KEYS = ['recording_id', 'session_id', 'video_ms'];

const KEYS: Record<PaperEvent['type'], { required: string[]; optional: string[] }> = {
  order: {
    required: ['v', 'id', 'type', 'ts', 'position_id', 'intent', 'symbol', 'side', 'qty', 'order_type', 'limit_price', 'shot'],
    optional: [],
  },
  fill_mark: { required: ['v', 'id', 'type', 'ts', 'order_id'], optional: [] },
  cancel: { required: ['v', 'id', 'type', 'ts', 'order_id'], optional: [] },
  memo: { required: ['v', 'id', 'type', 'ts', 'position_id', 'text'], optional: ['order_id'] },
};
const SHOT_KEYS = ['path', 'price_text', 'price', 'symbol_text', 'confidence'];
const SHOT_OPTIONAL_KEYS = ['captured_at', 'window_title', 'ocr_path'];

class ContractError extends Error {}
const fail = (m: string): never => {
  throw new ContractError(m);
};

function str(o: Record<string, unknown>, k: string, re?: RegExp): string {
  const v = o[k];
  if (typeof v !== 'string') fail(`${k} が文字列でない`);
  if (re && !re.test(v as string)) fail(`${k} の形式が不正: ${JSON.stringify(v)}`);
  return v as string;
}
function strOrNull(o: Record<string, unknown>, k: string, re?: RegExp): string | null {
  return o[k] === null ? null : str(o, k, re);
}
function oneOf<T extends string>(o: Record<string, unknown>, k: string, vals: readonly T[]): T {
  const v = o[k];
  if (!vals.includes(v as T)) fail(`${k} は ${vals.join('/')} のいずれか: ${JSON.stringify(v)}`);
  return v as T;
}
function exactKeys(o: Record<string, unknown>, required: string[], optional: string[], where: string) {
  for (const k of required) if (!(k in o)) fail(`${where}${k} が無い`);
  const allowed = new Set([...required, ...optional]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) fail(`${where}契約に無いキー: ${k}`);
}

function parseShot(v: unknown): Shot | null {
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) fail('shot がオブジェクトでも null でもない');
  const o = v as Record<string, unknown>;
  exactKeys(o, SHOT_KEYS, SHOT_OPTIONAL_KEYS, 'shot.');
  const conf = o.confidence;
  if (conf !== null && (typeof conf !== 'number' || !(conf >= 0 && conf <= 1))) {
    fail(`shot.confidence は 0〜1 の数値か null: ${JSON.stringify(conf)}`);
  }
  const path = relPath(str(o, 'path'), 'shot.path');
  const shot: Shot = {
    path,
    priceText: strOrNull(o, 'price_text'),
    price: strOrNull(o, 'price', PRICE),
    symbolText: strOrNull(o, 'symbol_text'),
    confidence: conf as number | null,
  };
  // 任意フィールドはキーがあるときだけ載せる（無い行の結果は従来と同じ形のまま）
  if ('captured_at' in o) {
    const c = strOrNull(o, 'captured_at', TS);
    shot.capturedAt = c === null ? null : new Date(c);
    if (shot.capturedAt && Number.isNaN(shot.capturedAt.getTime())) fail('shot.captured_at が日時として不正');
  }
  if ('window_title' in o) shot.windowTitle = strOrNull(o, 'window_title');
  if ('ocr_path' in o) {
    const p = strOrNull(o, 'ocr_path');
    shot.ocrPath = p === null ? null : relPath(p, 'shot.ocr_path');
  }
  return shot;
}

/** data/paper/ からの相対パスか（絶対パス・親ディレクトリへの参照を弾く） */
function relPath(p: string, key: string): string {
  if (p === '' || p.startsWith('/') || p.split('/').includes('..')) fail(`${key} は data/paper/ からの相対パス: ${JSON.stringify(p)}`);
  return p;
}

function parseReplay(v: unknown): ReplayInfo {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail('replay がオブジェクトでない');
  const o = v as Record<string, unknown>;
  exactKeys(o, REPLAY_KEYS, [], 'replay.');
  const ms = o.video_ms;
  if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 0) fail(`replay.video_ms は 0 以上の整数: ${JSON.stringify(ms)}`);
  return { recordingId: str(o, 'recording_id', RECORDING_ID), sessionId: str(o, 'session_id', UUID), videoMs: ms as number };
}

export type ParseOptions = {
  /** リプレイのファイル（replay/events.jsonl）の行として読む。全行に replay が必須になる */
  replay?: boolean;
};

/** 1 行を契約どおりにパースする。違反は例外（ContractError）ではなく結果で返す */
export function parseEventLine(
  text: string,
  line: number,
  opts: ParseOptions = {},
): { ok: true; event: PaperEvent } | { ok: false; error: EventError } {
  let id: string | null = null;
  try {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      fail('JSON として読めない');
    }
    if (typeof json !== 'object' || json === null || Array.isArray(json)) fail('JSON オブジェクトでない');
    const o = json as Record<string, unknown>;
    if (typeof o.id === 'string') id = o.id;
    if (o.v !== 1) fail(`未対応の契約バージョン v=${JSON.stringify(o.v)}`);
    const type = o.type as PaperEvent['type'];
    if (!(type in KEYS)) fail(`未知の type: ${JSON.stringify(o.type)}`);
    // 通常とリプレイの取り違え（別のファイルに書いた）は、契約に無いキーより分かりやすい理由で弾く
    if (opts.replay && !('replay' in o)) fail('リプレイの行に replay が無い');
    if (!opts.replay && 'replay' in o) fail('通常の events.jsonl に replay がある（リプレイの行は replay/events.jsonl に書く）');
    const replayKeys = opts.replay ? ['replay'] : [];
    exactKeys(o, [...KEYS[type].required, ...replayKeys], KEYS[type].optional, '');
    const base: Base = { id: str(o, 'id', UUID), ts: new Date(str(o, 'ts', TS)), raw: o, line };
    if (Number.isNaN(base.ts.getTime())) fail('ts が日時として不正');
    if (opts.replay) base.replay = parseReplay(o.replay);

    switch (type) {
      case 'order': {
        const orderType = oneOf(o, 'order_type', ['market', 'limit'] as const);
        const limitPrice = strOrNull(o, 'limit_price', PRICE);
        if (orderType === 'limit' && limitPrice === null) fail('指値なのに limit_price が null');
        if (orderType === 'market' && limitPrice !== null) fail('成行なのに limit_price がある');
        if (limitPrice !== null && Number(limitPrice) <= 0) fail('limit_price が 0 以下');
        return {
          ok: true,
          event: {
            ...base,
            type,
            positionId: str(o, 'position_id', UUID),
            intent: oneOf(o, 'intent', ['open', 'add', 'close'] as const),
            symbol: str(o, 'symbol', SYMBOL),
            side: oneOf(o, 'side', ['buy', 'sell'] as const),
            qty: str(o, 'qty', QTY),
            orderType,
            limitPrice,
            shot: parseShot(o.shot),
          },
        };
      }
      case 'fill_mark':
      case 'cancel':
        return { ok: true, event: { ...base, type, orderId: str(o, 'order_id', UUID) } };
      case 'memo':
        return {
          ok: true,
          event: {
            ...base,
            type,
            positionId: str(o, 'position_id', UUID),
            orderId: 'order_id' in o ? strOrNull(o, 'order_id', UUID) : null,
            text: str(o, 'text'),
          },
        };
    }
  } catch (e) {
    if (e instanceof ContractError) return { ok: false, error: { line, id, message: e.message } };
    throw e;
  }
}

export type ParsedEvents = {
  orders: OrderEvent[];
  fillMarks: Map<string, FillMarkEvent>; // order id → 最初の fill_mark
  cancels: Map<string, CancelEvent>; // order id → 最初の cancel
  memos: MemoEvent[];
  /** 検証を通ったすべてのイベント（冪等取り込みの id 一覧に使う） */
  accepted: PaperEvent[];
  errors: EventError[];
};

/**
 * ファイル全体をパースし、行どうしの整合（重複 id・参照先・建玉の流れ）も検証する。
 * 後の行が前の行と矛盾するときは後の行をエラーにする（追記専用なので先に書かれた方を正とする）。
 */
export function parseEventsText(text: string, opts: ParseOptions = {}): ParsedEvents {
  const out: ParsedEvents = { orders: [], fillMarks: new Map(), cancels: new Map(), memos: [], accepted: [], errors: [] };
  const seen = new Map<string, string>(); // id → 行の内容
  const orders = new Map<string, OrderEvent>();
  // positionId → 建玉の方向と銘柄
  const positions = new Map<string, { side: 'buy' | 'sell'; symbol: string }>();

  const lines = text.split('\n');
  lines.forEach((raw, i) => {
    const line = i + 1;
    const t = raw.trim();
    if (t === '') return;
    const r = parseEventLine(t, line, opts);
    if (!r.ok) {
      out.errors.push(r.error);
      return;
    }
    const ev = r.event;
    const err = (message: string) => out.errors.push({ line, id: ev.id, message });

    const prev = seen.get(ev.id);
    if (prev !== undefined) {
      // 同じ内容の重複は冪等として黙って無視、内容が違えば契約違反
      if (prev !== t) err(`id が重複し内容が異なる（先の行を採用）`);
      return;
    }

    if (ev.type === 'order') {
      const pos = positions.get(ev.positionId);
      if (ev.intent === 'open') {
        if (pos) return err('open なのに position_id が既に使われている');
      } else {
        if (!pos) return err(`${ev.intent} なのに position_id の建玉が無い`);
        if (pos.symbol !== ev.symbol) return err(`建玉の銘柄 ${pos.symbol} と違う銘柄 ${ev.symbol}`);
        const sameSide = pos.side === ev.side;
        if (ev.intent === 'add' && !sameSide) return err('add の売買方向が建玉と逆');
        if (ev.intent === 'close' && sameSide) return err('close の売買方向が建玉と同じ');
      }
      // 数量は見ない: 指値は約定しない（取消・失効）こともあるので、発注の数量で建玉を追うと
      // 正しい再発注まで弾いてしまう。数量の整合は約定ベースで builder が見る。
      if (ev.intent === 'open') positions.set(ev.positionId, { side: ev.side, symbol: ev.symbol });
      orders.set(ev.id, ev);
      out.orders.push(ev);
    } else if (ev.type === 'fill_mark' || ev.type === 'cancel') {
      const o = orders.get(ev.orderId);
      if (!o) return err(`order_id ${ev.orderId} の order が無い（または先に書かれていない）`);
      if (o.orderType !== 'limit') return err(`${ev.type} は指値にだけ使える`);
      if (ev.ts < o.ts) return err(`${ev.type} の時刻が発注より前`);
      if (out.fillMarks.has(ev.orderId)) return err('既に fill_mark 済みの注文');
      if (out.cancels.has(ev.orderId)) return err('既に取消済みの注文');
      if (ev.type === 'fill_mark') out.fillMarks.set(ev.orderId, ev);
      else out.cancels.set(ev.orderId, ev);
    } else {
      if (!positions.has(ev.positionId)) return err('memo の position_id の建玉が無い');
      if (ev.orderId !== null) {
        const o = orders.get(ev.orderId);
        if (!o) return err(`memo の order_id ${ev.orderId} の order が無い`);
        if (o.positionId !== ev.positionId) return err('memo の order_id が別の建玉の注文');
      }
      out.memos.push(ev);
    }
    seen.set(ev.id, t);
    out.accepted.push(ev);
  });
  return out;
}

export type DerivedState = 'MARKET' | 'PENDING' | 'FILL_MARKED' | 'CANCELLED' | 'EXPIRED';

/**
 * 注文の状態（足を見ない）。指値は当日限り: 発注日の大引け（15:30 JST）を過ぎても fill_mark も cancel も無ければ EXPIRED。
 * 即約定かどうかは足で検証した現在値でしか決められないので、ここでは見ない（resolve が判定し、
 * 即約定した指値は resolvePaperExecutions が MARKET に直す）。
 */
export function deriveOrderState(
  o: OrderEvent,
  fillMark: FillMarkEvent | undefined,
  cancel: CancelEvent | undefined,
  now: Date,
): DerivedState {
  if (o.orderType === 'market') return 'MARKET';
  if (fillMark) return 'FILL_MARKED';
  if (cancel) return 'CANCELLED';
  return now.getTime() >= closeOf(jstYmd(o.ts)).getTime() ? 'EXPIRED' : 'PENDING';
}

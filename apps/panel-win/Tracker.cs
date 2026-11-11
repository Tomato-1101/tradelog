namespace TradelogPanel;

sealed record TrackEvent(string Event, string Side, int Row, DateTimeOffset Ts, int? PendingMs, string OrderKey);

// 売注・買注のマスの状態の移り変わりから注文のイベントを作る（契約は docs/real-events.md）。画像には触らない。
// マスは「板の仮想の行番号」で覚える。スクロールで行がずれたら Shift で番号を付け替え、画面外のマスは触らない。
// 1 フレームだけの見間違いでイベントを出さないよう、同じ状態を Confirm フレーム続けて見たら確定する（時刻は最初のフレーム）
sealed class Tracker
{
    sealed class Order { public string Key = Guid.NewGuid().ToString(); public bool Shown, CancelReq; public DateTimeOffset PendingStart; }
    sealed class Slot
    {
        public CellState Stable, Cand, LastObs;
        public DateTimeOffset CandTs;
        public int CandN;
        public DateTimeOffset? PendingSeen;
        public Order? Ord;
    }

    const int Confirm = 2;
    readonly Dictionary<(bool Buy, int VRow), Slot> slots = [];
    int offset;
    public bool HasBaseline { get; private set; }

    // 監視の開始・銘柄の切り替え・ずれが測れない時: 今見えている状態を黙って覚え直す（既にある注文をイベントにしない）
    public void Baseline(CellState[] sell, CellState[] buy)
    {
        slots.Clear();
        offset = 0;
        for (int k = 0; k < sell.Length; k++)
        {
            Init(false, k, sell[k]);
            Init(true, k, buy[k]);
        }
        HasBaseline = true;
    }

    void Init(bool buy, int k, CellState s)
    {
        if (s == CellState.Empty) return;
        slots[(buy, k)] = new Slot { Stable = s, LastObs = s, Ord = s == CellState.Shown ? new Order { Shown = true } : null };
    }

    public void Reset() { slots.Clear(); offset = 0; HasBaseline = false; }

    // 今のフレームの k 行目 = 前のフレームの k + n 行目
    public void ApplyShift(int n) => offset += n;

    public List<TrackEvent> Step(DateTimeOffset ts, CellState[] sell, CellState[] buy)
    {
        var evs = new List<TrackEvent>();
        for (int k = 0; k < sell.Length; k++)
        {
            Observe(false, k, sell[k], ts, evs);
            Observe(true, k, buy[k], ts, evs);
        }
        // 空で注文も無いマスは覚えておく必要が無い（画面外のマスは状態が残る）
        foreach (var key in slots.Where(p => p.Value.Stable == CellState.Empty && p.Value.Ord == null && p.Value.CandN == 0 && p.Value.LastObs == CellState.Empty).Select(p => p.Key).ToList())
            slots.Remove(key);
        return evs;
    }

    void Observe(bool buy, int k, CellState s, DateTimeOffset ts, List<TrackEvent> evs)
    {
        var key = (buy, k + offset);
        if (!slots.TryGetValue(key, out var sl))
        {
            if (s == CellState.Empty) return;
            slots[key] = sl = new Slot();
        }
        if (s == CellState.Pending && sl.LastObs != CellState.Pending) sl.PendingSeen = ts;
        sl.LastObs = s;
        if (s == sl.Stable) { sl.CandN = 0; return; }
        if (sl.CandN == 0 || s != sl.Cand) { sl.Cand = s; sl.CandTs = ts; sl.CandN = 0; }
        if (++sl.CandN < Confirm) return;
        Transition(sl, s, sl.CandTs, buy ? "BUY" : "SELL", k, evs);
        sl.Stable = s;
        sl.CandN = 0;
    }

    static int Ms(DateTimeOffset a, DateTimeOffset b) => (int)Math.Round((b - a).TotalMilliseconds);

    static void Transition(Slot sl, CellState s, DateTimeOffset t, string side, int row, List<TrackEvent> evs)
    {
        void Emit(string ev, DateTimeOffset at, int? pms, Order o) => evs.Add(new TrackEvent(ev, side, row, at, pms, o.Key));
        var o = sl.Ord;
        if (o == null)
        {
            if (s == CellState.Pending) sl.Ord = new Order { PendingStart = t };
            else if (s == CellState.Shown)
            {
                sl.Ord = o = new Order { Shown = true };
                // 白い背景を 1 フレームしか見なかった発注
                if (sl.PendingSeen is { } ps && ps < t && (t - ps).TotalSeconds < 1) Emit("placed", ps, Ms(ps, t), o);
                else Emit("appeared", t, null, o);
            }
            return;
        }
        if (!o.Shown)
        {
            if (s == CellState.Shown) { o.Shown = true; Emit("placed", o.PendingStart, Ms(o.PendingStart, t), o); }
            else if (s == CellState.Empty) { Emit("vanished", t, null, o); sl.Ord = null; }
            return;
        }
        if (!o.CancelReq)
        {
            if (s == CellState.Pending) { o.CancelReq = true; o.PendingStart = t; Emit("cancel_requested", t, null, o); }
            else if (s == CellState.Empty) { Emit("filled", t, null, o); sl.Ord = null; }
            return;
        }
        if (s == CellState.Shown) { o.CancelReq = false; Emit("reverted", t, null, o); }
        else if (s == CellState.Empty) { Emit("cancelled", t, Ms(o.PendingStart, t), o); sl.Ord = null; }
    }
}

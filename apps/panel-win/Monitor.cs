using System.Collections.Concurrent;
using System.Diagnostics;
using System.Drawing.Imaging;
using System.Text.Json.Nodes;

namespace TradelogPanel;

sealed record LastOrder(string OrderKey, string Event, string Side, decimal? Price, DateTimeOffset Ts);

// 裏のスレッドで HYPER SBI 2 の「全板」窓を見張り、注文のマスが変わったら events.jsonl に 1 行足す。
// 撮影と判定は 1 フレーム約 20ms（PrintWindow なので他の窓に隠れていても撮れる）。数字の OCR は別スレッドで行い、見張りを止めない。
// 窓の操作・クリック・フォーカスの移動は一切しない（撮るだけ）
sealed class BoardMonitor
{
    sealed record Job(Bitmap Img, Layout Lay, List<TrackEvent> Events, string Title);

    readonly Action<string> onStatus, onEvent;
    readonly BlockingCollection<Job> jobs = [];
    readonly Dictionary<string, (decimal? Price, decimal? Qty)> known = [];
    volatile bool stop;
    Thread? scan, ocr;
    string lastStatus = "";
    public volatile LastOrder? Last;
    // いま見張っている全板の銘柄コード。理由のメモに載せ、Mac で同じ銘柄の約定にだけ結び付ける（全板が無ければ null）
    public volatile string? Symbol;

    public BoardMonitor(Action<string> onStatus, Action<string> onEvent)
    {
        this.onStatus = onStatus;
        this.onEvent = onEvent;
    }

    public void Start()
    {
        scan = new Thread(ScanLoop) { IsBackground = true, Name = "board-scan" };
        ocr = new Thread(OcrLoop) { IsBackground = true, Name = "board-ocr" };
        ocr.Start();
        scan.Start();
    }

    // 終了時: 見張りを止め、読みかけの OCR を書き終えるまで少し待つ
    public void Stop()
    {
        stop = true;
        scan?.Join(2000);
        jobs.CompleteAdding();
        ocr?.Join(5000);
    }

    void Status(string s)
    {
        if (s == lastStatus) return;
        lastStatus = s;
        Log.Write("状態: " + s);
        onStatus(s);
    }

    // 平日の 7:55〜15:40 は 1 秒に約 30 回、それ以外は 1 秒に 1 回（場の外で PC を食わない）
    static bool Fast(DateTime now) =>
        now.DayOfWeek is not (DayOfWeek.Saturday or DayOfWeek.Sunday) && now.TimeOfDay >= new TimeSpan(7, 55, 0) && now.TimeOfDay < new TimeSpan(15, 40, 0);

    static IntPtr FindBoard()
    {
        var pids = Process.GetProcessesByName("HYPERSBI2").Select(p => { using (p) return (uint)p.Id; }).ToHashSet();
        if (pids.Count == 0) return IntPtr.Zero;
        IntPtr found = IntPtr.Zero, iconic = IntPtr.Zero;
        Native.EnumWindows((h, _) =>
        {
            Native.GetWindowThreadProcessId(h, out var pid);
            if (!pids.Contains(pid) || !Native.IsWindowVisible(h) || !Native.TitleOf(h).StartsWith("全板")) return true;
            if (Native.IsIconic(h)) { iconic = h; return true; }
            found = h;
            return false;
        }, IntPtr.Zero);
        return found != IntPtr.Zero ? found : iconic;
    }

    void ScanLoop()
    {
        while (!stop)
        {
            var h = FindBoard();
            if (h == IntPtr.Zero)
            {
                Status("全板の窓が見つからない（HYPER SBI 2 で全板を開くと監視を始める）");
                Thread.Sleep(2000);
                continue;
            }
            try { Watch(h); }
            catch (Exception e)
            {
                Log.Write("監視の例外: " + e);
                Status("監視でエラー（logs\\panel.log）。2 秒後にやり直す");
                Thread.Sleep(2000);
            }
        }
    }

    void Watch(IntPtr h)
    {
        Layout? lay = null;
        Bitmap? img = null;
        int w = 0, hh = 0;
        var px = new Board.Pixels();
        CellState[] sell = [], buy = [];
        ulong[] sig = [], prev = [];
        var tracker = new Tracker();
        string title = Native.TitleOf(h);
        Symbol = Board.ParseTitle(title).Code;
        var sw = Stopwatch.StartNew();
        long frames = 0, statFrames = 0;
        double lastT = 0, statT = 0;
        var cpu0 = Process.GetCurrentProcess().TotalProcessorTime;
        try
        {
            while (!stop)
            {
                double t0 = sw.Elapsed.TotalMilliseconds;
                bool fast = Fast(DateTime.Now);
                if (!Native.IsWindow(h)) { Log.Write("全板の窓が閉じた"); return; }
                if (frames % 16 == 0)
                {
                    var t = Native.TitleOf(h);
                    if (!t.StartsWith("全板")) { Log.Write("全板ではなくなった: " + t); return; }
                    if (t != title) { Log.Write($"銘柄が変わった {title} → {t}。追跡をやり直す"); title = t; Symbol = Board.ParseTitle(t).Code; tracker.Reset(); }
                }
                if (Native.IsIconic(h))
                {
                    Status("全板が最小化されている（戻すと監視を再開）");
                    tracker.Reset();
                    Thread.Sleep(1000);
                    continue;
                }
                Native.GetWindowRect(h, out var r);
                int nw = r.Right - r.Left, nh = r.Bottom - r.Top;
                if (nw <= 0 || nh <= 0) { Thread.Sleep(1000); continue; }
                if (lay == null || nw != w || nh != hh)
                {
                    w = nw; hh = nh;
                    img?.Dispose();
                    img = new Bitmap(w, hh, PixelFormat.Format24bppRgb);
                    Board.Grab(h, img);
                    var (l, note) = Board.FindLayout(img).GetAwaiter().GetResult();
                    if (l == null)
                    {
                        lay = null;
                        Status($"全板の列が読めない（{note}）。3 秒後にやり直す");
                        Thread.Sleep(3000);
                        continue;
                    }
                    lay = l;
                    Log.Write($"列を取り直した {w}x{hh} {note}");
                    int n = lay.Rows.Count;
                    sell = new CellState[n]; buy = new CellState[n]; sig = new ulong[n]; prev = new ulong[n];
                    tracker.Reset();
                }
                var ts = DateTimeOffset.Now;
                Board.Grab(h, img!);
                px.Load(img!, lay.ScanRect(w, hh));
                Board.PriceSig(px, lay, sig);
                if (!Board.AllBlank(sig)) // 描画が抜けたフレームは飛ばす
                {
                    Board.Scan(px, lay, sell, buy);
                    if (!tracker.HasBaseline)
                    {
                        tracker.Baseline(sell, buy);
                        var (code, name) = Board.ParseTitle(title);
                        Status($"監視中 {name ?? ""}{(code != null ? $"({code})" : "")}");
                    }
                    else if (Board.Shift(prev, sig) is not { } shift)
                    {
                        Log.Write("板のずれが測れないので追跡をやり直す");
                        tracker.Baseline(sell, buy);
                    }
                    else
                    {
                        tracker.ApplyShift(shift);
                        var evs = tracker.Step(ts, sell, buy);
                        if (evs.Count > 0) jobs.Add(new Job(img!.Clone(new Rectangle(0, 0, w, hh), PixelFormat.Format24bppRgb), lay, evs, title));
                    }
                    (prev, sig) = (sig, prev);
                }
                frames++; statFrames++;
                if (fast && lastT > 0 && t0 - lastT > 300) Log.Write($"SLOW 前のフレームから {t0 - lastT:F0}ms");
                lastT = t0;
                if (t0 - statT > 600_000)
                {
                    using var me = Process.GetCurrentProcess();
                    var cpu = me.TotalProcessorTime;
                    if (statT > 0) Log.Write($"stat {statFrames / ((t0 - statT) / 1000):F1}fps cpu {(cpu - cpu0).TotalMilliseconds / (t0 - statT) * 100:F1}%（1 コア=100%）");
                    cpu0 = cpu; statT = t0; statFrames = 0;
                }
                int wait = (fast ? 25 : 1000) - (int)(sw.Elapsed.TotalMilliseconds - t0);
                if (wait > 0) Thread.Sleep(wait);
            }
        }
        finally { img?.Dispose(); Symbol = null; }
    }

    static readonly Dictionary<string, string> Words = new()
    {
        ["placed"] = "注文", ["appeared"] = "注文", ["cancel_requested"] = "取消中", ["cancelled"] = "取消",
        ["reverted"] = "取消やめ", ["filled"] = "約定", ["vanished"] = "消えた",
    };

    static JsonNode? N(decimal? v) => v is { } d ? JsonValue.Create(d) : null;

    void OcrLoop()
    {
        foreach (var job in jobs.GetConsumingEnumerable())
        {
            try
            {
                BoardRow[] rows;
                try { rows = Board.Read(job.Img, job.Lay).GetAwaiter().GetResult(); }
                catch (Exception e) { Log.Write("板の OCR に失敗: " + e.Message); rows = []; }
                var (code, name) = Board.ParseTitle(job.Title);
                foreach (var ev in job.Events)
                {
                    var row = ev.Row < rows.Length ? rows[ev.Row] : null;
                    decimal? price = row?.Price, qty = ev.Side == "BUY" ? row?.MyBuy : row?.MySell;
                    // 白い背景の間・消えた後は株数が読めないので、同じ注文で前に読めた値を使う
                    if (known.TryGetValue(ev.OrderKey, out var k)) { price ??= k.Price; qty ??= k.Qty; }
                    if (ev.Event is "filled" or "cancelled" or "vanished") known.Remove(ev.OrderKey);
                    else known[ev.OrderKey] = (price, qty);
                    var board = new JsonArray(rows.Select(b =>
                    {
                        var o = new JsonObject { ["price"] = N(b.Price) };
                        if (b.Label != null) o["label"] = b.Label;
                        o["sell"] = N(b.Sell); o["buy"] = N(b.Buy); o["sell_count"] = N(b.SellCount); o["buy_count"] = N(b.BuyCount);
                        o["my_sell"] = N(b.MySell); o["my_buy"] = N(b.MyBuy);
                        return (JsonNode?)o;
                    }).ToArray());
                    Jsonl.Write(new JsonObject
                    {
                        ["v"] = 2, ["type"] = "board_order", ["id"] = Guid.NewGuid().ToString(), ["ts"] = Jsonl.Ts(ev.Ts),
                        ["order_key"] = ev.OrderKey, ["event"] = ev.Event, ["side"] = ev.Side, ["price"] = N(price), ["qty"] = N(qty),
                        ["pending_ms"] = ev.PendingMs, ["symbol"] = code, ["symbol_name"] = name, ["board"] = board,
                    });
                    Last = new LastOrder(ev.OrderKey, ev.Event, ev.Side, price, ev.Ts);
                    var text = $"{ev.Ts:HH:mm:ss} {(ev.Side == "BUY" ? "買" : "売")} {price?.ToString("0.#") ?? "?"} ×{qty?.ToString("0") ?? "?"} {Words[ev.Event]}";
                    Log.Write($"イベント {ev.Event} {ev.Side} row={ev.Row} price={price} qty={qty} pending_ms={ev.PendingMs} key={ev.OrderKey} 板{rows.Length}行");
                    onEvent(text);
                }
            }
            catch (Exception e) { Log.Write("イベントの書き込みに失敗: " + e); }
            finally { job.Img.Dispose(); }
        }
    }
}

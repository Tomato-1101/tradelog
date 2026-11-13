using System.Text;

namespace TradelogPanel;

// TradelogPanel.exe --selftest [全板の画像.png]
// 追跡（マスの移り変わり → イベント）、行のずれ、数字・タイトルの読み方、画像があれば列の検出と OCR を確かめる
static class SelfTest
{
    static readonly StringBuilder Out = new();
    static int fails;

    static void Check(string name, bool ok, string detail = "")
    {
        Out.AppendLine($"{(ok ? "OK  " : "FAIL")} {name}{(detail.Length > 0 ? "  " + detail : "")}");
        if (!ok) fails++;
    }

    public static int Run(string[] args)
    {
        try
        {
            TrackerCases();
            ShiftCases();
            ParseCases();
            if (args.Length > 0) ImageCase(args[0]);
        }
        catch (Exception e) { Check("例外なし", false, e.ToString()); }
        Out.AppendLine(fails == 0 ? "ALL OK" : $"{fails} 件失敗");
        Directory.CreateDirectory(Paths.Logs);
        File.WriteAllText(Path.Combine(Paths.Logs, "selftest.txt"), Out.ToString(), new UTF8Encoding(false));
        return fails == 0 ? 0 : 1;
    }

    const CellState E = CellState.Empty, P = CellState.Pending, S = CellState.Shown;
    static readonly DateTimeOffset T0 = new(2026, 11, 11, 10, 0, 0, TimeSpan.FromHours(9));
    static DateTimeOffset F(int i) => T0.AddMilliseconds(i * 33);

    // 1 マス（買注の 5 行目）の状態を 1 フレームずつ流す。最初の状態は監視開始時に見えていたもの（イベントにしない）
    static List<TrackEvent> One(params CellState[] seq)
    {
        var tr = new Tracker();
        var evs = new List<TrackEvent>();
        CellState[] Row(CellState s) { var a = new CellState[10]; a[5] = s; return a; }
        tr.Baseline(new CellState[10], Row(seq[0]));
        for (int i = 1; i < seq.Length; i++) evs.AddRange(tr.Step(F(i), new CellState[10], Row(seq[i])));
        return evs;
    }

    static string Show(List<TrackEvent> evs) => string.Join(", ", evs.Select(e => $"{e.Event}@{(e.Ts - T0).TotalMilliseconds:F0}{(e.PendingMs is { } p ? $"/{p}" : "")}"));

    static void Expect(string name, List<TrackEvent> evs, string want) => Check(name, Show(evs) == want, $"got [{Show(evs)}] want [{want}]");

    static void TrackerCases()
    {
        Expect("発注（白→数字）", One(E, P, P, P, S, S, S), "placed@33/99");
        Expect("発注（白を 1 フレームだけ見た）", One(E, P, S, S), "placed@33/33");
        Expect("いきなり数字", One(E, S, S), "appeared@33");
        Expect("約定（数字→空）", One(S, S, E, E), "filled@66");
        Expect("取消（数字→白→空）", One(S, P, P, P, E, E), "cancel_requested@33, cancelled@132/99");
        Expect("取消やめ（数字→白→数字）", One(S, P, P, S, S), "cancel_requested@33, reverted@99");
        Expect("通らなかった発注（白→空）", One(E, P, P, E, E), "vanished@99");
        Expect("1 フレームの見間違いは無視", One(S, E, S, S, P, S, S), "");
        Expect("監視開始時に見えていた注文は出さない", One(S, S, S), "");
        Check("イベントの行と向き", One(E, S, S) is [{ Row: 5, Side: "BUY" }]);
        var key = One(S, P, P, E, E);
        Check("取消の 2 行は同じ注文", key.Count == 2 && key[0].OrderKey == key[1].OrderKey);

        // スクロール: 5 行目の注文が 3 行目に来ても同じ注文のまま。そこで消えたら約定
        var tr = new Tracker();
        CellState[] At(int k) { var a = new CellState[10]; if (k >= 0) a[k] = S; return a; }
        tr.Baseline(new CellState[10], At(5));
        tr.ApplyShift(2);
        var a1 = tr.Step(F(1), new CellState[10], At(3));
        var a2 = tr.Step(F(2), new CellState[10], At(-1));
        var a3 = tr.Step(F(3), new CellState[10], At(-1));
        Check("スクロールしても同じ注文", a1.Count == 0 && a2.Count == 0 && a3 is [{ Event: "filled", Row: 3 }], Show([.. a1, .. a2, .. a3]));

        // 画面外に出た注文はイベントを出さず、戻ってきたら続きから
        tr = new Tracker();
        tr.Baseline(new CellState[10], At(1));
        tr.ApplyShift(4); // 1 行目は画面の上へ外れる
        var b1 = tr.Step(F(1), new CellState[10], At(-1));
        var b2 = tr.Step(F(2), new CellState[10], At(-1));
        tr.ApplyShift(-4);
        var b3 = tr.Step(F(3), new CellState[10], At(1));
        var b4 = tr.Step(F(4), new CellState[10], At(1));
        Check("画面外の注文は触らない", b1.Count + b2.Count + b3.Count + b4.Count == 0, Show([.. b1, .. b2, .. b3, .. b4]));
        // UNDER 行（8 行目、動かない）に自分の注文が出たまま板が 1 行ずつスクロールしても、約定・出現にしない（2026-11-12 285A）
        tr = new Tracker { Band = (1, 7) };
        tr.Baseline(new CellState[10], At(8));
        var c = new List<TrackEvent>();
        for (int i = 1; i <= 6; i++) { tr.ApplyShift(i % 2 == 0 ? 3 : -3); c.AddRange(tr.Step(F(i), new CellState[10], At(8))); }
        // 範囲内の注文が範囲外（UNDER の位置）へ流れても約定にしない
        tr = new Tracker { Band = (1, 7) };
        tr.Baseline(new CellState[10], At(7));
        tr.ApplyShift(-2);
        c.AddRange(tr.Step(F(7), new CellState[10], At(-1)));
        c.AddRange(tr.Step(F(8), new CellState[10], At(-1)));
        Check("OVER/UNDER 行の注文は追わない", c.Count == 0, Show(c));
    }

    static void ShiftCases()
    {
        var prev = Enumerable.Range(1, 74).Select(i => (ulong)i * 7919).ToArray();
        Check("ずれ 0", Board.Shift(prev, prev) == 0);
        var down = prev.Skip(3).Concat(Enumerable.Repeat(0UL, 3)).ToArray(); // cur[k] = prev[k+3]
        Check("ずれ +3", Board.Shift(prev, down) == 3, $"{Board.Shift(prev, down)}");
        var up = Enumerable.Repeat(999UL, 5).Concat(prev.Take(69)).ToArray(); // cur[k] = prev[k-5]
        Check("ずれ -5", Board.Shift(prev, up) == -5, $"{Board.Shift(prev, up)}");
        var other = Enumerable.Range(1, 74).Select(i => (ulong)i * 104729 + 1).ToArray();
        Check("別の板は測れない", Board.Shift(prev, other) == null, $"{Board.Shift(prev, other)}");
        var tick = (ulong[])prev.Clone(); tick[30] = 5; tick[31] = 6; // 現在値の行の色が変わった程度
        Check("2 行だけ変わってもずれ 0", Board.Shift(prev, tick) == 0);
    }

    static void ParseCases()
    {
        Check("数字 1,394", Board.Number("1,394") == 1394m);
        Check("数字 1ooo", Board.Number("1ooo") == 1000m);
        Check("数字 1376.5", Board.Number("1376.5") == 1376.5m);
        Check("数字 abc", Board.Number("abc") == null);
        Check("数字 空", Board.Number("") == null);
        var t = Board.ParseTitle("全板　ソフトバンクグループ(9984)");
        Check("タイトル", t == ("9984", "ソフトバンクグループ"), $"{t}");
        var t2 = Board.ParseTitle("全板");
        Check("タイトル（銘柄なし）", t2 == (null, null), $"{t2}");
    }

    static void ImageCase(string path)
    {
        using var img = new Bitmap(path);
        using var bmp = img.Clone(new Rectangle(0, 0, img.Width, img.Height), System.Drawing.Imaging.PixelFormat.Format24bppRgb);
        var (lay, note) = Board.FindLayout(bmp).GetAwaiter().GetResult();
        Check("列の検出", lay != null && lay.Rows.Count >= 10, note);
        if (lay == null) return;
        Out.AppendLine("  列: " + string.Join(" ", lay.Cols.Select(c => $"{c.Name}{c.L}-{c.R}")));
        var px = new Board.Pixels();
        px.Load(bmp, lay.ScanRect(bmp.Width, bmp.Height));
        var sell = new CellState[lay.Rows.Count];
        var buy = new CellState[lay.Rows.Count];
        Board.Scan(px, lay, sell, buy);
        var sig = new ulong[lay.Rows.Count];
        Board.PriceSig(px, lay, sig);
        Check("値段の列の模様", sig.Count(s => s != 0) >= lay.Rows.Count * 0.9, $"{sig.Count(s => s != 0)}/{lay.Rows.Count}");
        var rows = Board.Read(bmp, lay).GetAwaiter().GetResult();
        int priced = rows.Count(r => r.Price != null || r.Label != null);
        Check("値段の OCR", priced >= lay.Rows.Count * 0.8, $"{priced}/{lay.Rows.Count}");
        Check("追う行の範囲", lay.Lo > 0 && lay.Hi < lay.Rows.Count - 1 && lay.Hi - lay.Lo >= 10
            && rows[lay.Lo].Price != null && rows[lay.Hi].Price != null, $"{lay.Lo}-{lay.Hi} / {lay.Rows.Count}");
        for (int k = 0; k < rows.Length; k++)
        {
            var r = rows[k];
            if (sell[k] != CellState.Empty || buy[k] != CellState.Empty || k % 10 == 0)
                Out.AppendLine($"  {k,2} {r.Label ?? r.Price?.ToString() ?? "?",8} 売{r.Sell} 買{r.Buy} 売注{r.MySell}[{sell[k]}] 買注{r.MyBuy}[{buy[k]}]");
        }
    }
}

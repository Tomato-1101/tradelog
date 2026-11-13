using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;

namespace TradelogPanel;

enum CellState { Empty, Pending, Shown }

// 全板の窓の画像から、列・行の位置（Layout）、注文のマスの状態、値段の列の模様、板の数字（OCR）を取る。
// 色・しきい値は 2026-11-11 の実測（docs/real-events.md「全板の見え方」）に合わせている。
sealed record Layout(int Top, int Bottom, (int L, int R) Sell, (int L, int R) Buy, (int L, int R) Price,
                     List<(int T, int B)> Rows, List<(int L, int R, string Name)> Cols)
{
    // 注文を追う行の範囲（OVER と UNDER の間の値段の行）。OVER/UNDER は板の外の注文の合計を出す動かない行で、
    // スクロールで行番号を付け替えると注文が出入りして見え、消えた時に約定と取り違える（2026-11-12 285A で 17 件）
    public int Lo { get; init; }
    public int Hi { get; init; } = int.MaxValue;

    public Rectangle ScanRect(int w, int h)
    {
        int l = Math.Max(0, Sell.L - 10), r = Math.Min(w, Buy.R + 10);
        int t = Math.Max(0, Top - 10), b = Math.Min(h, Bottom + 10);
        return new Rectangle(l, t, r - l, b - t);
    }
}

sealed record BoardRow(decimal? Price, string? Label, decimal? Sell, decimal? Buy, decimal? SellCount, decimal? BuyCount, decimal? MySell, decimal? MyBuy);

static class Board
{
    static OcrEngine? ja, en;
    static OcrEngine Ja => ja ??= OcrEngine.TryCreateFromLanguage(new Windows.Globalization.Language("ja")) ?? throw new InvalidOperationException("日本語の OCR が使えない");
    static OcrEngine En => en ??= OcrEngine.TryCreateFromLanguage(new Windows.Globalization.Language("en-US")) ?? throw new InvalidOperationException("英語の OCR が使えない");

    public static void Grab(IntPtr h, Bitmap b)
    {
        using var g = Graphics.FromImage(b);
        var dc = g.GetHdc();
        try { Native.PrintWindow(h, dc, Native.PW_RENDERFULLCONTENT); }
        finally { g.ReleaseHdc(dc); }
    }

    // 画素の一部（rect）を毎回同じ配列にコピーする
    public sealed class Pixels
    {
        public byte[] Buf = [];
        public int Stride, OX, OY;
        public void Load(Bitmap b, Rectangle rc)
        {
            var d = b.LockBits(rc, ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
            try
            {
                int n = d.Stride * rc.Height;
                if (Buf.Length != n) Buf = new byte[n];
                Marshal.Copy(d.Scan0, Buf, 0, n);
                Stride = d.Stride; OX = rc.X; OY = rc.Y;
            }
            finally { b.UnlockBits(d); }
        }
        public int At(int x, int y) => (y - OY) * Stride + (x - OX) * 3;
    }

    static bool IsGray(int r, int g, int b, int lo, int hi) => Math.Abs(r - g) < 14 && Math.Abs(g - b) < 14 && r >= lo && r <= hi;
    static bool IsRed(int r, int g, int b) => r > 150 && r > g + 80 && r > b + 50;
    static bool IsBlue(int r, int g, int b) => b > 140 && b > r + 60 && b > g + 20;
    static bool IsWhite(int r, int g, int b) => r > 190 && g > 190 && b > 190;
    // 値段の列の文字（明るく、灰色でない）
    static bool IsPriceInk(int r, int g, int b) => Math.Max(r, Math.Max(g, b)) > 140 && !IsGray(r, g, b, 0, 199);

    // 見出しの「値段」と同じ高さの「注」を探す。左が売注、右が買注（「売」は「戸」等に誤読されるので頼らない）。
    // 列の左右は縦の罫線（灰色の縦線）、行は値段の列の文字の帯から決める
    public static async Task<(Layout? Layout, string Note)> FindLayout(Bitmap img)
    {
        int w = img.Width, h = img.Height;
        OcrResult res;
        using (var top = img.Clone(new Rectangle(0, 0, w, h / 2), PixelFormat.Format24bppRgb)) res = await Ocr(Ja, top);
        var words = res.Lines.SelectMany(l => l.Words).ToList();
        var dan = words.FirstOrDefault(x => x.Text.Contains('段'));
        if (dan == null) return (null, "値段の見出しが読めない");
        double danX = dan.BoundingRect.X, danY = dan.BoundingRect.Y;
        double sellX = -1, buyX = -1, hy = -1, hh = 0;
        foreach (var wd in words.Where(x => Math.Abs(x.BoundingRect.Y - danY) < 8))
        {
            int k = wd.Text.IndexOf('注');
            if (k < 0) continue;
            double cx = wd.BoundingRect.X + wd.BoundingRect.Width * (k + 0.5) / wd.Text.Length;
            if (cx < danX) sellX = cx; else buyX = cx;
            hy = wd.BoundingRect.Y; hh = wd.BoundingRect.Height;
        }
        if (sellX < 0 || buyX < 0) return (null, "売注・買注の見出しが読めない");
        int y0 = (int)(hy + hh * 2.5), y1 = h - 30;
        if (y1 - y0 < 100) return (null, "板が小さすぎる");
        var px = new Pixels();
        px.Load(img, new Rectangle(0, 0, w, h));

        var lines = new List<int>();
        for (int x = 0; x < w; x++)
        {
            int gray = 0, n = 0;
            for (int y = y0; y < y1; y += 3)
            {
                int i = px.At(x, y); n++;
                if (IsGray(px.Buf[i + 2], px.Buf[i + 1], px.Buf[i], 40, 130)) gray++;
            }
            if (gray > n * 0.6) lines.Add(x);
        }
        var vl = new List<int>();
        foreach (var x in lines) if (vl.Count == 0 || x - vl[^1] > 2) vl.Add(x);
        (int, int) Col(double cx)
        {
            int l = lines.Where(x => x < cx).DefaultIfEmpty(-1).Max();
            int r = lines.Where(x => x > cx).DefaultIfEmpty(-1).Min();
            return (l + 2, r - 2);
        }
        var sell = Col(sellX); var buy = Col(buyX);
        if (sell.Item1 < 2 || buy.Item2 < 0) return (null, "罫線が見つからない");
        int xl = vl.Where(x => x < sell.Item1 - 20).DefaultIfEmpty(0).Max();
        int xr = vl.Where(x => x > buy.Item2 + 20).DefaultIfEmpty(w - 1).Min();
        var cols = new List<(int, int, string)>();
        var inner = vl.Where(x => x >= xl && x <= xr).ToList();
        for (int i = 1; i < inner.Count; i++)
        {
            int l = inner[i - 1] + 2, r = inner[i] - 2; double c = (l + r) / 2.0;
            string name = r - l < 25 ? "印" : c > sell.Item1 && c < sell.Item2 ? "売注" : c > buy.Item1 && c < buy.Item2 ? "買注"
                : r < sell.Item1 ? "売件数" : l > buy.Item2 ? "買件数" : c > danX - 10 && c < danX + 60 ? "値段" : c < danX ? "売" : "買";
            cols.Add((l, r, name));
        }
        var pc = cols.FirstOrDefault(c => c.Item3 == "値段");
        if (pc.Item3 == null) return (null, "値段の列が見つからない");

        // 行: 値段の列の文字の帯（全行に値段がある）。帯の中心の中間を行の境目にする
        var centers = new List<int>();
        int bandStart = -1, lastHit = -10;
        for (int y = y0; y < y1; y++)
        {
            bool hit = false;
            for (int x = pc.Item1 + 2; x < pc.Item2 - 2 && !hit; x++)
            {
                int i = px.At(x, y);
                hit = IsPriceInk(px.Buf[i + 2], px.Buf[i + 1], px.Buf[i]);
            }
            if (!hit) continue;
            if (y - lastHit > 3) { if (bandStart >= 0) centers.Add((bandStart + lastHit) / 2); bandStart = y; }
            lastHit = y;
        }
        if (bandStart >= 0) centers.Add((bandStart + lastHit) / 2);
        if (centers.Count < 5) return (null, "値段の行が読めない");
        var rows = new List<(int, int)>();
        for (int i = 0; i < centers.Count; i++)
        {
            int up = i > 0 ? (centers[i - 1] + centers[i]) / 2 : centers[i] - (centers[1] - centers[0]) / 2;
            int dn = i < centers.Count - 1 ? (centers[i] + centers[i + 1]) / 2 : centers[i] + (centers[i] - centers[i - 1]) / 2;
            rows.Add((up + 1, dn - 1));
        }
        var lay = new Layout(rows[0].Item1, rows[^1].Item2, sell, buy, (pc.Item1, pc.Item2), rows, cols);
        var read = await Read(img, lay);
        int over = Array.FindIndex(read, r => r.Label == "OVER"), under = Array.FindLastIndex(read, r => r.Label == "UNDER");
        int first = Array.FindIndex(read, r => r.Price != null), last = Array.FindLastIndex(read, r => r.Price != null);
        if (first < 0) return (null, "値段の数字が読めない");
        lay = lay with { Lo = over >= 0 && over < first ? over + 1 : first, Hi = under > last ? under - 1 : last };
        return (lay, $"行 {rows.Count} 本 追う行 {lay.Lo}-{lay.Hi} 売注 {sell} 買注 {buy}");
    }

    // マス 1 つの状態。背景が白っぽい（灰色がマスの 4 割超）= Pending。数字（赤・青・白の画素が 5 行以上にまたがる）= Shown。
    // 横の点線（売買の境目）は 1〜2 行にしか色が無いので数字にしない。マウスを載せた時の枠で色の数が増えても状態は変わらない
    public static CellState Cell(Pixels px, (int L, int R) col, (int T, int B) row)
    {
        int gray = 0, ink = 0, n = 0, inkRows = 0;
        var b = px.Buf;
        for (int y = row.T + 2; y <= row.B - 2; y++)
        {
            int before = ink;
            for (int x = col.L + 3; x < col.R - 3; x++)
            {
                int i = px.At(x, y); n++;
                int bl = b[i], g = b[i + 1], r = b[i + 2];
                if (IsRed(r, g, bl) || IsBlue(r, g, bl) || IsWhite(r, g, bl)) ink++;
                else if (IsGray(r, g, bl, 60, 200)) gray++;
            }
            if (ink > before) inkRows++;
        }
        if (n == 0) return CellState.Empty;
        if (gray > n * 0.4) return CellState.Pending;
        return inkRows >= 5 && ink >= 4 ? CellState.Shown : CellState.Empty;
    }

    public static void Scan(Pixels px, Layout lay, CellState[] sell, CellState[] buy)
    {
        for (int k = 0; k < lay.Rows.Count; k++)
        {
            sell[k] = Cell(px, lay.Sell, lay.Rows[k]);
            buy[k] = Cell(px, lay.Buy, lay.Rows[k]);
        }
    }

    // 値段の列の行ごとの模様（文字の画素の並びのハッシュ）。0 = 文字が無い
    public static void PriceSig(Pixels px, Layout lay, ulong[] sig)
    {
        var b = px.Buf;
        for (int k = 0; k < lay.Rows.Count; k++)
        {
            ulong hsh = 1469598103934665603UL; bool any = false;
            var (t, bt) = lay.Rows[k];
            for (int y = t; y <= bt; y++)
                for (int x = lay.Price.L + 2; x < lay.Price.R - 2; x++)
                {
                    int i = px.At(x, y);
                    if (!IsPriceInk(b[i + 2], b[i + 1], b[i])) continue;
                    any = true;
                    hsh = (hsh ^ (ulong)((y - t) * 4096 + (x - lay.Price.L))) * 1099511628211UL;
                }
            sig[k] = any ? hsh : 0;
        }
    }

    // 前のフレームから板が何行ずれたか。cur[k] に prev[k + n] の行が来ていれば n。
    // 0 で大半が一致すれば 0。どのずれでも 6 割一致しなければ null（銘柄の切り替え等。追跡をやり直す）
    public static int? Shift(ulong[] prev, ulong[] cur)
    {
        int rows = Math.Min(prev.Length, cur.Length);
        (int m, int o) Match(int n)
        {
            int m = 0, o = 0;
            for (int k = 0; k < rows; k++)
            {
                int j = k + n;
                if (j < 0 || j >= rows || cur[k] == 0 || prev[j] == 0) continue;
                o++; if (cur[k] == prev[j]) m++;
            }
            return (m, o);
        }
        var z = Match(0);
        if (z.o > 0 && z.m >= z.o * 0.8) return 0;
        int best = 0; double bestRatio = -1;
        for (int n = -(rows - 10); n <= rows - 10; n++)
        {
            var (m, o) = Match(n);
            if (o < 10) continue;
            double r = (double)m / o;
            if (r > bestRatio) { bestRatio = r; best = n; }
        }
        if (z.o > 0 && (double)z.m / z.o >= bestRatio) return z.m >= z.o * 0.6 ? 0 : null;
        return bestRatio >= 0.6 ? best : null;
    }

    public static bool AllBlank(ulong[] sig) => sig.All(s => s == 0);

    static async Task<OcrResult> Ocr(OcrEngine eng, Bitmap b)
    {
        using var ms = new MemoryStream();
        b.Save(ms, ImageFormat.Bmp);
        ms.Position = 0;
        var dec = await BitmapDecoder.CreateAsync(ms.AsRandomAccessStream());
        using var sb = await dec.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
        return await eng.RecognizeAsync(sb);
    }

    // 板の数字を英語の OCR で読む（約 80ms）。1 行 = 1 BoardRow（上から順、行は Layout の行と同じ番号）
    public static async Task<BoardRow[]> Read(Bitmap img, Layout lay)
    {
        int l = lay.Cols.Min(c => c.L) - 2, r = lay.Cols.Max(c => c.R) + 2;
        var rect = Rectangle.Intersect(new Rectangle(l, lay.Top - 4, r - l, lay.Bottom - lay.Top + 8), new Rectangle(0, 0, img.Width, img.Height));
        OcrResult res;
        using (var crop = img.Clone(rect, PixelFormat.Format24bppRgb)) res = await Ocr(En, crop);
        var cells = new Dictionary<string, string>[lay.Rows.Count];
        for (int k = 0; k < cells.Length; k++) cells[k] = [];
        foreach (var wd in res.Lines.SelectMany(x => x.Words))
        {
            int cx = (int)(rect.X + wd.BoundingRect.X + wd.BoundingRect.Width / 2);
            int cy = (int)(rect.Y + wd.BoundingRect.Y + wd.BoundingRect.Height / 2);
            int k = lay.Rows.FindIndex(rw => cy >= rw.T - 1 && cy <= rw.B + 1);
            if (k < 0) continue;
            var col = lay.Cols.FirstOrDefault(c => cx >= c.L - 2 && cx <= c.R + 2).Name;
            if (col == null || col == "印") continue;
            cells[k][col] = cells[k].TryGetValue(col, out var p) ? p + wd.Text : wd.Text;
        }
        return cells.Select(c =>
        {
            string? Get(string n) => c.TryGetValue(n, out var v) ? v : null;
            var priceText = Get("値段");
            string? label = priceText != null && Regex.IsMatch(priceText, "OVER|UNDER", RegexOptions.IgnoreCase) ? priceText.ToUpperInvariant().Contains("OVER") ? "OVER" : "UNDER" : null;
            return new BoardRow(label != null ? null : Number(priceText), label, Number(Get("売")), Number(Get("買")),
                                Number(Get("売件数")), Number(Get("買件数")), Number(Get("売注")), Number(Get("買注")));
        }).ToArray();
    }

    // OCR の数字を読む。カンマを除き、0 と読み違えやすい o・O を 0 にする（例 "1ooo" → 1000、"1,394" → 1394）
    public static decimal? Number(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        var t = s.Replace(",", "").Replace("o", "0").Replace("O", "0").Trim();
        return Regex.IsMatch(t, @"^\d+(\.\d+)?$") && decimal.TryParse(t, System.Globalization.NumberStyles.Number, System.Globalization.CultureInfo.InvariantCulture, out var v) ? v : null;
    }

    // "全板　ソフトバンクグループ(9984)" → ("9984", "ソフトバンクグループ")
    public static (string? Code, string? Name) ParseTitle(string title)
    {
        var m = Regex.Match(title, @"^全板[\s　]*(.*?)[\s　]*\(([^()]+)\)\s*$");
        if (!m.Success) return (null, title.StartsWith("全板") ? title[2..].Trim(' ', '　') is { Length: > 0 } n ? n : null : null);
        return (m.Groups[2].Value, m.Groups[1].Value.Length > 0 ? m.Groups[1].Value : null);
    }
}

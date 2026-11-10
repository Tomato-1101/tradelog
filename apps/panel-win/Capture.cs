using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace TradelogPanel;

// method: "print"（PrintWindow で窓だけ）/ "screen"（PrintWindow が黒・失敗で窓の矩形を画面からコピー）/ "monitor"（モニタ全体）
sealed record Shot(Bitmap Image, string? WindowTitle, string? Process, Rectangle Rect, string Method);

static class Capture
{
    const string TargetProcess = "HYPERSBI2";

    // HYPER SBI 2 の見えているトップレベル窓すべて。無ければ（全部撮れなければ）作業中のモニタ全体
    public static List<Shot> TakeAll(IntPtr foreground, List<string> errors)
    {
        var shots = new List<Shot>();
        var windows = FindWindows();
        foreach (var (hwnd, title) in windows)
        {
            try { shots.Add(CaptureWindow(hwnd, title)); }
            catch (Exception e) { errors.Add($"窓「{title}」: {e.Message}"); }
        }
        if (shots.Count == 0)
        {
            try { shots.Add(CaptureMonitor(foreground)); }
            catch (Exception e) { errors.Add("モニタ全体: " + e.Message); }
        }
        return shots;
    }

    static List<(IntPtr, string)> FindWindows()
    {
        var pids = new HashSet<uint>();
        foreach (var p in System.Diagnostics.Process.GetProcessesByName(TargetProcess))
        {
            pids.Add((uint)p.Id);
            p.Dispose();
        }
        var found = new List<(IntPtr, string)>();
        if (pids.Count == 0) return found;
        Native.EnumWindows((h, _) =>
        {
            Native.GetWindowThreadProcessId(h, out uint pid);
            if (!pids.Contains(pid) || !Native.IsWindowVisible(h) || Native.IsIconic(h)) return true;
            if (Native.DwmGetWindowAttribute(h, Native.DWMWA_CLOAKED, out int cloaked, sizeof(int)) == 0 && cloaked != 0) return true;
            var r = FrameRect(h);
            // ツールチップ・メニュー等の小さな窓は撮らない
            if (r.Width < 120 || r.Height < 80) return true;
            found.Add((h, Native.TitleOf(h)));
            return true;
        }, IntPtr.Zero);
        return found;
    }

    // 影を除いた見た目どおりの窓の矩形（Per-Monitor DPI aware なので実ピクセル）
    static Rectangle FrameRect(IntPtr h)
    {
        if (Native.DwmGetWindowAttribute(h, Native.DWMWA_EXTENDED_FRAME_BOUNDS, out Native.RECT f, Marshal.SizeOf<Native.RECT>()) == 0)
            return Rectangle.FromLTRB(f.Left, f.Top, f.Right, f.Bottom);
        Native.GetWindowRect(h, out var w);
        return Rectangle.FromLTRB(w.Left, w.Top, w.Right, w.Bottom);
    }

    static Shot CaptureWindow(IntPtr h, string title)
    {
        var frame = FrameRect(h);
        Native.GetWindowRect(h, out var wr);
        var win = Rectangle.FromLTRB(wr.Left, wr.Top, wr.Right, wr.Bottom);
        if (win.Width > 0 && win.Height > 0)
        {
            using var full = new Bitmap(win.Width, win.Height, PixelFormat.Format24bppRgb);
            bool ok;
            using (var g = Graphics.FromImage(full))
            {
                var hdc = g.GetHdc();
                try { ok = Native.PrintWindow(h, hdc, Native.PW_RENDERFULLCONTENT); }
                finally { g.ReleaseHdc(hdc); }
            }
            if (ok)
            {
                var crop = new Rectangle(frame.X - win.X, frame.Y - win.Y, frame.Width, frame.Height);
                crop.Intersect(new Rectangle(0, 0, full.Width, full.Height));
                if (crop.Width > 0 && crop.Height > 0)
                {
                    var img = full.Clone(crop, PixelFormat.Format24bppRgb);
                    if (!IsBlack(img)) return new Shot(img, title, TargetProcess, frame, "print");
                    img.Dispose();
                }
            }
        }
        var screen = Rectangle.Intersect(frame, SystemInformation.VirtualScreen);
        return new Shot(CopyScreen(screen), title, TargetProcess, frame, "screen");
    }

    static Shot CaptureMonitor(IntPtr foreground)
    {
        var screen = foreground != IntPtr.Zero ? Screen.FromHandle(foreground) : Screen.FromPoint(Cursor.Position);
        return new Shot(CopyScreen(screen.Bounds), null, null, screen.Bounds, "monitor");
    }

    static Bitmap CopyScreen(Rectangle r)
    {
        if (r.Width <= 0 || r.Height <= 0) throw new InvalidOperationException($"撮影範囲が空 {r}");
        var bmp = new Bitmap(r.Width, r.Height, PixelFormat.Format24bppRgb);
        try
        {
            using var g = Graphics.FromImage(bmp);
            g.CopyFromScreen(r.X, r.Y, 0, 0, r.Size, CopyPixelOperation.SourceCopy);
            return bmp;
        }
        catch
        {
            bmp.Dispose();
            throw;
        }
    }

    // PrintWindow が描けなかった窓は真っ黒になる。格子状に 64x64 点だけ見る
    static bool IsBlack(Bitmap b)
    {
        var data = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        try
        {
            int sx = Math.Max(1, b.Width / 64), sy = Math.Max(1, b.Height / 64);
            for (int y = 0; y < b.Height; y += sy)
                for (int x = 0; x < b.Width; x += sx)
                {
                    int off = y * data.Stride + x * 3;
                    if (Marshal.ReadByte(data.Scan0, off) > 16 || Marshal.ReadByte(data.Scan0, off + 1) > 16 || Marshal.ReadByte(data.Scan0, off + 2) > 16)
                        return false;
                }
            return true;
        }
        finally { b.UnlockBits(data); }
    }
}

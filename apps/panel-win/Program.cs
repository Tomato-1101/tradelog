using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace TradelogPanel;

static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        // 配備のたびに SSH から回す自己テスト（窓は出さない。結果は logs\selftest.txt と終了コード）
        if (args.Length > 0 && args[0] == "--selftest") return SelfTest.Run(args.Skip(1).ToArray());
        // ログオン時のタスクと schtasks /run が重なっても窓は 1 つだけにする
        using var mutex = new Mutex(true, @"Local\tradelog-panel-win", out bool created);
        if (!created)
        {
            Log.Write("既に起動しているので終了する");
            return 0;
        }
        ApplicationConfiguration.Initialize();
        Application.ThreadException += (_, e) => Log.Write("UI スレッドの例外: " + e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Log.Write("未処理の例外: " + e.ExceptionObject);

        Directory.CreateDirectory(Paths.Data);
        Directory.CreateDirectory(Paths.Cmd);
        var (settings, warn) = Settings.Load();
        using var self = Process.GetCurrentProcess();
        Log.Write($"起動 pid={self.Id} session={self.SessionId} data={Paths.Data}");
        Application.Run(new PanelForm(settings, warn));
        Log.Write("終了");
        return 0;
    }
}

static class Paths
{
    public static readonly string Root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "tradelog");
    public static readonly string Data = Path.Combine(Root, "data", "real");
    public static readonly string Events = Path.Combine(Data, "events.jsonl");
    public static readonly string Cmd = Path.Combine(Data, "cmd");
    public static readonly string Logs = Path.Combine(Root, "logs");
    public static readonly string Settings = Path.Combine(Root, "settings.json");
    public static readonly string State = Path.Combine(Root, "panel-state.json");
}

static class Log
{
    static readonly object Lock = new();

    // ログが書けないことで記録そのものを止めない（ログの失敗は捨てる）
    public static void Write(string message)
    {
        try
        {
            lock (Lock)
            {
                Directory.CreateDirectory(Paths.Logs);
                var file = Path.Combine(Paths.Logs, "panel.log");
                var info = new FileInfo(file);
                if (info.Exists && info.Length > 5 * 1024 * 1024) File.Move(file, file + ".1", true);
                File.AppendAllText(file, $"[{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss.fff}] {message}\r\n", new UTF8Encoding(false));
            }
        }
        catch (Exception) { }
    }
}

sealed class Settings
{
    // "Ctrl+Shift+M" の形。空文字か null で無効
    public string? Hotkey { get; set; } = "Ctrl+Shift+M";

    static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
        WriteIndented = true,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    // 無ければ既定値で作る。読めなければ既定値で動き、警告を窓に出す
    public static (Settings, string?) Load()
    {
        try
        {
            if (!File.Exists(Paths.Settings))
            {
                var s = new Settings();
                File.WriteAllText(Paths.Settings, JsonSerializer.Serialize(s, Options), new UTF8Encoding(false));
                return (s, null);
            }
            var loaded = JsonSerializer.Deserialize<Settings>(File.ReadAllText(Paths.Settings), Options) ?? new Settings();
            return (loaded, null);
        }
        catch (Exception e)
        {
            Log.Write("settings.json を読めないので既定値で動く: " + e.Message);
            return (new Settings(), "settings.json が読めないので既定値で動作中");
        }
    }
}

static class Native
{
    public const int WM_HOTKEY = 0x0312;
    public const uint PW_RENDERFULLCONTENT = 0x2;

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mods, uint vk);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    public static readonly IntPtr HWND_TOPMOST = new(-1);
    public const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10;

    public static string TitleOf(IntPtr hWnd)
    {
        if (hWnd == IntPtr.Zero) return "";
        int n = GetWindowTextLength(hWnd);
        var sb = new StringBuilder(n + 1);
        GetWindowText(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }
}

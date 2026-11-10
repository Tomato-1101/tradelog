using System.Text.Json;

namespace TradelogPanel;

// 常に最前面の小窓。ボタン 1 回 = 撮影＋そのタグで記録。押しても前面の窓（HYPER SBI 2）からフォーカスを奪わない
sealed class PanelForm : Form
{
    const int HotkeyId = 1;
    readonly Settings settings;
    readonly Label status;
    readonly System.Windows.Forms.Timer cmdTimer;
    readonly SemaphoreSlim gate = new(1, 1);
    bool hotkeyRegistered;

    public PanelForm(Settings settings, string? warning)
    {
        this.settings = settings;
        SuspendLayout();
        // 96 DPI の論理座標で並べ、実際の DPI へは WinForms に拡大させる（モニタを移っても追従する）
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        Font = new Font("Yu Gothic UI", 10F);
        Text = "tradelog 記録";
        FormBorderStyle = FormBorderStyle.FixedToolWindow;
        MaximizeBox = false;
        MinimizeBox = false;
        TopMost = true;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;

        var buttons = new List<(string Text, string? Tag)> { ("記録", null) };
        buttons.AddRange(settings.Tags.Select(t => (t, (string?)t)));
        const int bw = 76, bh = 34, gap = 6, perRow = 6, statusH = 24;
        int cols = Math.Min(perRow, buttons.Count);
        int rows = (buttons.Count + perRow - 1) / perRow;
        for (int i = 0; i < buttons.Count; i++)
        {
            var (text, tag) = buttons[i];
            var b = new Button
            {
                Text = text,
                Location = new Point(gap + i % perRow * (bw + gap), gap + i / perRow * (bh + gap)),
                Size = new Size(bw, bh),
                AutoEllipsis = true,
                UseMnemonic = false,
                TabStop = false,
            };
            b.Click += (_, _) => Trigger(tag is null ? [] : [tag], test: false);
            Controls.Add(b);
        }
        int width = gap + cols * (bw + gap);
        int top = gap + rows * (bh + gap);
        // 結果の 1 行。高さ・幅は固定（文言の有無・長さで窓もボタンも動かない。長ければ … で切る）
        status = new Label
        {
            AutoSize = false,
            AutoEllipsis = true,
            UseMnemonic = false,
            TextAlign = ContentAlignment.MiddleLeft,
            Location = new Point(gap, top),
            Size = new Size(width - gap * 2, statusH),
            Text = warning ?? "",
        };
        Controls.Add(status);
        ClientSize = new Size(width, top + statusH + gap);
        ResumeLayout(false);

        // SSH からの動作確認用: data\real\cmd\ にファイルが置かれたら 1 回撮影（test 付き）
        cmdTimer = new System.Windows.Forms.Timer { Interval = 1000 };
        cmdTimer.Tick += (_, _) => PollCmd();
        cmdTimer.Start();
    }

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= Native.WS_EX_NOACTIVATE;
            return cp;
        }
    }

    protected override void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        Location = LoadLocation();
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        RegisterHotkey();
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        if (hotkeyRegistered) Native.UnregisterHotKey(Handle, HotkeyId);
        base.OnFormClosed(e);
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == Native.WM_HOTKEY && m.WParam == HotkeyId) Trigger([], test: false);
        base.WndProc(ref m);
    }

    // 押した瞬間の時刻と前面の窓をここで取り、撮影・保存は裏で行う（UI を固めない）
    void Trigger(List<string> tags, bool test)
    {
        var ts = DateTimeOffset.Now;
        var fg = Native.GetForegroundWindow();
        var fgTitle = Native.TitleOf(fg);
        status.Text = $"記録中 {ts:HH:mm:ss}…";
        _ = Task.Run(async () =>
        {
            await gate.WaitAsync();
            string msg;
            try { msg = Recorder.Record(ts, fg, fgTitle, tags, test); }
            catch (Exception e)
            {
                Log.Write("記録に失敗: " + e);
                msg = $"記録に失敗 {ts:HH:mm:ss}（logs\\panel.log）";
            }
            finally { gate.Release(); }
            try { BeginInvoke(() => status.Text = msg); }
            catch (InvalidOperationException) { }
        });
    }

    void PollCmd()
    {
        string[] files;
        try { files = Directory.GetFiles(Paths.Cmd); }
        catch (Exception) { return; }
        foreach (var f in files)
        {
            try { File.Delete(f); }
            catch (Exception) { continue; } // まだ書きかけ。次の周期で拾う
            Log.Write("cmd を受け取った: " + Path.GetFileName(f));
            Trigger([], test: true);
        }
    }

    void RegisterHotkey()
    {
        var spec = settings.Hotkey?.Trim();
        if (string.IsNullOrEmpty(spec)) return;
        if (!TryParseHotkey(spec, out uint mods, out uint vk))
        {
            Log.Write($"ホットキーの書き方が読めない: {spec}");
            status.Text = $"ホットキー「{spec}」が読めない（settings.json）";
            return;
        }
        const uint MOD_NOREPEAT = 0x4000;
        hotkeyRegistered = Native.RegisterHotKey(Handle, HotkeyId, mods | MOD_NOREPEAT, vk);
        if (!hotkeyRegistered)
        {
            Log.Write($"ホットキー {spec} を登録できない（他のアプリが使用中）");
            status.Text = $"ホットキー {spec} は他のアプリが使用中";
        }
    }

    static bool TryParseHotkey(string spec, out uint mods, out uint vk)
    {
        mods = 0;
        vk = 0;
        foreach (var raw in spec.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            switch (raw.ToLowerInvariant())
            {
                case "ctrl": case "control": mods |= 0x2; continue;
                case "shift": mods |= 0x4; continue;
                case "alt": mods |= 0x1; continue;
                case "win": mods |= 0x8; continue;
            }
            var name = raw.Length == 1 && char.IsDigit(raw[0]) ? "D" + raw : raw;
            if (vk != 0 || !Enum.TryParse(name, true, out Keys key)) return false;
            vk = (uint)key;
        }
        return vk != 0;
    }

    // 窓の位置は動かした所を覚える。画面外になっていたら主モニタの右下
    Point LoadLocation()
    {
        try
        {
            if (File.Exists(Paths.State))
            {
                var p = JsonSerializer.Deserialize<Dictionary<string, int>>(File.ReadAllText(Paths.State));
                if (p != null && p.TryGetValue("x", out int x) && p.TryGetValue("y", out int y))
                {
                    var r = new Rectangle(x, y, Width, Height);
                    if (Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(r))) return new Point(x, y);
                }
            }
        }
        catch (Exception e) { Log.Write("panel-state.json を読めない: " + e.Message); }
        var wa = Screen.PrimaryScreen!.WorkingArea;
        return new Point(wa.Right - Width - 24, wa.Bottom - Height - 24);
    }

    protected override void OnResizeEnd(EventArgs e)
    {
        base.OnResizeEnd(e);
        try { File.WriteAllText(Paths.State, JsonSerializer.Serialize(new Dictionary<string, int> { ["x"] = Left, ["y"] = Top })); }
        catch (Exception ex) { Log.Write("panel-state.json を書けない: " + ex.Message); }
    }
}

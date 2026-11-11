using System.Text.Json;
using System.Text.Json.Nodes;

namespace TradelogPanel;

// 常に最前面の小窓。上 2 行 = 監視の状態と最後に見た注文、下 = 理由の入力欄（本人は voicekey で声から入力する。小窓は普通の入力欄で、Enter で保存）。
// 起動時はフォーカスを奪わない。入力欄をクリックした時かホットキーの時だけ前に出て、保存したら元の窓へフォーカスを返す
sealed class PanelForm : Form
{
    const int HotkeyId = 1;
    readonly Settings settings;
    readonly Label status, lastEvent, saved;
    readonly TextBox note;
    readonly BoardMonitor monitor;
    readonly System.Windows.Forms.Timer timer;
    IntPtr lastOther;
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

        const int width = 380, gap = 6, lineH = 22, noteH = 62;
        // どの欄も高さ・幅は固定（文言の有無・長さで窓も欄も動かない。長ければ … で切る）
        Label Line(int y) => new()
        {
            AutoSize = false, AutoEllipsis = true, UseMnemonic = false, TextAlign = ContentAlignment.MiddleLeft,
            Location = new Point(gap, y), Size = new Size(width - gap * 2, lineH), Text = "",
        };
        status = Line(gap);
        status.Text = warning ?? "起動中…";
        lastEvent = Line(gap + lineH);
        lastEvent.ForeColor = SystemColors.GrayText;
        lastEvent.Text = "注文はまだ見ていない";
        note = new TextBox
        {
            Multiline = true, WordWrap = true, AcceptsReturn = false, ScrollBars = ScrollBars.Vertical,
            Location = new Point(gap, gap + lineH * 2 + 4), Size = new Size(width - gap * 2, noteH),
            PlaceholderText = "理由 → Enter で保存",
        };
        saved = Line(gap + lineH * 2 + 4 + noteH + 2);
        saved.ForeColor = SystemColors.GrayText;
        Controls.AddRange([status, lastEvent, note, saved]);
        ClientSize = new Size(width, saved.Bottom + gap);
        ResumeLayout(false);

        note.KeyDown += (_, e) =>
        {
            if (e.KeyCode == Keys.Enter && !e.Shift) { e.SuppressKeyPress = true; Save(test: false); ReturnFocus(); }
            else if (e.KeyCode == Keys.Escape) { e.SuppressKeyPress = true; ReturnFocus(); }
        };
        // 書きかけのまま他の窓をクリックしても文を失わない
        Deactivate += (_, _) => { if (note.Text.Trim().Length > 0) Save(test: false); };

        monitor = new BoardMonitor(s => Ui(() => status.Text = s), s => Ui(() => { lastEvent.ForeColor = ForeColor; lastEvent.Text = s; }));

        // 保存後にフォーカスを返す先（小窓より前に前面だった窓）と、SSH からの動作確認（data\real\cmd\）を見る
        timer = new System.Windows.Forms.Timer { Interval = 250 };
        int ticks = 0;
        timer.Tick += (_, _) =>
        {
            var fg = Native.GetForegroundWindow();
            if (fg != IntPtr.Zero && fg != Handle) lastOther = fg;
            if (++ticks % 4 == 0) PollCmd();
        };
    }

    void Ui(Action a)
    {
        try { if (IsHandleCreated && !IsDisposed) BeginInvoke(a); }
        catch (InvalidOperationException) { }
    }

    protected override bool ShowWithoutActivation => true;

    protected override void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        Location = LoadLocation();
        timer.Start();
        monitor.Start();
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        RegisterHotkey();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        Log.Write($"窓を閉じる reason={e.CloseReason}");
        if (note.Text.Trim().Length > 0) Save(test: false);
        timer.Stop();
        monitor.Stop();
        base.OnFormClosing(e);
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        if (hotkeyRegistered) Native.UnregisterHotKey(Handle, HotkeyId);
        base.OnFormClosed(e);
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == Native.WM_HOTKEY && m.WParam == HotkeyId)
        {
            var fg = Native.GetForegroundWindow();
            if (fg != IntPtr.Zero && fg != Handle) lastOther = fg;
            Activate();
            note.Focus();
        }
        base.WndProc(ref m);
    }

    void ReturnFocus()
    {
        if (lastOther != IntPtr.Zero && Native.IsWindow(lastOther)) Native.SetForegroundWindow(lastOther);
    }

    void Save(bool test, string? text = null)
    {
        text = (text ?? note.Text).Trim();
        if (!test) note.Clear();
        if (text.Length == 0) return;
        var ts = DateTimeOffset.Now;
        var last = monitor.Last;
        var ev = new JsonObject
        {
            ["v"] = 2, ["type"] = "real_note", ["id"] = Guid.NewGuid().ToString(), ["ts"] = Jsonl.Ts(ts), ["text"] = text,
            ["last_order"] = last == null ? null : new JsonObject
            {
                ["order_key"] = last.OrderKey, ["event"] = last.Event, ["side"] = last.Side,
                ["price"] = last.Price is { } p ? JsonValue.Create(p) : null, ["ts"] = Jsonl.Ts(last.Ts),
            },
        };
        if (test) ev["test"] = true;
        try
        {
            Jsonl.Write(ev);
            Log.Write($"理由を保存 id={ev["id"]} test={test} 文字数={text.Length} last={last?.Event}");
            var head = text.Length > 24 ? text[..24] + "…" : text;
            saved.Text = $"{(test ? "テスト保存" : "保存")} {ts:HH:mm:ss}「{head}」";
        }
        catch (Exception e)
        {
            Log.Write("理由の保存に失敗: " + e);
            saved.Text = $"保存に失敗 {ts:HH:mm:ss}（logs\\panel.log）";
            if (!test) note.Text = text; // 文を捨てない
        }
    }

    // SSH からの動作確認用: data\real\cmd\ にファイルが置かれたら、その中身（空なら「テスト」）を test 付きの理由として保存
    void PollCmd()
    {
        string[] files;
        try { files = Directory.GetFiles(Paths.Cmd); }
        catch (Exception) { return; }
        foreach (var f in files)
        {
            string body;
            try { body = File.ReadAllText(f); File.Delete(f); }
            catch (Exception) { continue; } // まだ書きかけ。次の周期で拾う
            Log.Write("cmd を受け取った: " + Path.GetFileName(f));
            Save(test: true, text: body.Trim().Length > 0 ? body : "テスト");
        }
    }

    void RegisterHotkey()
    {
        var spec = settings.Hotkey?.Trim();
        if (string.IsNullOrEmpty(spec)) return;
        if (!TryParseHotkey(spec, out uint mods, out uint vk))
        {
            Log.Write($"ホットキーの書き方が読めない: {spec}");
            saved.Text = $"ホットキー「{spec}」が読めない（settings.json）";
            return;
        }
        const uint MOD_NOREPEAT = 0x4000;
        hotkeyRegistered = Native.RegisterHotKey(Handle, HotkeyId, mods | MOD_NOREPEAT, vk);
        if (!hotkeyRegistered)
        {
            Log.Write($"ホットキー {spec} を登録できない（他のアプリが使用中）");
            saved.Text = $"ホットキー {spec} は他のアプリが使用中";
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

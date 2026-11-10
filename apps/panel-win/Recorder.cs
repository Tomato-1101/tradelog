using System.Diagnostics;
using System.Drawing.Imaging;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace TradelogPanel;

// 1 回の記録 = 撮影 → PNG 保存 → events.jsonl に 1 行追記（契約は docs/real-events.md）
static class Recorder
{
    static readonly JsonSerializerOptions Json = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public static string Record(DateTimeOffset ts, IntPtr foreground, string foregroundTitle, List<string> tags, bool test)
    {
        var sw = Stopwatch.StartNew();
        var id = Guid.NewGuid().ToString();
        var errors = new List<string>();
        var shots = Capture.TakeAll(foreground, errors);
        long captureMs = sw.ElapsedMilliseconds;

        var day = ts.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
        var dir = Path.Combine(Paths.Data, "shots", day);
        Directory.CreateDirectory(dir);
        var shotArray = new JsonArray();
        for (int i = 0; i < shots.Count; i++)
        {
            var s = shots[i];
            var rel = $"shots/{day}/{id}-{i + 1}.png";
            var file = Path.Combine(dir, $"{id}-{i + 1}.png");
            try
            {
                // 書きかけの PNG を Mac が取らないよう、.tmp に書いてから名前を変える
                s.Image.Save(file + ".tmp", ImageFormat.Png);
                File.Move(file + ".tmp", file, true);
                shotArray.Add(new JsonObject
                {
                    ["path"] = rel,
                    ["window_title"] = s.WindowTitle,
                    ["process"] = s.Process,
                    ["rect"] = new JsonArray(s.Rect.X, s.Rect.Y, s.Rect.Width, s.Rect.Height),
                    ["method"] = s.Method,
                });
            }
            catch (Exception e) { errors.Add($"{rel} の保存: {e.Message}"); }
            finally { s.Image.Dispose(); }
        }

        var ev = new JsonObject
        {
            ["v"] = 1,
            ["type"] = "real_memo",
            ["id"] = id,
            ["ts"] = ts.ToString("yyyy-MM-dd'T'HH:mm:ss.fffzzz", System.Globalization.CultureInfo.InvariantCulture),
            ["tags"] = new JsonArray(tags.Select(t => (JsonNode?)t).ToArray()),
            ["shots"] = shotArray,
            ["active_window_title"] = foregroundTitle,
        };
        if (test) ev["test"] = true;
        if (errors.Count > 0) ev["capture_error"] = string.Join(" / ", errors);
        Append(ev.ToJsonString(Json));

        var methods = string.Join(",", shotArray.Select(n => (string?)n!["method"]));
        Log.Write($"記録 id={id} ts={ev["ts"]} tags=[{string.Join(",", tags)}] shots={shotArray.Count}({methods}) test={test} 撮影{captureMs}ms 計{sw.ElapsedMilliseconds}ms" +
                  (errors.Count > 0 ? " エラー: " + ev["capture_error"] : ""));

        var head = test ? "テスト記録" : "記録しました";
        var tagText = tags.Count > 0 ? " " + string.Join("・", tags) : "";
        if (shotArray.Count == 0) return $"{head} {ts:HH:mm:ss}{tagText}（撮影失敗・ログ参照）";
        var what = shotArray.Count == 1 && (string?)shotArray[0]!["method"] == "monitor" ? "画面全体" : $"{shotArray.Count}枚";
        return $"{head} {ts:HH:mm:ss}{tagText}（{what}）";
    }

    static readonly object AppendLock = new();

    // 1 行を 1 回の書き込みで足す。前の行が書きかけで終わっていたら改行を補って行を混ぜない
    static void Append(string line)
    {
        var bytes = new UTF8Encoding(false).GetBytes(line + "\n");
        lock (AppendLock)
        {
            for (int attempt = 0; ; attempt++)
            {
                try
                {
                    using var fs = new FileStream(Paths.Events, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.Read);
                    if (fs.Length > 0)
                    {
                        fs.Seek(-1, SeekOrigin.End);
                        if (fs.ReadByte() != '\n') fs.WriteByte((byte)'\n');
                    }
                    fs.Seek(0, SeekOrigin.End);
                    fs.Write(bytes, 0, bytes.Length);
                    fs.Flush(true);
                    return;
                }
                // Mac の回収（sftp）が読んでいる間は開けないことがあるので少し待って再試行する
                catch (IOException) when (attempt < 20)
                {
                    Thread.Sleep(100);
                }
            }
        }
    }
}

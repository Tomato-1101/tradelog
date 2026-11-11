using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace TradelogPanel;

// events.jsonl への追記（契約は docs/real-events.md）
static class Jsonl
{
    static readonly JsonSerializerOptions Json = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    static readonly object AppendLock = new();

    public static string Ts(DateTimeOffset t) => t.ToString("yyyy-MM-dd'T'HH:mm:ss.fffzzz", CultureInfo.InvariantCulture);

    public static void Write(JsonObject ev) => Append(ev.ToJsonString(Json));

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

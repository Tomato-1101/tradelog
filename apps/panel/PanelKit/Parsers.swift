import Foundation

/// 画面から読んだ文字列を、契約どおりの 10 進数文字列に直す。
/// 誤った値を入れるより null の方がましなので、少しでも曖昧なら nil を返す。
public enum PriceParser {
    // カンマ無し: 1234 / 1234.5 、カンマ有り: 3 桁区切りが正しいものだけ（1,234 / 12,345.5）
    private static let plain = try! NSRegularExpression(pattern: #"^[0-9]+(\.[0-9]+)?$"#)
    private static let grouped = try! NSRegularExpression(pattern: #"^[0-9]{1,3}(,[0-9]{3})+(\.[0-9]+)?$"#)

    public static func parse(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        let range = NSRange(s.startIndex..., in: s)
        if plain.firstMatch(in: s, range: range) != nil || grouped.firstMatch(in: s, range: range) != nil {
            return s.replacingOccurrences(of: ",", with: "")
        }
        return nil
    }
}

/// 東証コード（4 桁英数。例 7203, 285A）
public enum SymbolParser {
    private static let code = try! NSRegularExpression(pattern: #"(?<![0-9A-Z])[0-9][0-9A-Z][0-9][0-9A-Z](?![0-9A-Z])"#)

    /// 入力欄の値として正しい形か
    public static func isValid(_ s: String) -> Bool {
        let range = NSRange(s.startIndex..., in: s)
        guard let m = code.firstMatch(in: s, range: range) else { return false }
        return m.range == range
    }

    /// 読み取った文字列からコードらしい最初の 4 文字を抜き出す（無ければ nil）
    public static func extract(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let s = raw.uppercased()
        let range = NSRange(s.startIndex..., in: s)
        guard let m = code.firstMatch(in: s, range: range), let r = Range(m.range, in: s) else { return nil }
        return String(s[r])
    }
}

/// 株数は正の整数だけ受け付ける
public enum QtyParser {
    public static func parse(_ raw: String) -> String? {
        let s = raw.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: "")
        guard !s.isEmpty, s.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
        guard let n = Decimal(string: s, locale: Locale(identifier: "en_US_POSIX")), n > 0 else { return nil }
        return NSDecimalNumber(decimal: n).stringValue
    }
}

public extension Decimal {
    init?(contract s: String?) {
        guard let s, let d = Decimal(string: s, locale: Locale(identifier: "en_US_POSIX")) else { return nil }
        self = d
    }

    var contractString: String { NSDecimalNumber(decimal: self).stringValue }

    /// 表示用（小数 2 桁で丸め、末尾の 0 は落とす）
    var displayString: String {
        var x = self
        var r = Decimal()
        NSDecimalRound(&r, &x, 2, .plain)
        return NSDecimalNumber(decimal: r).stringValue
    }
}

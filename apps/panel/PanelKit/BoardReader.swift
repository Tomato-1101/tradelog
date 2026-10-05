import CoreGraphics
import Foundation
import Vision

/// 全画面 OCR の 1 語（座標は画像に対する 0〜1、左上原点）
public struct OCRItem: Codable, Equatable, Sendable {
    public var text: String
    public var conf: Double
    public var x: Double
    public var y: Double
    public var w: Double
    public var h: Double

    var maxX: Double { x + w }
    var midY: Double { y + h / 2 }
}

/// 自動で読めた値（読めなければ null）。source は "region"（設定した読み取り領域）/ "label"（「現在値」の右）/ null
public struct AutoRead: Codable, Equatable, Sendable {
    public var price: String?
    public var priceText: String?
    public var priceTime: String?
    public var symbol: String?
    public var source: String?

    public init(price: String? = nil, priceText: String? = nil, priceTime: String? = nil, symbol: String? = nil, source: String? = nil) {
        self.price = price
        self.priceText = priceText
        self.priceTime = priceTime
        self.symbol = symbol
        self.source = source
    }

    enum CodingKeys: String, CodingKey {
        case price, source, symbol
        case priceText = "price_text"
        case priceTime = "price_time"
    }

    // 読めなかった値も null として必ず書く（web が「キーが無い」と「読めなかった」を区別しなくて済むように）
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(price, forKey: .price)
        try c.encode(priceText, forKey: .priceText)
        try c.encode(priceTime, forKey: .priceTime)
        try c.encode(symbol, forKey: .symbol)
        try c.encode(source, forKey: .source)
    }
}

/// shots/YYYY-MM-DD/<order id>.ocr.json（形式は docs/paper-events.md「全画面 OCR のサイドカー」）
public struct OCRSidecar: Codable, Equatable, Sendable {
    public var v = 1
    public var width: Int
    public var height: Int
    public var capturedAt: String?
    public var windowTitle: String?
    public var auto: AutoRead
    public var items: [OCRItem]

    enum CodingKeys: String, CodingKey {
        case v, width, height, auto, items
        case capturedAt = "captured_at"
        case windowTitle = "window_title"
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(v, forKey: .v)
        try c.encode(width, forKey: .width)
        try c.encode(height, forKey: .height)
        try c.encode(capturedAt, forKey: .capturedAt)
        try c.encode(windowTitle, forKey: .windowTitle)
        try c.encode(auto, forKey: .auto)
        try c.encode(items, forKey: .items)
    }

    public func data() throws -> Data {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try enc.encode(self)
    }

    /// 書きかけを web に読ませないよう、一時ファイルに書いてから置き換える
    public func write(to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data().write(to: url, options: .atomic)
    }

    public static func load(_ url: URL) -> OCRSidecar? {
        guard let d = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(OCRSidecar.self, from: d)
    }
}

/// HYPER SBI 2 の「全板」ウィンドウを読む（端末内の Vision だけ。ネットワークは使わない）。
/// 銘柄コード = ウィンドウタイトルの「(5803)」、現在値 = 「現在値」ラベルと同じ行の右の数値と時刻。
/// ラベルが見つからない時に画面のどこかの数値を拾うことはしない（誤った価格より null の方がまし）
public enum BoardReader {
    static let languages = ["ja-JP", "en-US"]

    // MARK: 銘柄コード

    private static let titleCode = try! NSRegularExpression(pattern: #"[(（]([0-9][0-9A-Z][0-9][0-9A-Z])[)）]"#)

    /// 「全板　フジクラ(5803)」→ "5803"（全角括弧も可）。無ければ nil
    public static func symbol(fromTitle title: String?) -> String? {
        guard let s = title?.uppercased() else { return nil }
        let range = NSRange(s.startIndex..., in: s)
        guard let m = titleCode.firstMatch(in: s, range: range), let r = Range(m.range(at: 1), in: s) else { return nil }
        return String(s[r])
    }

    // MARK: 全画面 OCR

    /// 画像全体を読む（日本語＋英数）。座標は左上原点の 0〜1
    public static func recognize(_ image: CGImage) -> [OCRItem] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        request.recognitionLanguages = languages
        do {
            try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        } catch {
            return []
        }
        return (request.results ?? []).compactMap { obs in
            guard let c = obs.topCandidates(1).first else { return nil }
            let b = obs.boundingBox
            return OCRItem(text: normalize(c.string), conf: round(Double(c.confidence), 3),
                           x: round(b.minX, 4), y: round(1 - b.maxY, 4), w: round(b.width, 4), h: round(b.height, 4))
        }
    }

    /// Vision は「値」を簡体字の「值」で返すことがある（実測: 呼値 → 呼值）
    static func normalize(_ s: String) -> String { s.replacingOccurrences(of: "值", with: "値") }

    private static func round(_ v: Double, _ digits: Int) -> Double {
        let p = pow(10, Double(digits))
        return (v * p).rounded() / p
    }

    // MARK: 現在値

    public struct LabelPrice: Equatable, Sendable {
        public var price: String?
        public var text: String?
        public var time: String?
    }

    /// 数値の後ろに来てよいのは、空白・行末・値動きの矢印（↑↓。Vision は「T」と読むことがある）だけ。
    /// 英字や記号がくっついたもの（実測: 全画面 OCR で 5,566 → "99S'S"）や時刻の一部は数値として採らない
    private static let number = try! NSRegularExpression(pattern: #"(?<![0-9:,.A-Za-z])[0-9][0-9,]*(\.[0-9]+)?(?=\s|$|[↑↓⇧⇩]|T(?![A-Za-z]))"#)
    private static let clock = try! NSRegularExpression(pattern: #"(?<![0-9])([01]?[0-9]|2[0-3]):([0-5][0-9])(?![0-9])"#)

    /// 1 行の文字列から、最初の数値（時刻の一部・崩れた読みではないもの）と、その後ろの HH:MM を取る
    static func parseLine(_ s: String) -> LabelPrice {
        let ns = s as NSString
        let whole = NSRange(location: 0, length: ns.length)
        guard let m = number.firstMatch(in: s, range: whole) else {
            // 価格が読めなくても時刻は採る
            return LabelPrice(time: clock.firstMatch(in: s, range: whole).map { padHour(ns.substring(with: $0.range)) })
        }
        let raw = ns.substring(with: m.range)
        let after = NSRange(location: m.range.upperBound, length: ns.length - m.range.upperBound)
        let time = clock.firstMatch(in: s, range: after).map { ns.substring(with: $0.range) }
        return LabelPrice(price: PriceParser.parse(raw), text: raw, time: time.map(padHour))
    }

    private static func padHour(_ t: String) -> String { t.count == 4 ? "0" + t : t }

    private static func cjkCount(_ s: String) -> Int {
        s.unicodeScalars.filter { (0x3040...0x30FF).contains($0.value) || (0x4E00...0x9FFF).contains($0.value) }.count
    }

    /// 「現在値」ラベルの右（同じ行・次のラベルの手前まで）から現在値と時刻を読む。ラベルが無ければ nil。
    /// 全画面の OCR は数字を読み違えることがある（実測: 5,566 → "99S'S"）ので、その範囲を切り出して読み直し、
    /// 読み直した値を優先する。両方読めて食い違う時は価格を null にする
    public static func priceByLabel(image: CGImage, items: [OCRItem]) -> LabelPrice? {
        // 一番上の「現在値」を使う（全板のヘッダー行。下の表に同じ語があっても拾わない）
        guard let label = items.filter({ $0.text.contains("現在値") }).min(by: { $0.y < $1.y }) else { return nil }
        let labelText = label.text
        let tailStart = labelText.range(of: "現在値")!.upperBound
        let tail = String(labelText[tailStart...])
        // ラベルと値が 1 語にくっついて読まれた時は、ラベルの文字の割合だけ右から読み直す
        let labelChars = Double(labelText.distance(from: labelText.startIndex, to: tailStart))
        let startX = tail.isEmpty ? label.maxX : label.x + label.w * labelChars / Double(max(labelText.count, 1))

        let tolerance = max(label.h * 0.6, 0.002)
        let sameLine = items
            .filter { $0 != label && abs($0.midY - label.midY) <= tolerance && $0.x >= label.maxX - label.w * 0.1 }
            .sorted { $0.x < $1.x }
        // 次のラベル（漢字・かなが 2 文字以上。例「高値」）で止める
        var parts: [OCRItem] = []
        var stopX: Double?
        for it in sameLine {
            if cjkCount(it.text) >= 2 { stopX = it.x; break }
            parts.append(it)
        }
        let lineText = ([tail] + parts.map(\.text)).joined(separator: " ").trimmingCharacters(in: .whitespaces)
        let fromLine = parseLine(lineText)

        let endX = min(stopX ?? (label.maxX + label.w * 8), 1)
        var fromCrop = LabelPrice()
        if endX > startX {
            let region = RelRect(x: startX, y: label.midY - label.h * 0.9, w: endX - startX, h: label.h * 1.8)
            fromCrop = parseLine(normalize(TextReader.read(image, region: region, languages: languages).text ?? ""))
        }

        var r = LabelPrice(time: fromCrop.time ?? fromLine.time)
        switch (fromCrop.price, fromLine.price) {
        case let (c?, l?) where c != l:
            r.price = nil
            r.text = fromCrop.text
        case let (c?, _):
            r.price = c
            r.text = fromCrop.text
        case let (nil, l?):
            r.price = l
            r.text = fromLine.text
        default:
            r.text = fromCrop.text ?? fromLine.text
        }
        return r
    }

    // MARK: まとめ

    /// 全画面を読んでサイドカーを作る。設定した読み取り領域で価格が読めていればそれを優先する（source = "region"）
    public static func analyze(image: CGImage, windowTitle: String?, capturedAt: Date?, regionShot: Shot?) -> OCRSidecar {
        let items = recognize(image)
        let label = priceByLabel(image: image, items: items)
        var auto = AutoRead(priceTime: label?.time,
                            symbol: symbol(fromTitle: windowTitle) ?? SymbolParser.extract(regionShot?.symbolText))
        if let p = regionShot?.price {
            auto.price = p
            auto.priceText = regionShot?.priceText
            auto.source = "region"
        } else if let p = label?.price {
            auto.price = p
            auto.priceText = label?.text
            auto.source = "label"
        }
        return OCRSidecar(width: image.width, height: image.height, capturedAt: capturedAt.map(JST.format),
                          windowTitle: windowTitle, auto: auto, items: items)
    }

    /// Vision の初回はモデルの読み込みで十数秒かかる（実測）ので、起動直後に小さな画像で 1 回読んでおく
    public static func warmUp() {
        let w = 64, h = 24
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return }
        ctx.setFillColor(CGColor(gray: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        guard let img = ctx.makeImage() else { return }
        _ = recognize(img)
        _ = TextReader.read(img, region: nil)
    }
}

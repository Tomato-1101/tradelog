import Foundation

// docs/paper-events.md（イベント契約）の Swift 表現。契約が正で、ここはそれに合わせる。
// 価格・数量は文字列の 10 進数のまま持つ（浮動小数を経由させない）。

public enum EventType: String, Codable, Sendable {
    case order
    case fillMark = "fill_mark"
    case cancel
    case memo
}

public enum Intent: String, Codable, Sendable { case open, add, close }

public enum Side: String, Codable, Sendable {
    case buy, sell
    public var opposite: Side { self == .buy ? .sell : .buy }
    public var label: String { self == .buy ? "買" : "売" }
}

public enum OrderType: String, Codable, Sendable, CaseIterable {
    case market, limit
    public var label: String { self == .market ? "成行" : "指値" }
}

public struct Shot: Codable, Equatable, Sendable {
    public var path: String
    public var priceText: String?
    public var price: String?
    public var symbolText: String?
    public var confidence: Double?

    public init(path: String, priceText: String? = nil, price: String? = nil, symbolText: String? = nil, confidence: Double? = nil) {
        self.path = path
        self.priceText = priceText
        self.price = price
        self.symbolText = symbolText
        self.confidence = confidence
    }

    enum CodingKeys: String, CodingKey {
        case path
        case priceText = "price_text"
        case price
        case symbolText = "symbol_text"
        case confidence
    }

    // 契約上 null を明示するキーは省略せず null で書く（合成実装は nil を省略してしまう）
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(path, forKey: .path)
        try c.encode(priceText, forKey: .priceText)
        try c.encode(price, forKey: .price)
        try c.encode(symbolText, forKey: .symbolText)
        try c.encode(confidence, forKey: .confidence)
    }
}

public struct OrderEvent: Equatable, Sendable {
    public var id: UUID
    public var ts: Date
    public var positionID: UUID
    public var intent: Intent
    public var symbol: String
    public var side: Side
    public var qty: String
    public var orderType: OrderType
    public var limitPrice: String?
    public var shot: Shot?

    public init(id: UUID = UUID(), ts: Date, positionID: UUID, intent: Intent, symbol: String, side: Side,
                qty: String, orderType: OrderType, limitPrice: String? = nil, shot: Shot? = nil) {
        self.id = id
        self.ts = ts
        self.positionID = positionID
        self.intent = intent
        self.symbol = symbol
        self.side = side
        self.qty = qty
        self.orderType = orderType
        self.limitPrice = limitPrice
        self.shot = shot
    }
}

public struct RefEvent: Equatable, Sendable {  // fill_mark / cancel
    public var id: UUID
    public var ts: Date
    public var orderID: UUID
    public init(id: UUID = UUID(), ts: Date, orderID: UUID) {
        self.id = id
        self.ts = ts
        self.orderID = orderID
    }
}

public struct MemoEvent: Equatable, Sendable {
    public var id: UUID
    public var ts: Date
    public var positionID: UUID
    public var orderID: UUID?
    public var text: String
    public init(id: UUID = UUID(), ts: Date, positionID: UUID, orderID: UUID? = nil, text: String) {
        self.id = id
        self.ts = ts
        self.positionID = positionID
        self.orderID = orderID
        self.text = text
    }
}

public enum PaperEvent: Equatable, Sendable {
    case order(OrderEvent)
    case fillMark(RefEvent)
    case cancel(RefEvent)
    case memo(MemoEvent)

    public var id: UUID {
        switch self {
        case .order(let e): return e.id
        case .fillMark(let e), .cancel(let e): return e.id
        case .memo(let e): return e.id
        }
    }

    public var ts: Date {
        switch self {
        case .order(let e): return e.ts
        case .fillMark(let e), .cancel(let e): return e.ts
        case .memo(let e): return e.ts
        }
    }
}

extension PaperEvent: Codable {
    enum Keys: String, CodingKey {
        case v, id, type, ts
        case positionID = "position_id"
        case intent, symbol, side, qty
        case orderType = "order_type"
        case limitPrice = "limit_price"
        case shot
        case orderID = "order_id"
        case text
    }

    public static let contractVersion = 1

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(Self.contractVersion, forKey: .v)
        try c.encode(id.uuidString.lowercased(), forKey: .id)
        try c.encode(JST.format(ts), forKey: .ts)
        switch self {
        case .order(let e):
            try c.encode(EventType.order, forKey: .type)
            try c.encode(e.positionID.uuidString.lowercased(), forKey: .positionID)
            try c.encode(e.intent, forKey: .intent)
            try c.encode(e.symbol, forKey: .symbol)
            try c.encode(e.side, forKey: .side)
            try c.encode(e.qty, forKey: .qty)
            try c.encode(e.orderType, forKey: .orderType)
            try c.encode(e.limitPrice, forKey: .limitPrice)
            try c.encode(e.shot, forKey: .shot)
        case .fillMark(let e):
            try c.encode(EventType.fillMark, forKey: .type)
            try c.encode(e.orderID.uuidString.lowercased(), forKey: .orderID)
        case .cancel(let e):
            try c.encode(EventType.cancel, forKey: .type)
            try c.encode(e.orderID.uuidString.lowercased(), forKey: .orderID)
        case .memo(let e):
            try c.encode(EventType.memo, forKey: .type)
            try c.encode(e.positionID.uuidString.lowercased(), forKey: .positionID)
            try c.encode(e.orderID?.uuidString.lowercased(), forKey: .orderID)
            try c.encode(e.text, forKey: .text)
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        func uuid(_ k: Keys) throws -> UUID {
            let s = try c.decode(String.self, forKey: k)
            guard let u = UUID(uuidString: s) else {
                throw DecodingError.dataCorruptedError(forKey: k, in: c, debugDescription: "UUID ではない: \(s)")
            }
            return u
        }
        let id = try uuid(.id)
        let tsText = try c.decode(String.self, forKey: .ts)
        guard let ts = JST.parse(tsText) else {
            throw DecodingError.dataCorruptedError(forKey: .ts, in: c, debugDescription: "ts が読めない: \(tsText)")
        }
        switch try c.decode(EventType.self, forKey: .type) {
        case .order:
            self = .order(OrderEvent(
                id: id, ts: ts,
                positionID: try uuid(.positionID),
                intent: try c.decode(Intent.self, forKey: .intent),
                symbol: try c.decode(String.self, forKey: .symbol),
                side: try c.decode(Side.self, forKey: .side),
                qty: try c.decode(String.self, forKey: .qty),
                orderType: try c.decode(OrderType.self, forKey: .orderType),
                limitPrice: try c.decodeIfPresent(String.self, forKey: .limitPrice),
                shot: try c.decodeIfPresent(Shot.self, forKey: .shot)))
        case .fillMark:
            self = .fillMark(RefEvent(id: id, ts: ts, orderID: try uuid(.orderID)))
        case .cancel:
            self = .cancel(RefEvent(id: id, ts: ts, orderID: try uuid(.orderID)))
        case .memo:
            let orderID = try c.decodeIfPresent(String.self, forKey: .orderID).flatMap(UUID.init(uuidString:))
            self = .memo(MemoEvent(id: id, ts: ts, positionID: try uuid(.positionID), orderID: orderID,
                                   text: try c.decode(String.self, forKey: .text)))
        }
    }
}

public enum EventCoding {
    /// 1 イベント = 1 行（末尾の改行は含まない）
    public static func line(_ event: PaperEvent) throws -> String {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try enc.encode(event)
        return String(decoding: data, as: UTF8.self)
    }

    public static func decode(line: String) throws -> PaperEvent {
        try JSONDecoder().decode(PaperEvent.self, from: Data(line.utf8))
    }
}

/// 時刻は常に JST（+09:00）のミリ秒付き ISO8601 で書く
public enum JST {
    public static let timeZone = TimeZone(identifier: "Asia/Tokyo")!

    private static func makeFormatter(_ format: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = timeZone
        f.dateFormat = format
        return f
    }

    private static let tsFormatter = makeFormatter("yyyy-MM-dd'T'HH:mm:ss.SSSxxx")
    private static let dayFormatter = makeFormatter("yyyy-MM-dd")
    private static let clockFormatter = makeFormatter("HH:mm:ss")

    public static func format(_ date: Date) -> String { tsFormatter.string(from: date) }
    public static func parse(_ text: String) -> Date? { tsFormatter.date(from: text) }
    public static func day(_ date: Date) -> String { dayFormatter.string(from: date) }
    public static func clock(_ date: Date) -> String { clockFormatter.string(from: date) }

    /// 押した瞬間の時刻。ミリ秒未満を切り捨てて、書いた値と内部の値を一致させる
    public static func nowMillis() -> Date {
        let t = Date().timeIntervalSince1970
        return Date(timeIntervalSince1970: (t * 1000).rounded(.down) / 1000)
    }
}

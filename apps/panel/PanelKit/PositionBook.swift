import Foundation

/// events.jsonl を頭から再生して、建玉と待機中の指値を復元する（再起動しても状態が戻る）。
/// 成行は押した時点で約定したものとして数量に反映する（価格は shot.price。読めなければ平均建値は不明）。
/// 指値は fill_mark が来た時点で数量に反映する（価格は指値）。
public struct Position: Identifiable, Equatable, Sendable {
    public let id: UUID            // position_id
    public let symbol: String
    public let direction: Side     // buy = 買い建て, sell = 売り建て（空売り）
    public var qty: Decimal = 0
    /// 平均建値。約定価格が 1 つでも不明なら nil
    public var avgPrice: Decimal?
    public var priceUnknown = false
    public var openedAt: Date?     // 最初に約定した時刻
    public var closedAt: Date?     // 全数決済した時刻
    public var everFilled = false
    public var pendingCloseQty: Decimal = 0
    public var lastActivity: Date
    public var lastOrderID: UUID?

    public var isOpen: Bool { qty > 0 }
    /// 決済に回せる残り（待機中の決済指値の分を除く）
    public var closableQty: Decimal { max(qty - pendingCloseQty, 0) }
}

public struct PositionBook: Equatable, Sendable {
    public private(set) var positions: [UUID: Position] = [:]
    /// 待機中の指値（発注順）
    public private(set) var pendingLimits: [OrderEvent] = []
    /// 再生中に辻褄が合わなかった行の説明（画面に件数を出す）
    public private(set) var warnings: [String] = []

    public init() {}

    public static func replay(_ events: [PaperEvent]) -> PositionBook {
        var b = PositionBook()
        for e in events { b.apply(e) }
        return b
    }

    /// 保有中の建玉（建てた順）
    public var openPositions: [Position] {
        positions.values.filter(\.isOpen).sorted { ($0.openedAt ?? $0.lastActivity) < ($1.openedAt ?? $1.lastActivity) }
    }

    /// メモの対象にできる建玉（最近触った順）
    public var memoTargets: [Position] {
        positions.values.sorted { $0.lastActivity > $1.lastActivity }
    }

    /// 同じ銘柄・同じ向きで保有中の建玉（あれば買い増し／売り増しの対象）
    public func openPosition(symbol: String, direction: Side) -> Position? {
        openPositions.last { $0.symbol == symbol && $0.direction == direction }
    }

    public func pendingOrders(for positionID: UUID) -> [OrderEvent] {
        pendingLimits.filter { $0.positionID == positionID }
    }

    public mutating func apply(_ event: PaperEvent) {
        switch event {
        case .order(let o):
            applyOrder(o)
        case .fillMark(let r):
            guard let i = pendingLimits.firstIndex(where: { $0.id == r.orderID }) else {
                warnings.append("fill_mark の対象の指値が待機中に無い: \(r.orderID)")
                return
            }
            let o = pendingLimits.remove(at: i)
            if o.intent == .close { positions[o.positionID]?.pendingCloseQty -= Decimal(contract: o.qty) ?? 0 }
            fill(o, price: Decimal(contract: o.limitPrice), at: r.ts)
        case .cancel(let r):
            guard let i = pendingLimits.firstIndex(where: { $0.id == r.orderID }) else {
                warnings.append("cancel の対象の指値が待機中に無い: \(r.orderID)")
                return
            }
            let o = pendingLimits.remove(at: i)
            guard var p = positions[o.positionID] else { return }
            if o.intent == .close { p.pendingCloseQty -= Decimal(contract: o.qty) ?? 0 }
            p.lastActivity = r.ts
            // 一度も約定せず、他に待機中の注文も無い新規建ては、建玉そのものが無かったことになる
            if !p.everFilled && pendingOrders(for: p.id).isEmpty {
                positions[p.id] = nil
            } else {
                positions[p.id] = p
            }
        case .memo(let m):
            if var p = positions[m.positionID] {
                p.lastActivity = max(p.lastActivity, m.ts)
                positions[m.positionID] = p
            }
        }
    }

    private mutating func applyOrder(_ o: OrderEvent) {
        guard let q = Decimal(contract: o.qty), q > 0 else {
            warnings.append("数量が読めない注文: \(o.id)")
            return
        }
        switch o.intent {
        case .open:
            if positions[o.positionID] == nil {
                positions[o.positionID] = Position(id: o.positionID, symbol: o.symbol, direction: o.side, lastActivity: o.ts)
            }
        case .add, .close:
            guard let p = positions[o.positionID] else {
                warnings.append("\(o.intent.rawValue) の対象の建玉が無い: \(o.positionID)")
                return
            }
            let expected = o.intent == .add ? p.direction : p.direction.opposite
            if o.side != expected { warnings.append("建玉の向きと合わない \(o.intent.rawValue): \(o.id)") }
        }
        positions[o.positionID]?.lastActivity = o.ts
        positions[o.positionID]?.lastOrderID = o.id
        switch o.orderType {
        case .market:
            fill(o, price: Decimal(contract: o.shot?.price), at: o.ts)
        case .limit:
            pendingLimits.append(o)
            if o.intent == .close { positions[o.positionID]?.pendingCloseQty += q }
        }
    }

    private mutating func fill(_ o: OrderEvent, price: Decimal?, at ts: Date) {
        guard var p = positions[o.positionID], let q = Decimal(contract: o.qty) else { return }
        p.lastActivity = max(p.lastActivity, ts)
        switch o.intent {
        case .open, .add:
            if let price, !p.priceUnknown {
                let cost = (p.avgPrice ?? 0) * p.qty + price * q
                p.avgPrice = cost / (p.qty + q)
            } else {
                p.priceUnknown = true
                p.avgPrice = nil
            }
            p.qty += q
            p.everFilled = true
            if p.openedAt == nil { p.openedAt = ts }
            p.closedAt = nil
        case .close:
            if q > p.qty {
                warnings.append("保有より多い決済: \(o.id)")
                p.qty = 0
            } else {
                p.qty -= q
            }
            if p.qty == 0 { p.closedAt = ts }
        }
        positions[p.id] = p
    }
}

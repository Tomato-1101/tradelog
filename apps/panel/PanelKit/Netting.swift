import Foundation

/// 大きな「買い」「売り」を押した時に何を書くか（1 銘柄に建玉は 1 つ。両建てしない）。
///
/// 決め方（docs/paper-events.md「両建て禁止とドテン」と同じ）:
/// 1. 保有なし → 同じ向きの未約定の新規指値が待機中ならその建玉へ add、無ければ open。
/// 2. 保有と同じ向き → add。
/// 3. 保有と反対向き → 決済可能数（保有 − 待機中の決済指値）以内なら close。
///    超えるなら、その建玉の待機中の決済指値を取り消して保有全数で判断する:
///    保有未満 = 一部決済、保有と同数 = 全決済、保有超 = ドテン（close 保有数 + open 超過分の 2 行、同じ ts）。
/// 待機中の新規・買い増しの指値で、約定すると今回の結果と反対向きの建玉ができるもの（= 今回と反対向きの open/add）は取り消す。
/// ただし一部決済の時は、残る建玉の買い増し指値をそのまま残す。ドテンの 2 行の片方を取り消す時はもう片方も取り消す。
/// 決済指値の「約定した」で建玉が 0 になった時も、その建玉に残る新規・買い増し指値を同じ ts で取り消す（refEvents）。
/// この結果、1 銘柄の待機中の新規・買い増し指値は常に保有（または今回）と同じ向きだけになり、どの順に約定しても両建てにならない。
public struct OrderPlan: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case open
        case add(held: Decimal)
        /// remaining = 決済後の残り（0 = 全決済）
        case close(remaining: Decimal)
        case flip(closeQty: Decimal, openQty: Decimal)
    }

    public var kind: Kind
    public var side: Side
    public var qty: Decimal
    /// 取り消す待機中の指値（cancel を書く）
    public var cancels: [OrderEvent]
    /// 書く order（ドテンなら close → open の 2 行。ts は同じ、id は別）
    public var orders: [OrderEvent]

    public var isFlip: Bool { if case .flip = kind { return true } else { return false } }

    /// 押す前に小窓に出す 1 行（例「売り 300 → 決済 200・新規売り 100（ドテン）」）
    public var summary: String {
        let head = "\(side == .buy ? "買い" : "売り") \(qty.contractString) → "
        let body: String
        switch kind {
        case .open:
            body = side == .buy ? "新規買い" : "新規売り（空売り）"
        case .add(let held):
            let word = side == .buy ? "買い増し" : "売り増し"
            body = held > 0 ? "\(word)（保有 \(held.contractString) ＋ \(qty.contractString)）" : "\(word)（待機中の指値に追加）"
        case .close(let remaining):
            body = remaining == 0 ? "全決済" : "一部決済（残り \(remaining.contractString)）"
        case .flip(let c, let o):
            body = "決済 \(c.contractString)・新規\(side == .buy ? "買い" : "売り") \(o.contractString)（ドテン）"
        }
        return head + body + (cancels.isEmpty ? "" : "・待機中の指値 \(cancels.count) 件を取消")
    }

    /// 書く内容が同じか（ドテンの確認用）。id・ts と新しい建玉の position_id は押すたびに変わるので比べない
    public func sameEffect(as other: OrderPlan) -> Bool {
        func key(_ o: OrderEvent) -> String {
            [o.intent.rawValue, o.intent == .open ? "" : o.positionID.uuidString, o.symbol, o.side.rawValue, o.qty,
             o.orderType.rawValue, o.limitPrice ?? ""].joined(separator: "|")
        }
        return kind == other.kind && side == other.side && qty == other.qty
            && cancels.map(\.id) == other.cancels.map(\.id) && orders.map(key) == other.orders.map(key)
    }
}

extension PositionBook {
    /// 同じ銘柄の保有中の建玉のうち、今回の発注で相手にする 1 つ。
    /// 新ルールでは 1 つしか無い。旧ルールで両建てが残っている時は、反対向き（決済になる方）の新しい方を優先する
    func netTarget(symbol: String, side: Side) -> Position? {
        let open = openPositions.filter { $0.symbol == symbol }
        return open.last { $0.direction == side.opposite } ?? open.last { $0.direction == side }
    }

    /// ドテンの 2 行（同じ ts・同じ銘柄・同じ向き・同じ指値の close と open）の相方で、まだ待機中のもの
    public func flipPartner(of orderID: UUID) -> OrderEvent? {
        guard let o = pendingLimits.first(where: { $0.id == orderID }) else { return nil }
        return pendingLimits.first {
            $0.id != o.id && $0.ts == o.ts && $0.symbol == o.symbol && $0.side == o.side && $0.limitPrice == o.limitPrice
                && Set([$0.intent, o.intent]) == Set([.close, .open])
        }
    }

    /// 取り消す指値の一覧に、ドテンの相方を足す（発注順を保つ）
    func withFlipPartners(_ orders: [OrderEvent]) -> [OrderEvent] {
        var ids = Set(orders.map(\.id))
        for o in orders { if let p = flipPartner(of: o.id) { ids.insert(p.id) } }
        return pendingLimits.filter { ids.contains($0.id) }
    }

    /// 待機中の指値の「約定した」「取消」で書く行（すべて同じ ts。純粋関数）。対象が待機中に無ければ空。
    /// - ドテンの 2 行の片方なら相方も一緒に（片方だけだと両建てになる）
    /// - 決済指値の約定で建玉が 0 になるなら、その建玉に残る新規・買い増し指値を続けて取り消す
    ///   （全決済・ドテンの発注と同じ規則。残すと、後の約定で同じ銘柄に建玉が 2 つでき、反対売買で両建てになる）
    public func refEvents(orderID: UUID, fill: Bool, ts: Date) -> [PaperEvent] {
        guard let o = pendingLimits.first(where: { $0.id == orderID }) else { return [] }
        let targets = withFlipPartners([o])
        let refs = targets.map { fill ? PaperEvent.fillMark(RefEvent(ts: ts, orderID: $0.id)) : .cancel(RefEvent(ts: ts, orderID: $0.id)) }
        guard fill else { return refs }
        var after = self
        for e in refs { after.apply(e) }
        let emptied = Set(targets.filter { $0.intent == .close && after.positions[$0.positionID]?.isOpen == false }.map(\.positionID))
        let leftovers = after.pendingLimits.filter { emptied.contains($0.positionID) && $0.intent != .close }
        return refs + leftovers.map { .cancel(RefEvent(ts: ts, orderID: $0.id)) }
    }

    /// 押した時に書く内容を決める（純粋関数。書き込みはしない）。数量が正の整数でなければ nil。
    /// target を渡すと、その建玉を相手にする（建玉の行の「全決済」用）
    public func plan(symbol: String, side: Side, qty: String, orderType: OrderType, limitPrice: String?, ts: Date,
                     target targetID: UUID? = nil, makeID: () -> UUID = UUID.init) -> OrderPlan? {
        guard let q = Decimal(contract: qty), q > 0 else { return nil }
        let pending = pendingLimits.filter { $0.symbol == symbol }
        let target = targetID.flatMap { id in positions[id].flatMap { $0.isOpen ? $0 : nil } } ?? netTarget(symbol: symbol, side: side)

        func order(_ pos: UUID, _ intent: Intent, _ qty: Decimal) -> OrderEvent {
            OrderEvent(id: makeID(), ts: ts, positionID: pos, intent: intent, symbol: symbol, side: side, qty: qty.contractString,
                       orderType: orderType, limitPrice: orderType == .limit ? limitPrice : nil)
        }
        /// 今回と反対向きの新規・買い増しの指値（約定すると反対向きの建玉ができる）
        let oppositeEntries = pending.filter { $0.side == side.opposite && $0.intent != .close }

        guard let p = target else {
            // 保有なし: 同じ向きの未約定の新規指値があれば、その建玉へ足す（同じ銘柄に建玉を 2 つ作らない）
            let cancels = withFlipPartners(oppositeEntries)
            let cancelled = Set(cancels.map(\.id))
            let waiting = pending.last {
                !cancelled.contains($0.id) && $0.side == side && $0.intent != .close
                    && positions[$0.positionID].map { !$0.everFilled && $0.direction == side } == true
            }
            if let w = waiting {
                return OrderPlan(kind: .add(held: 0), side: side, qty: q, cancels: cancels, orders: [order(w.positionID, .add, q)])
            }
            return OrderPlan(kind: .open, side: side, qty: q, cancels: cancels, orders: [order(UUID(), .open, q)])
        }

        if p.direction == side {
            return OrderPlan(kind: .add(held: p.qty), side: side, qty: q, cancels: withFlipPartners(oppositeEntries),
                             orders: [order(p.id, .add, q)])
        }

        // 保有と反対向き = 決済（超えればドテン）
        let reservedCloses = pending.filter { $0.intent == .close && $0.positionID == p.id }
        var cancels: [OrderEvent] = []
        if q > p.closableQty {
            // 待機中の決済指値の分まで食い込む → その指値は取り消して保有全数で決める
            cancels += reservedCloses
        }
        if q >= p.qty {
            // 全決済・ドテンで建玉が終わる → 残しておくと後で反対向きに建つ指値（その建玉の買い増し等）も取り消す
            cancels += oppositeEntries
        }
        cancels = withFlipPartners(cancels)
        if q <= p.qty {
            return OrderPlan(kind: .close(remaining: p.qty - q), side: side, qty: q, cancels: cancels, orders: [order(p.id, .close, q)])
        }
        let closeRow = order(p.id, .close, p.qty)
        let openRow = order(UUID(), .open, q - p.qty)
        return OrderPlan(kind: .flip(closeQty: p.qty, openQty: q - p.qty), side: side, qty: q, cancels: cancels,
                         orders: [closeRow, openRow])
    }
}

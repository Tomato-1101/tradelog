import XCTest
@testable import PanelKit

/// 1 銘柄に建玉 1 つ（ネッティング）: 大きな「買い」「売り」を押した時に書く内容（PositionBook.plan）
final class NettingTests: XCTestCase {
    let t0 = JST.parse("2026-10-05T09:00:00.000+09:00")!
    private func at(_ s: Double) -> Date { t0.addingTimeInterval(s) }

    private func market(_ pos: UUID, _ intent: Intent, _ side: Side, _ qty: String, _ s: Double, symbol: String = "5803") -> PaperEvent {
        .order(OrderEvent(ts: at(s), positionID: pos, intent: intent, symbol: symbol, side: side, qty: qty, orderType: .market,
                          shot: Shot(path: "shots/x.png", priceText: "5,566", price: "5566")))
    }

    private func limit(_ pos: UUID, _ intent: Intent, _ side: Side, _ qty: String, _ s: Double, price: String = "5600",
                       symbol: String = "5803") -> OrderEvent {
        OrderEvent(ts: at(s), positionID: pos, intent: intent, symbol: symbol, side: side, qty: qty, orderType: .limit,
                   limitPrice: price, shot: nil)
    }

    private func plan(_ b: PositionBook, _ side: Side, _ qty: String, type: OrderType = .market, price: String? = nil,
                      ts: Double = 100) -> OrderPlan {
        b.plan(symbol: "5803", side: side, qty: qty, orderType: type, limitPrice: price, ts: at(ts))!
    }

    /// 計画どおりに書いた後の建玉（取消 → order の順に再生）
    private func after(_ events: [PaperEvent], _ p: OrderPlan) -> PositionBook {
        let ts = p.orders[0].ts
        return PositionBook.replay(events + p.cancels.map { .cancel(RefEvent(ts: ts, orderID: $0.id)) } + p.orders.map(PaperEvent.order))
    }

    func testFlatOpensNewPosition() {
        let p = plan(PositionBook(), .sell, "100")
        XCTAssertEqual(p.kind, .open)
        XCTAssertEqual(p.orders.map(\.intent), [.open])
        XCTAssertEqual(p.summary, "売り 100 → 新規売り（空売り）")
        XCTAssertNil(PositionBook().plan(symbol: "5803", side: .buy, qty: "0", orderType: .market, limitPrice: nil, ts: t0))
    }

    func testSameDirectionAddsToTheOnePosition() {
        let pid = UUID()
        let events = [market(pid, .open, .buy, "100", 0)]
        let p = plan(PositionBook.replay(events), .buy, "100")
        XCTAssertEqual(p.kind, .add(held: 100))
        XCTAssertEqual(p.orders.map(\.positionID), [pid])
        XCTAssertEqual(p.orders.map(\.intent), [.add])
        XCTAssertEqual(p.summary, "買い 100 → 買い増し（保有 100 ＋ 100）")
        XCTAssertEqual(after(events, p).positions[pid]?.qty, 200)
    }

    func testOppositeWithinHoldingClosesFullyOrPartially() {
        let pid = UUID()
        let events = [market(pid, .open, .buy, "100", 0), market(pid, .add, .buy, "100", 1)]
        let book = PositionBook.replay(events)

        let full = plan(book, .sell, "200")
        XCTAssertEqual(full.kind, .close(remaining: 0))
        XCTAssertEqual(full.summary, "売り 200 → 全決済")
        XCTAssertEqual(full.orders.map(\.positionID), [pid])
        XCTAssertTrue(after(events, full).openPositions.isEmpty)

        let partial = plan(book, .sell, "100")
        XCTAssertEqual(partial.kind, .close(remaining: 100))
        XCTAssertEqual(partial.summary, "売り 100 → 一部決済（残り 100）")
        XCTAssertEqual(after(events, partial).positions[pid]?.qty, 100)
    }

    func testExceedingHoldingFlipsWithTwoRowsAtSameTime() {
        let pid = UUID()
        let events = [market(pid, .open, .buy, "200", 0)]
        let p = plan(PositionBook.replay(events), .sell, "300")
        XCTAssertEqual(p.kind, .flip(closeQty: 200, openQty: 100))
        XCTAssertTrue(p.isFlip)
        XCTAssertEqual(p.summary, "売り 300 → 決済 200・新規売り 100（ドテン）")
        XCTAssertEqual(p.orders.count, 2)
        XCTAssertEqual(p.orders.map(\.intent), [.close, .open])
        XCTAssertEqual(p.orders.map(\.qty), ["200", "100"])
        XCTAssertEqual(p.orders.map(\.side), [.sell, .sell])
        XCTAssertEqual(p.orders[0].positionID, pid)
        XCTAssertNotEqual(p.orders[1].positionID, pid)
        XCTAssertEqual(p.orders[0].ts, p.orders[1].ts)
        XCTAssertNotEqual(p.orders[0].id, p.orders[1].id)

        let b = after(events, p)
        XCTAssertEqual(b.openPositions.count, 1)
        XCTAssertEqual(b.openPositions.first?.direction, .sell)
        XCTAssertEqual(b.openPositions.first?.qty, 100)
        XCTAssertTrue(b.warnings.isEmpty, "\(b.warnings)")
    }

    // MARK: 待機中の指値の扱い

    /// 保有なしで買いの新規指値が待機中 → 売りを押したら、その買い指値は取り消す（後で約定すると両建てになるため）
    func testFlatWithOppositeEntryLimitCancelsIt() {
        let pending = limit(UUID(), .open, .buy, "100", 0)
        let events: [PaperEvent] = [.order(pending)]
        let p = plan(PositionBook.replay(events), .sell, "100")
        XCTAssertEqual(p.kind, .open)
        XCTAssertEqual(p.cancels.map(\.id), [pending.id])
        XCTAssertTrue(p.summary.hasSuffix("・待機中の指値 1 件を取消"), p.summary)
        XCTAssertTrue(after(events, p).pendingLimits.isEmpty)
    }

    /// 保有なしで同じ向きの新規指値が待機中 → もう一本はその建玉への add（同じ銘柄に建玉を 2 つ作らない）
    func testFlatWithSameEntryLimitAddsToIt() {
        let pending = limit(UUID(), .open, .buy, "100", 0)
        let p = plan(PositionBook.replay([.order(pending)]), .buy, "100", type: .limit, price: "5590")
        XCTAssertEqual(p.kind, .add(held: 0))
        XCTAssertEqual(p.orders.map(\.positionID), [pending.positionID])
        XCTAssertEqual(p.orders.map(\.intent), [.add])
        XCTAssertTrue(p.cancels.isEmpty)
        XCTAssertEqual(p.summary, "買い 100 → 買い増し（待機中の指値に追加）")
    }

    /// 決済指値が待機中: 残りの決済可能数以内ならそのまま、超えたら決済指値を取り消して保有全数で判断する
    func testReservedCloseLimitIsCancelledOnlyWhenNeeded() {
        let pid = UUID()
        let reserved = limit(pid, .close, .sell, "100", 1)
        let events: [PaperEvent] = [market(pid, .open, .buy, "200", 0), .order(reserved)]
        let book = PositionBook.replay(events)

        let within = plan(book, .sell, "100")
        XCTAssertEqual(within.kind, .close(remaining: 100))
        XCTAssertTrue(within.cancels.isEmpty)

        let beyond = plan(book, .sell, "150")
        XCTAssertEqual(beyond.kind, .close(remaining: 50))
        XCTAssertEqual(beyond.cancels.map(\.id), [reserved.id])
        XCTAssertEqual(after(events, beyond).positions[pid]?.qty, 50)
        XCTAssertTrue(after(events, beyond).pendingLimits.isEmpty)
    }

    /// 保有と同じ向きの買い増し指値: 一部決済なら残す、全決済・ドテンなら取り消す（建玉が終わった後に約定すると逆向きになる）
    func testAddLimitSurvivesPartialCloseButNotFullCloseOrFlip() {
        let pid = UUID()
        let add = limit(pid, .add, .buy, "100", 1, price: "5500")
        let events: [PaperEvent] = [market(pid, .open, .buy, "200", 0), .order(add)]
        let book = PositionBook.replay(events)

        XCTAssertTrue(plan(book, .sell, "100").cancels.isEmpty)
        XCTAssertEqual(plan(book, .sell, "200").cancels.map(\.id), [add.id])
        let flip = plan(book, .sell, "300")
        XCTAssertTrue(flip.isFlip)
        XCTAssertEqual(flip.cancels.map(\.id), [add.id])
        XCTAssertTrue(after(events, flip).pendingLimits.isEmpty)
    }

    /// 待機中のドテン指値（2 行）は片方だけ取り消さない
    func testPendingFlipPairIsCancelledTogether() {
        let pid = UUID()
        let closeRow = limit(pid, .close, .sell, "200", 1)
        let openRow = limit(UUID(), .open, .sell, "100", 1)
        let events: [PaperEvent] = [market(pid, .open, .buy, "200", 0), .order(closeRow), .order(openRow)]
        let book = PositionBook.replay(events)
        XCTAssertEqual(book.flipPartner(of: closeRow.id)?.id, openRow.id)
        XCTAssertEqual(book.flipPartner(of: openRow.id)?.id, closeRow.id)

        // 買い増し（保有と同じ向き）を押すと、反対向きの新規（ドテンの open 側）を取り消す → close 側も一緒に
        let p = plan(book, .buy, "100")
        XCTAssertEqual(p.kind, .add(held: 200))
        XCTAssertEqual(p.cancels.map(\.id), [closeRow.id, openRow.id])
        XCTAssertTrue(after(events, p).pendingLimits.isEmpty)
    }

    /// 建玉の行の「全決済」は、その建玉を相手に保有全数を決済する
    func testTargetedFullClose() {
        let pid = UUID()
        let events = [market(pid, .open, .sell, "300", 0)]
        let book = PositionBook.replay(events)
        let p = book.plan(symbol: "5803", side: .buy, qty: "300", orderType: .market, limitPrice: nil, ts: at(10), target: pid)!
        XCTAssertEqual(p.kind, .close(remaining: 0))
        XCTAssertEqual(p.summary, "買い 300 → 全決済")
    }

    // MARK: 「約定した」「取消」で書く行（refEvents）

    /// 決済指値の約定で建玉が 0 になる → その建玉に残る買い増し指値も同じ ts で取り消す（一部決済なら残す）
    func testCloseFillToZeroCancelsLeftoverEntryLimits() {
        let pid = UUID()
        let closeAll = limit(pid, .close, .sell, "100", 1, price: "5700")
        let add = limit(pid, .add, .buy, "100", 2, price: "5500")
        let events: [PaperEvent] = [market(pid, .open, .buy, "100", 0), .order(closeAll), .order(add)]
        let book = PositionBook.replay(events)
        let refs = book.refEvents(orderID: closeAll.id, fill: true, ts: at(10))
        XCTAssertEqual(refs, [.fillMark(RefEvent(id: refs[0].id, ts: at(10), orderID: closeAll.id)),
                              .cancel(RefEvent(id: refs[1].id, ts: at(10), orderID: add.id))])
        let b = PositionBook.replay(events + refs)
        XCTAssertTrue(b.pendingLimits.isEmpty)
        XCTAssertTrue(b.warnings.isEmpty, "\(b.warnings)")

        // 取消なら何も足さない
        XCTAssertEqual(book.refEvents(orderID: closeAll.id, fill: false, ts: at(10)).count, 1)
        // 一部決済の約定なら、残る建玉の買い増し指値はそのまま
        let partialClose = limit(pid, .close, .sell, "50", 1, price: "5700")
        let partial = PositionBook.replay([market(pid, .open, .buy, "100", 0), .order(partialClose), .order(add)])
        XCTAssertEqual(partial.refEvents(orderID: partialClose.id, fill: true, ts: at(10)).count, 1)
        // 待機中に無い id は空
        XCTAssertTrue(book.refEvents(orderID: UUID(), fill: true, ts: at(10)).isEmpty)
    }

    /// 指値ドテンの約定: 相方も一緒に。close で建玉が 0 になるので、その建玉の買い増し指値も取り消す
    func testFlipPairFillAlsoCancelsLeftoverAddOfClosedPosition() {
        let pid = UUID()
        let closeRow = limit(pid, .close, .sell, "200", 1)
        let openRow = limit(UUID(), .open, .sell, "100", 1)
        let add = limit(pid, .add, .buy, "100", 2, price: "5500")
        let events: [PaperEvent] = [market(pid, .open, .buy, "200", 0), .order(closeRow), .order(openRow), .order(add)]
        let refs = PositionBook.replay(events).refEvents(orderID: openRow.id, fill: true, ts: at(10))
        XCTAssertEqual(refs.map(\.id).count, 3)
        guard refs.count == 3, case .fillMark(let a) = refs[0], case .fillMark(let b) = refs[1], case .cancel(let c) = refs[2]
        else { return XCTFail("\(refs)") }
        XCTAssertEqual([a.orderID, b.orderID, c.orderID], [closeRow.id, openRow.id, add.id])
        let after = PositionBook.replay(events + refs)
        XCTAssertEqual(after.openPositions.map(\.direction), [.sell])
        XCTAssertTrue(after.pendingLimits.isEmpty)
        XCTAssertTrue(after.warnings.isEmpty, "\(after.warnings)")
    }

    /// ドテンの確認: id・ts が違っても書く内容が同じなら同じ、数量や取消対象が違えば別
    func testSameEffectComparesContentNotIds() {
        let pid = UUID()
        let book200 = PositionBook.replay([market(pid, .open, .buy, "200", 0)])
        let a = plan(book200, .sell, "300", ts: 100)
        let b = plan(book200, .sell, "300", ts: 101)
        XCTAssertNotEqual(a, b)
        XCTAssertTrue(a.sameEffect(as: b))
        let book300 = PositionBook.replay([market(pid, .open, .buy, "200", 0), market(pid, .add, .buy, "100", 1)])
        XCTAssertFalse(a.sameEffect(as: plan(book300, .sell, "300")))
        XCTAssertFalse(a.sameEffect(as: plan(book300, .sell, "400")))
        let add = limit(pid, .add, .buy, "100", 1, price: "5500")
        XCTAssertFalse(a.sameEffect(as: plan(PositionBook.replay([market(pid, .open, .buy, "200", 0), .order(add)]), .sell, "300")),
                       "取消対象が違う")
    }

    // MARK: 旧ルールの記録

    /// 旧ルールで書かれた両建て（同じ銘柄に買いと売りの建玉）も落ちずに再生でき、警告に残る
    func testLegacyHedgedEventsReplayWithWarning() throws {
        let long = UUID(), short = UUID()
        let events = [market(long, .open, .buy, "100", 0), market(short, .open, .sell, "200", 10)]
        let book = PositionBook.replay(events)
        XCTAssertEqual(book.openPositions.count, 2)
        XCTAssertTrue(book.warnings.contains { $0.contains("両建て") }, "\(book.warnings)")

        // 新しい発注は反対向き（決済になる方）を相手にする
        let p = plan(book, .sell, "100")
        XCTAssertEqual(p.kind, .close(remaining: 0))
        XCTAssertEqual(p.orders.map(\.positionID), [long])
        let p2 = plan(book, .buy, "100")
        XCTAssertEqual(p2.orders.map(\.positionID), [short])
        XCTAssertEqual(p2.kind, .close(remaining: 100))
    }
}

import XCTest
@testable import PanelKit

final class ReplayTests: XCTestCase {
    let t0 = JST.parse("2026-10-05T09:00:00.000+09:00")!

    private func at(_ s: Double) -> Date { t0.addingTimeInterval(s) }

    private func market(_ pos: UUID, _ intent: Intent, _ side: Side, _ qty: String, price: String?, _ s: Double,
                        symbol: String = "7203") -> OrderEvent {
        OrderEvent(ts: at(s), positionID: pos, intent: intent, symbol: symbol, side: side, qty: qty, orderType: .market,
                   shot: Shot(path: "shots/x.png", priceText: price, price: price))
    }

    private func limit(_ pos: UUID, _ intent: Intent, _ side: Side, _ qty: String, _ price: String, _ s: Double,
                       symbol: String = "7203") -> OrderEvent {
        OrderEvent(ts: at(s), positionID: pos, intent: intent, symbol: symbol, side: side, qty: qty, orderType: .limit,
                   limitPrice: price, shot: nil)
    }

    /// ファイルに書いて読み直したもので再生する（起動時の復元と同じ経路）
    private func replayThroughFile(_ events: [PaperEvent]) throws -> PositionBook {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let log = EventLog(folder: dir)
        for e in events { try log.append(e) }
        let r = try log.load()
        XCTAssertEqual(r.badLines, 0)
        XCTAssertEqual(r.events, events)
        return PositionBook.replay(r.events)
    }

    func testOpenAddPartialAndFullClose() throws {
        let p = UUID()
        var events: [PaperEvent] = [
            .order(market(p, .open, .buy, "100", price: "1000", 0)),
            .order(market(p, .add, .buy, "200", price: "1030", 60)),
        ]
        var b = try replayThroughFile(events)
        var pos = try XCTUnwrap(b.positions[p])
        XCTAssertEqual(pos.qty, 300)
        XCTAssertEqual(pos.avgPrice, 1020)            // (1000*100 + 1030*200) / 300
        XCTAssertEqual(pos.direction, .buy)
        XCTAssertEqual(pos.openedAt, at(0))
        XCTAssertEqual(b.openPositions.map(\.id), [p])

        // 一部決済
        events.append(.order(market(p, .close, .sell, "100", price: "1050", 120)))
        b = try replayThroughFile(events)
        pos = try XCTUnwrap(b.positions[p])
        XCTAssertEqual(pos.qty, 200)
        XCTAssertEqual(pos.avgPrice, 1020, "決済しても平均建値は変わらない")
        XCTAssertNil(pos.closedAt)

        // 全決済
        events.append(.order(market(p, .close, .sell, "200", price: "1060", 180)))
        b = try replayThroughFile(events)
        pos = try XCTUnwrap(b.positions[p])
        XCTAssertEqual(pos.qty, 0)
        XCTAssertEqual(pos.closedAt, at(180))
        XCTAssertTrue(b.openPositions.isEmpty)
        XCTAssertEqual(b.memoTargets.map(\.id), [p], "決済後もメモの対象に残る")
        XCTAssertTrue(b.warnings.isEmpty)
    }

    func testShortSellOpenWithSell() throws {
        let p = UUID()
        let events: [PaperEvent] = [
            .order(market(p, .open, .sell, "500", price: "2345.5", 0, symbol: "285A")),
            .order(market(p, .close, .buy, "500", price: "2300", 30, symbol: "285A")),
        ]
        let b1 = PositionBook.replay(Array(events.prefix(1)))
        let s = try XCTUnwrap(b1.positions[p])
        XCTAssertEqual(s.direction, .sell)
        XCTAssertEqual(s.qty, 500)
        XCTAssertEqual(s.avgPrice, Decimal(string: "2345.5"))
        XCTAssertEqual(b1.openPosition(symbol: "285A", direction: .sell)?.id, p)
        XCTAssertNil(b1.openPosition(symbol: "285A", direction: .buy))

        let b2 = try replayThroughFile(events)
        XCTAssertEqual(b2.positions[p]?.qty, 0)
        XCTAssertTrue(b2.warnings.isEmpty)
    }

    func testUnknownPriceMakesAverageUnknown() {
        let p = UUID()
        let b = PositionBook.replay([
            .order(market(p, .open, .buy, "100", price: "1000", 0)),
            .order(market(p, .add, .buy, "100", price: nil, 10)),
        ])
        XCTAssertEqual(b.positions[p]?.qty, 200)
        XCTAssertNil(b.positions[p]?.avgPrice, "1 つでも約定価格が不明なら平均建値は出さない")
    }

    func testLimitOpenWaitsForFillMark() throws {
        let p = UUID()
        let lo = limit(p, .open, .buy, "100", "990", 0)
        var events: [PaperEvent] = [.order(lo)]
        var b = try replayThroughFile(events)
        XCTAssertEqual(b.pendingLimits.map(\.id), [lo.id])
        XCTAssertTrue(b.openPositions.isEmpty, "指値は約定まで建玉にならない")
        XCTAssertEqual(b.memoTargets.map(\.id), [p], "未約定でもメモは付けられる")

        events.append(.fillMark(RefEvent(ts: at(300), orderID: lo.id)))
        b = try replayThroughFile(events)
        XCTAssertTrue(b.pendingLimits.isEmpty)
        let pos = try XCTUnwrap(b.positions[p])
        XCTAssertEqual(pos.qty, 100)
        XCTAssertEqual(pos.avgPrice, 990, "指値の約定は指値で建つ")
        XCTAssertEqual(pos.openedAt, at(300), "建玉の開始は fill_mark の時刻")
    }

    func testLimitOpenCancelRemovesPosition() throws {
        let p = UUID()
        let lo = limit(p, .open, .sell, "100", "1010", 0)
        let b = try replayThroughFile([.order(lo), .cancel(RefEvent(ts: at(5), orderID: lo.id))])
        XCTAssertTrue(b.pendingLimits.isEmpty)
        XCTAssertNil(b.positions[p], "一度も約定しなかった新規建ては消える")
        XCTAssertTrue(b.warnings.isEmpty)
    }

    func testLimitCloseReservesQtyThenFillOrCancel() throws {
        let p = UUID()
        let lc = limit(p, .close, .sell, "100", "1100", 10)
        let base: [PaperEvent] = [.order(market(p, .open, .buy, "300", price: "1000", 0)), .order(lc)]

        var b = try replayThroughFile(base)
        var pos = try XCTUnwrap(b.positions[p])
        XCTAssertEqual(pos.qty, 300)
        XCTAssertEqual(pos.closableQty, 200, "待機中の決済指値の分は決済に回せない")

        // 取消 → 予約が外れる
        b = try replayThroughFile(base + [.cancel(RefEvent(ts: at(20), orderID: lc.id))])
        pos = try XCTUnwrap(b.positions[p])
        XCTAssertEqual(pos.qty, 300)
        XCTAssertEqual(pos.closableQty, 300)
        XCTAssertNotNil(b.positions[p], "約定済みの建玉は取消で消えない")

        // fill_mark → 数量が減る
        b = try replayThroughFile(base + [.fillMark(RefEvent(ts: at(30), orderID: lc.id))])
        pos = try XCTUnwrap(b.positions[p])
        XCTAssertEqual(pos.qty, 200)
        XCTAssertEqual(pos.closableQty, 200)
        XCTAssertTrue(b.pendingLimits.isEmpty)
    }

    func testMemoDoesNotChangeQuantities() {
        let p = UUID()
        let b = PositionBook.replay([
            .order(market(p, .open, .buy, "100", price: "1000", 0)),
            .memo(MemoEvent(ts: at(5), positionID: p, text: "メモ")),
        ])
        XCTAssertEqual(b.positions[p]?.qty, 100)
        XCTAssertEqual(b.positions[p]?.lastActivity, at(5))
    }

    func testInconsistentEventsBecomeWarningsNotCrashes() {
        let b = PositionBook.replay([
            .fillMark(RefEvent(ts: at(0), orderID: UUID())),
            .order(market(UUID(), .close, .sell, "100", price: "1", 1)),
        ])
        XCTAssertEqual(b.warnings.count, 2)
        XCTAssertTrue(b.positions.isEmpty)
    }

    func testBrokenLinesAreSkipped() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let log = EventLog(folder: dir)
        let p = UUID()
        try log.append(.order(market(p, .open, .buy, "100", price: "1000", 0)))
        let h = try FileHandle(forWritingTo: log.fileURL)
        try h.seekToEnd()
        try h.write(contentsOf: Data("{\"broken\n".utf8))
        try h.close()
        try log.append(.order(market(p, .close, .sell, "100", price: "1001", 1)))
        let r = try log.load()
        XCTAssertEqual(r.badLines, 1)
        XCTAssertEqual(r.events.count, 2)
        XCTAssertEqual(PositionBook.replay(r.events).positions[p]?.qty, 0)
    }
}

import XCTest
@testable import PanelKit

/// 撮影の代わりに決まった結果を返す（実際の画面は撮らない）
final class FakeShotTaker: ShotTaking {
    var result: (UUID, Date, EventLog) -> Shot?
    var delay: TimeInterval
    var symbol: String?
    init(delay: TimeInterval = 0, result: @escaping (UUID, Date, EventLog) -> Shot?) {
        self.delay = delay
        self.result = result
    }
    func takeShot(eventID: UUID, ts: Date, log: EventLog) async -> Shot? {
        if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1e9)) }
        return result(eventID, ts, log)
    }
    func readSymbol() async -> String? { symbol }
}

@MainActor
final class StoreTests: XCTestCase {
    var dir: URL!
    var defaults: UserDefaults!

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let suite = "panel-tests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
        defaults.removePersistentDomain(forName: suite)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private func lines() throws -> [String] {
        try String(contentsOf: dir.appendingPathComponent("events.jsonl"), encoding: .utf8)
            .split(separator: "\n").map(String.init)
    }

    func testOrderFlowWritesEventsInPressOrderAndRestores() async throws {
        let settings = PanelSettings(defaults: defaults)
        // 撮影に 0.3 秒かかっても、その間に押したメモは発注の後に書かれる
        let taker = FakeShotTaker(delay: 0.3) { id, ts, log in
            Shot(path: log.shotLocation(eventID: id, ts: ts).relative, priceText: "2,345.5", price: "2345.5", symbolText: "7203", confidence: 0.9)
        }
        let store = PanelStore(settings: settings, shotTaker: taker)
        store.open(folder: dir)
        XCTAssertFalse(store.canOrder, "銘柄が空なら押せない")

        store.symbol = "7203"
        store.qtyText = "100"
        store.orderType = .market
        XCTAssertTrue(store.canOrder)
        let before = Date()
        store.placeOrder(side: .buy)

        // 押した瞬間に建玉とメモの対象が更新される
        XCTAssertEqual(store.book.openPositions.count, 1)
        let pid = try XCTUnwrap(store.book.openPositions.first?.id)
        XCTAssertEqual(store.memoTarget, pid)
        XCTAssertEqual(store.memoFocusRequest, 1)

        store.memoText = "寄り後の押し目"
        store.saveMemo()
        await store.flush()

        let ls = try lines()
        XCTAssertEqual(ls.count, 2)
        let order = try EventCoding.decode(line: ls[0])
        guard case .order(let o) = order else { return XCTFail("1 行目は order") }
        XCTAssertEqual(o.intent, .open)
        XCTAssertEqual(o.side, .buy)
        XCTAssertEqual(o.shot?.price, "2345.5")
        XCTAssertLessThan(o.ts.timeIntervalSince(before), 0.1, "ts は撮影完了ではなく押した瞬間")
        guard case .memo(let m) = try EventCoding.decode(line: ls[1]) else { return XCTFail("2 行目は memo") }
        XCTAssertEqual(m.positionID, pid)
        XCTAssertEqual(m.orderID, o.id)
        XCTAssertEqual(m.text, "寄り後の押し目")
        XCTAssertEqual(settings.lastQty, "100", "株数は前回値を覚える")

        // 同じ銘柄・同じ向きは買い増し、決済で 0 になる
        store.placeOrder(side: .buy)
        await store.flush()
        XCTAssertEqual(store.book.positions[pid]?.qty, 200)
        store.close(positionID: pid, qtyText: "200", type: .market)
        await store.flush()
        XCTAssertTrue(store.book.openPositions.isEmpty)

        // 再起動相当: 新しい store でファイルから復元
        let restored = PanelStore(settings: settings, shotTaker: taker)
        restored.open(folder: dir)
        XCTAssertEqual(restored.book, store.book)
        let intents = try lines().compactMap { line -> Intent? in
            if case .order(let o) = try EventCoding.decode(line: line) { return o.intent } else { return nil }
        }
        XCTAssertEqual(intents, [.open, .add, .close])
    }

    func testShotFailureStillRecordsOrder() async throws {
        let store = PanelStore(settings: PanelSettings(defaults: defaults), shotTaker: FakeShotTaker { _, _, _ in nil })
        store.open(folder: dir)
        store.symbol = "285A"
        store.qtyText = "300"
        store.placeOrder(side: .sell)
        await store.flush()
        let ls = try lines()
        XCTAssertEqual(ls.count, 1)
        XCTAssertTrue(ls[0].contains(#""shot":null"#))
        XCTAssertTrue(ls[0].contains(#""side":"sell""#))
        XCTAssertTrue(ls[0].contains(#""intent":"open""#), "売りの新規 = 空売り")
    }

    func testLimitFillAndCancelButtons() async throws {
        let store = PanelStore(settings: PanelSettings(defaults: defaults), shotTaker: FakeShotTaker { _, _, _ in nil })
        store.open(folder: dir)
        store.symbol = "7203"
        store.qtyText = "100"
        store.orderType = .limit
        store.limitPriceText = "abc"
        XCTAssertFalse(store.canOrder, "指値が数字でなければ押せない")
        store.limitPriceText = "2,340"
        store.placeOrder(side: .buy)
        store.placeOrder(side: .buy)
        await store.flush()
        XCTAssertEqual(store.book.pendingLimits.count, 2)
        XCTAssertEqual(store.book.pendingLimits.first?.limitPrice, "2340")

        let first = store.book.pendingLimits[0].id
        let second = store.book.pendingLimits[1].id
        store.markFilled(orderID: first)
        store.cancel(orderID: second)
        await store.flush()
        XCTAssertTrue(store.book.pendingLimits.isEmpty)
        XCTAssertEqual(store.book.openPositions.count, 1)
        XCTAssertEqual(store.book.openPositions.first?.avgPrice, 2340)

        let types = try lines().map { try EventCoding.decode(line: $0) }.map { e -> String in
            switch e {
            case .order: return "order"
            case .fillMark: return "fill_mark"
            case .cancel: return "cancel"
            case .memo: return "memo"
            }
        }
        XCTAssertEqual(types, ["order", "order", "fill_mark", "cancel"])
    }

    func testCloseCannotExceedHolding() async throws {
        let store = PanelStore(settings: PanelSettings(defaults: defaults), shotTaker: FakeShotTaker { _, _, _ in nil })
        store.open(folder: dir)
        store.symbol = "7203"
        store.qtyText = "100"
        store.placeOrder(side: .buy)
        await store.flush()
        let pid = try XCTUnwrap(store.book.openPositions.first?.id)
        store.close(positionID: pid, qtyText: "200", type: .market)
        await store.flush()
        XCTAssertEqual(try lines().count, 1, "保有を超える決済は記録しない")
        XCTAssertEqual(store.book.positions[pid]?.qty, 100)
    }

    func testSymbolAutoFillKeepsManualCorrection() async throws {
        let settings = PanelSettings(defaults: defaults)
        settings.symbolRegion = RelRect(x: 0, y: 0, w: 0.2, h: 0.1)
        let taker = FakeShotTaker { _, _, _ in nil }
        taker.symbol = "7203"
        let store = PanelStore(settings: settings, shotTaker: taker)
        store.autoReadInterval = 0
        store.autoCaptureAllowed = { true }
        store.refreshSymbolFromScreen()
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(store.symbol, "7203")

        store.symbol = "7201"  // 読み違いを手で直した
        store.refreshSymbolFromScreen()
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(store.symbol, "7201", "画面の銘柄が変わるまで手の修正を上書きしない")

        taker.symbol = "6758"  // HYPER SBI 2 側で銘柄を切り替えた
        store.refreshSymbolFromScreen()
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(store.symbol, "6758")

        store.autoCaptureAllowed = { false }  // 権限が無ければ自動では撮らない
        taker.symbol = "9984"
        store.refreshSymbolFromScreen()
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(store.symbol, "6758")
    }

    func testTimeoutReturnsNilWithoutWaitingForSlowBody() async {
        let start = Date()
        let v: Int? = await withTimeout(0.2) {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            return 1
        }
        XCTAssertNil(v)
        XCTAssertLessThan(Date().timeIntervalSince(start), 1.0)
        let fast: Int? = await withTimeout(2) { 42 }
        XCTAssertEqual(fast, 42)
    }
}

import XCTest
@testable import PanelKit

/// 撮影の代わりに決まった結果を返す（実際の画面は撮らない）
final class FakeShotTaker: ShotTaking {
    var result: (UUID, Date, EventLog) -> Shot?
    var delay: TimeInterval
    /// 発注ごとの撮影時間（nil なら delay）
    var delayFor: ((UUID) -> TimeInterval)?
    var symbol: String?
    var refreshCount = 0
    var shotIDs: [UUID] = []
    var onAutoRead: ((String, AutoRead) -> Void)?
    init(delay: TimeInterval = 0, result: @escaping (UUID, Date, EventLog) -> Shot?) {
        self.delay = delay
        self.result = result
    }
    func takeShot(eventID: UUID, ts: Date, log: EventLog) async -> Shot? {
        shotIDs.append(eventID)
        let d = delayFor?(eventID) ?? delay
        if d > 0 { try? await Task.sleep(nanoseconds: UInt64(d * 1e9)) }
        return result(eventID, ts, log)
    }
    func readSymbol() async -> String? { symbol }
    func refreshTarget() { refreshCount += 1 }
    func waitForBackground() async {}
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
        store.closeAll(positionID: pid)
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
        // 同じ銘柄に建玉を 2 つ作らない: 2 本目は待機中の建玉への買い増し
        XCTAssertEqual(store.book.pendingLimits.map(\.intent), [.open, .add])
        XCTAssertEqual(Set(store.book.pendingLimits.map(\.positionID)).count, 1)

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

    func testCloseAllClosesWholeHoldingAndCancelsItsLimits() async throws {
        let store = PanelStore(settings: PanelSettings(defaults: defaults), shotTaker: FakeShotTaker { _, _, _ in nil })
        store.open(folder: dir)
        store.symbol = "7203"
        store.qtyText = "300"
        store.placeOrder(side: .buy)
        // 決済の指値を 100 置いておく
        store.qtyText = "100"
        store.orderType = .limit
        store.limitPriceText = "2400"
        store.placeOrder(side: .sell)
        await store.flush()
        let pid = try XCTUnwrap(store.book.openPositions.first?.id)
        XCTAssertEqual(store.book.positions[pid]?.pendingCloseQty, 100)

        store.closeAll(positionID: pid)
        await store.flush()
        XCTAssertTrue(store.book.openPositions.isEmpty)
        XCTAssertTrue(store.book.pendingLimits.isEmpty, "全決済でその建玉の決済指値は取り消す")
        let last = try lines().suffix(2).map { try EventCoding.decode(line: $0) }
        guard case .cancel = last[0], case .order(let o) = last[1] else { return XCTFail("取消 → 決済の順") }
        XCTAssertEqual(o.intent, .close)
        XCTAssertEqual(o.qty, "300")
        XCTAssertEqual(o.orderType, .market)
    }

    /// ドテンは 1 回目で予告だけ、もう一度押すと close + open の 2 行を同じ ts・同じ shot で書く
    func testFlipNeedsSecondPressAndWritesTwoRowsSharingOneShot() async throws {
        let taker = FakeShotTaker { id, ts, log in
            Shot(path: log.shotLocation(eventID: id, ts: ts).relative, priceText: "5,566", price: "5566",
                 capturedAt: ts.addingTimeInterval(0.085), windowTitle: "全板　フジクラ(5803)",
                 ocrPath: log.ocrLocation(eventID: id, ts: ts).relative)
        }
        let store = PanelStore(settings: PanelSettings(defaults: defaults), shotTaker: taker)
        store.open(folder: dir)
        store.symbol = "5803"
        store.qtyText = "200"
        store.placeOrder(side: .buy)
        await store.flush()
        let long = try XCTUnwrap(store.book.openPositions.first)
        XCTAssertTrue(store.status.contains("撮影 85ms"), store.status)

        store.qtyText = "300"
        XCTAssertEqual(store.previewPlan(side: .sell)?.summary, "売り 300 → 決済 200・新規売り 100（ドテン）")
        store.placeOrder(side: .sell)
        await store.flush()
        XCTAssertEqual(store.armedFlip, .sell)
        XCTAssertEqual(try lines().count, 1, "1 回目では書かない")

        // 入力を変えたら予告は取り消し
        store.qtyText = "400"
        XCTAssertNil(store.armedFlip)
        store.qtyText = "300"
        store.placeOrder(side: .sell)
        XCTAssertEqual(store.armedFlip, .sell)
        store.placeOrder(side: .sell)
        XCTAssertNil(store.armedFlip)
        await store.flush()

        let rows = try lines().dropFirst().map { line -> OrderEvent in
            guard case .order(let o) = try EventCoding.decode(line: line) else { throw XCTSkip("order 以外") }
            return o
        }
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows.map(\.intent), [.close, .open])
        XCTAssertEqual(rows.map(\.qty), ["200", "100"])
        XCTAssertEqual(rows.map(\.side), [.sell, .sell])
        XCTAssertEqual(rows[0].positionID, long.id)
        XCTAssertNotEqual(rows[1].positionID, long.id)
        XCTAssertNotEqual(rows[0].id, rows[1].id)
        XCTAssertEqual(rows[0].ts, rows[1].ts)
        XCTAssertEqual(rows[0].shot, rows[1].shot, "2 行は同じ画像・同じ OCR を共有する")
        XCTAssertEqual(rows[0].shot?.path, "shots/\(JST.day(rows[0].ts))/\(rows[0].id.uuidString.lowercased()).png")
        XCTAssertEqual(taker.shotIDs.count, 2, "撮影は発注 1 回につき 1 回")

        XCTAssertEqual(store.book.openPositions.count, 1)
        XCTAssertEqual(store.book.openPositions.first?.direction, .sell)
        XCTAssertEqual(store.book.openPositions.first?.qty, 100)
    }

    func testFlipArmExpires() async throws {
        let store = PanelStore(settings: PanelSettings(defaults: defaults), shotTaker: FakeShotTaker { _, _, _ in nil })
        store.flipConfirmWindow = 0.1
        store.open(folder: dir)
        store.symbol = "7203"
        store.qtyText = "100"
        store.placeOrder(side: .buy)
        store.qtyText = "200"
        store.placeOrder(side: .sell)
        XCTAssertEqual(store.armedFlip, .sell)
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertNil(store.armedFlip, "猶予を過ぎたら予告は消える")
        store.placeOrder(side: .sell)
        await store.flush()
        XCTAssertEqual(store.armedFlip, .sell, "時間切れ後の押下は、また予告から")
        XCTAssertEqual(try lines().count, 1)
    }

    /// 指値のドテン（2 行）は「約定した」「取消」のどちらも 2 行そろって記録する
    func testLimitFlipFillsAndCancelsAsAPair() async throws {
        let store = PanelStore(settings: PanelSettings(defaults: defaults), shotTaker: FakeShotTaker { _, _, _ in nil })
        store.open(folder: dir)
        store.symbol = "7203"
        store.qtyText = "200"
        store.placeOrder(side: .buy)
        store.qtyText = "300"
        store.orderType = .limit
        store.limitPriceText = "2400"
        store.placeOrder(side: .sell)
        store.placeOrder(side: .sell)
        await store.flush()
        XCTAssertEqual(store.book.pendingLimits.map(\.intent), [.close, .open])
        let closeRow = store.book.pendingLimits[0]
        XCTAssertEqual(store.book.flipPartner(of: closeRow.id)?.id, store.book.pendingLimits[1].id)

        store.markFilled(orderID: closeRow.id)
        await store.flush()
        XCTAssertTrue(store.book.pendingLimits.isEmpty)
        XCTAssertEqual(store.book.openPositions.map(\.direction), [.sell])
        XCTAssertEqual(store.book.openPositions.first?.qty, 100)
        XCTAssertEqual(store.book.openPositions.first?.avgPrice, 2400)
        XCTAssertTrue(store.book.warnings.isEmpty, "\(store.book.warnings)")

        // 取消も相方ごと（open 側を押しても close 側も消える）
        store.qtyText = "300"
        store.orderType = .limit
        store.limitPriceText = "2300"
        store.placeOrder(side: .buy)
        store.placeOrder(side: .buy)
        await store.flush()
        XCTAssertEqual(store.book.pendingLimits.count, 2)
        store.cancel(orderID: store.book.pendingLimits[1].id)
        await store.flush()
        XCTAssertTrue(store.book.pendingLimits.isEmpty)
        XCTAssertEqual(store.book.openPositions.first?.qty, 100)
    }

    /// 領域を設定していない時は、全画面 OCR の結果（サイドカー）で建値を表示する（記録には書かない）
    func testAutoReadPriceFillsAverageForDisplay() async throws {
        let taker = FakeShotTaker { id, ts, log in
            Shot(path: log.shotLocation(eventID: id, ts: ts).relative, ocrPath: log.ocrLocation(eventID: id, ts: ts).relative)
        }
        let settings = PanelSettings(defaults: defaults)
        let store = PanelStore(settings: settings, shotTaker: taker)
        store.open(folder: dir)
        store.symbol = "5803"
        store.qtyText = "100"
        store.placeOrder(side: .buy)
        await store.flush()
        let pos = try XCTUnwrap(store.book.openPositions.first)
        XCTAssertNil(pos.avgPrice)
        guard case .order(let o) = try EventCoding.decode(line: try lines()[0]) else { return XCTFail() }
        let path = try XCTUnwrap(o.shot?.ocrPath)
        XCTAssertNil(o.shot?.price, "記録の price は領域の読み取りだけ")

        let auto = AutoRead(price: "5566", priceText: "5,566", priceTime: "15:30", symbol: "5803", source: "label")
        taker.onAutoRead?(path, auto)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(store.book.openPositions.first?.avgPrice, 5566)

        // 再起動相当: サイドカーから読み直す
        try OCRSidecar(width: 10, height: 10, capturedAt: nil, windowTitle: nil, auto: auto, items: [])
            .write(to: dir.appendingPathComponent(path))
        let restored = PanelStore(settings: settings, shotTaker: FakeShotTaker { _, _, _ in nil })
        restored.open(folder: dir)
        XCTAssertEqual(restored.book.openPositions.first?.avgPrice, 5566)
    }

    func testHoverRefreshesCaptureTarget() {
        let taker = FakeShotTaker { _, _, _ in nil }
        let store = PanelStore(settings: PanelSettings(defaults: defaults), shotTaker: taker)
        store.autoCaptureAllowed = { false }
        store.hoverEntered()
        XCTAssertEqual(taker.refreshCount, 0, "権限が無ければ撮影対象も探さない")
        store.autoCaptureAllowed = { true }
        store.hoverEntered()
        XCTAssertEqual(taker.refreshCount, 1)
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

    // MARK: Codex レビュー指摘の回帰

    private func decodedFile() throws -> [PaperEvent] { try lines().map { try EventCoding.decode(line: $0) } }

    /// 指摘 2: 決済指値の約定で建玉が 0 になった後に、その建玉の買い増し指値が残っていると、
    /// 次の成行で別の建玉ができ、残った指値の約定で同じ向きの建玉が 2 つ → 反対売買のドテンで両建てになっていた
    func testCloseLimitFillToZeroCancelsLeftoverAddLimit() async throws {
        let store = PanelStore(settings: PanelSettings(defaults: defaults), shotTaker: FakeShotTaker { _, _, _ in nil })
        store.open(folder: dir)
        store.symbol = "7203"
        store.qtyText = "100"
        store.orderType = .market
        store.placeOrder(side: .buy)                 // 買 100 成行
        store.orderType = .limit
        store.limitPriceText = "2400"
        store.placeOrder(side: .sell)                // 売 100 指値（全決済）
        store.limitPriceText = "2300"
        store.placeOrder(side: .buy)                 // 買 100 指値（買い増し）
        await store.flush()
        XCTAssertEqual(store.book.pendingLimits.map(\.intent), [.close, .add])
        let closeLimit = store.book.pendingLimits[0].id
        let addLimit = store.book.pendingLimits[1].id

        store.markFilled(orderID: closeLimit)        // 売指値を先に「約定した」
        await store.flush()
        XCTAssertTrue(store.book.openPositions.isEmpty)
        XCTAssertTrue(store.book.pendingLimits.isEmpty, "建玉が 0 になったら、その建玉に残る買い増し指値も取り消す")
        let tail = try decodedFile().suffix(2)
        guard case .fillMark(let f) = tail.first, case .cancel(let c) = tail.last else { return XCTFail("fill_mark → cancel の順") }
        XCTAssertEqual(f.orderID, closeLimit)
        XCTAssertEqual(c.orderID, addLimit)
        XCTAssertEqual(f.ts, c.ts, "同じ ts で書く")

        store.orderType = .market
        store.placeOrder(side: .buy)                 // 買 100 成行
        store.markFilled(orderID: addLimit)          // 残った買増指値を「約定した」（直した後は取消済みなので何もしない）
        await store.flush()
        XCTAssertEqual(store.book.openPositions.count, 1, "同じ銘柄に建玉は 1 つ")
        store.qtyText = "200"
        store.placeOrder(side: .sell)                // 売 200（ドテン: 予告 → 確定）
        store.placeOrder(side: .sell)
        await store.flush()

        let replayed = PositionBook.replay(try decodedFile())
        XCTAssertFalse(replayed.warnings.contains { $0.contains("両建て") }, "\(replayed.warnings)")
        XCTAssertEqual(replayed.openPositions.map(\.direction), [.sell])
        XCTAssertEqual(replayed.openPositions.first?.qty, 100)
    }

    /// 指摘 6: ドテンの予告の後に待機指値の「約定した」で保有数が変わったら、確認を解除する（変わった数量を確認なしに書かない）
    func testFlipConfirmationResetsWhenHoldingChanges() async throws {
        let store = PanelStore(settings: PanelSettings(defaults: defaults), shotTaker: FakeShotTaker { _, _, _ in nil })
        store.open(folder: dir)
        store.symbol = "7203"
        store.qtyText = "200"
        store.orderType = .market
        store.placeOrder(side: .buy)
        store.qtyText = "100"
        store.orderType = .limit
        store.limitPriceText = "2300"
        store.placeOrder(side: .buy)                 // 買い増し指値 100
        await store.flush()
        let addLimit = try XCTUnwrap(store.book.pendingLimits.first?.id)

        store.qtyText = "400"
        store.orderType = .market
        store.placeOrder(side: .sell)                // 予告: 決済 200・新規売り 200
        XCTAssertEqual(store.armedFlip, .sell)
        store.markFilled(orderID: addLimit)          // 3 秒以内に保有が 300 に変わる
        await store.flush()
        XCTAssertEqual(store.book.openPositions.first?.qty, 300)
        XCTAssertNil(store.armedFlip, "建玉が変わったら確認は解除")

        let written = try lines().count
        store.placeOrder(side: .sell)
        await store.flush()
        XCTAssertEqual(try lines().count, written, "変わった内容を確認なしに書かない")
        XCTAssertEqual(store.armedFlip, .sell)
        XCTAssertTrue(store.status.contains("決済 300・新規売り 100"), store.status)

        store.placeOrder(side: .sell)
        await store.flush()
        let rows = try decodedFile().suffix(2).compactMap { e -> OrderEvent? in if case .order(let o) = e { return o } else { return nil } }
        XCTAssertEqual(rows.map(\.intent), [.close, .open])
        XCTAssertEqual(rows.map(\.qty), ["300", "100"])
    }

    /// 指摘 1: 書き込みに失敗したら画面の状態を進めない（ドテンも指値ドテンの約定も、何も書かず元のまま）
    func testWriteFailureRollsBackScreenState() async throws {
        let store = PanelStore(settings: PanelSettings(defaults: defaults), shotTaker: FakeShotTaker { _, _, _ in nil })
        store.open(folder: dir)
        store.symbol = "7203"
        store.qtyText = "200"
        store.placeOrder(side: .buy)
        await store.flush()
        let long = try XCTUnwrap(store.book.openPositions.first)
        let file = dir.appendingPathComponent("events.jsonl").path
        let fm = FileManager.default

        try fm.setAttributes([.posixPermissions: 0o444], ofItemAtPath: file)
        store.qtyText = "300"
        store.placeOrder(side: .sell)
        store.placeOrder(side: .sell)
        await store.flush()
        XCTAssertEqual(try lines().count, 1)
        XCTAssertEqual(store.book.openPositions.map(\.id), [long.id], "失敗したドテンは画面からも消す")
        XCTAssertEqual(store.book.openPositions.first?.qty, 200)
        XCTAssertTrue(store.status.hasPrefix("書き込みに失敗"), store.status)

        try fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file)
        store.orderType = .limit
        store.limitPriceText = "2400"
        store.placeOrder(side: .sell)
        store.placeOrder(side: .sell)
        await store.flush()
        XCTAssertEqual(store.book.pendingLimits.count, 2)

        try fm.setAttributes([.posixPermissions: 0o444], ofItemAtPath: file)
        store.markFilled(orderID: store.book.pendingLimits[0].id)
        await store.flush()
        XCTAssertEqual(try lines().count, 3)
        XCTAssertEqual(store.book.pendingLimits.count, 2, "失敗した約定は画面に残さない")
        XCTAssertEqual(store.book.openPositions.map(\.id), [long.id])
        XCTAssertTrue(store.status.hasPrefix("書き込みに失敗"), store.status)

        let restored = PanelStore(settings: PanelSettings(defaults: defaults), shotTaker: FakeShotTaker { _, _, _ in nil })
        restored.open(folder: dir)
        XCTAssertEqual(restored.book, store.book, "再起動後と画面が一致する")
    }

    /// 指摘 1 の続き: 失敗した書き込みより前に積んでいた操作（撮影待ちの間に押したもの）も書かない。
    /// 書くと、ファイルに無い指値への add 等が残り、再起動後の建玉が画面と食い違う
    func testWritesQueuedBeforeAFailureAreNotWritten() async throws {
        let file = dir.appendingPathComponent("events.jsonl").path
        var failID: UUID?, restoreID: UUID?
        let taker = FakeShotTaker { id, _, _ in
            // 1 本目の撮影完了で書き込めなくし、2 本目の撮影完了で戻す
            if id == failID { try? FileManager.default.setAttributes([.posixPermissions: 0o444], ofItemAtPath: file) }
            if id == restoreID { try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file) }
            return nil
        }
        let store = PanelStore(settings: PanelSettings(defaults: defaults), shotTaker: taker)
        store.open(folder: dir)
        store.symbol = "6758"
        store.qtyText = "100"
        store.placeOrder(side: .buy)
        await store.flush()

        store.symbol = "7203"
        store.orderType = .limit
        store.limitPriceText = "2300"
        store.placeOrder(side: .buy)                 // 新規の指値（撮影 0.1 秒後に書く → 失敗）
        store.placeOrder(side: .buy)                 // その建玉への add（撮影 0.4 秒後。この時はもう書ける）
        XCTAssertEqual(store.book.pendingLimits.map(\.intent), [.open, .add])
        // 書き込みの Task はこのテスト（MainActor）が await するまで走らないので、ここで撮影の振る舞いを決めてよい
        let ids = store.book.pendingLimits.map(\.id)
        failID = ids[0]
        restoreID = ids[1]
        taker.delayFor = { $0 == ids[0] ? 0.1 : 0.4 }
        await store.flush()

        XCTAssertEqual(try lines().count, 1, "失敗より前に積んだ add も書かない")
        XCTAssertTrue(store.book.pendingLimits.isEmpty)
        XCTAssertTrue(store.status.hasPrefix("書き込みに失敗"), store.status)
        let restored = PanelStore(settings: PanelSettings(defaults: defaults), shotTaker: FakeShotTaker { _, _, _ in nil })
        restored.open(folder: dir)
        XCTAssertEqual(restored.book, store.book)
        XCTAssertTrue(restored.book.warnings.isEmpty, "\(restored.book.warnings)")

        // 失敗の後に押したものは普通に書ける
        store.placeOrder(side: .buy)
        await store.flush()
        XCTAssertEqual(try lines().count, 2)
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

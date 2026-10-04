import XCTest
@testable import PanelKit

/// 小窓が実際に書く events.jsonl の見本（docs/fixtures/panel-events.jsonl）との契約テスト。
/// web 側（apps/web/tests/paper/panel-fixture.test.ts）が同じファイルを読むので、
/// エンコーダの出力（キー順・数値の書式・null の出し方）が変わるとここで落ちる。
/// 見本を作り直すときは: TEST_RUNNER_PANEL_FIXTURE_UPDATE=1 ./scripts/test.sh -only-testing:PanelKitTests/FixtureContractTests
/// （書き換わった差分を目で確かめてから web 側の期待値も直すこと）
final class FixtureContractTests: XCTestCase {
    /// apps/panel/Tests/FixtureContractTests.swift → リポジトリ直下の docs/fixtures/panel-events.jsonl
    static let fixtureURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("docs/fixtures/panel-events.jsonl")

    private func id(_ n: Int) -> UUID { UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", n))! }
    private func ts(_ hms: String) -> Date { JST.parse("2026-10-02T\(hms)+09:00")! }

    /// 2026-10-02（金）の 7203。建玉 A（買い→買い増し→指値決済→fill_mark）と建玉 B（空売り→指値決済→取消→成行決済）
    private var events: [PaperEvent] {
        let posA = id(900), posB = id(901)
        let a1 = id(1), a2 = id(2), a3 = id(4), b1 = id(6), b2 = id(7), b3 = id(9)
        func shot(_ n: Int, _ text: String, _ price: String, _ conf: Double) -> Shot {
            Shot(path: "shots/2026-10-02/\(id(n).uuidString.lowercased()).png", priceText: text, price: price, symbolText: "7203", confidence: conf)
        }
        return [
            // 寄り前の成行の新規買い（約定は日足始値・09:00）
            .order(OrderEvent(id: a1, ts: ts("08:55:12.345"), positionID: posA, intent: .open, symbol: "7203", side: .buy,
                              qty: "100", orderType: .market, shot: shot(1, "2,856.5", "2856.5", 0.97))),
            // ザラ場の成行の買い増し（約定は shot.price）
            .order(OrderEvent(id: a2, ts: ts("09:12:34.567"), positionID: posA, intent: .add, symbol: "7203", side: .buy,
                              qty: "100", orderType: .market, shot: shot(2, "2,860", "2860", 0.98))),
            .memo(MemoEvent(id: id(3), ts: ts("09:13:20.100"), positionID: posA, orderID: nil, text: "押し目で入った、出来高増")),
            // 指値の決済売り → fill_mark
            .order(OrderEvent(id: a3, ts: ts("09:40:05.222"), positionID: posA, intent: .close, symbol: "7203", side: .sell,
                              qty: "200", orderType: .limit, limitPrice: "2875", shot: shot(4, "2,862", "2862", 0.96))),
            .fillMark(RefEvent(id: id(5), ts: ts("10:02:41.789"), orderID: a3)),
            // 空売りの新規（shot が撮れなかった）
            .order(OrderEvent(id: b1, ts: ts("10:30:15.050"), positionID: posB, intent: .open, symbol: "7203", side: .sell,
                              qty: "100", orderType: .market, shot: nil)),
            // 指値の決済買い → 取消 → 成行決済
            .order(OrderEvent(id: b2, ts: ts("11:05:00.500"), positionID: posB, intent: .close, symbol: "7203", side: .buy,
                              qty: "100", orderType: .limit, limitPrice: "2840", shot: nil)),
            .cancel(RefEvent(id: id(8), ts: ts("11:20:30.000"), orderID: b2)),
            .order(OrderEvent(id: b3, ts: ts("13:15:45.678"), positionID: posB, intent: .close, symbol: "7203", side: .buy,
                              qty: "100", orderType: .market, shot: shot(9, "2,848", "2848", 0.99))),
            // 決済後のメモ
            .memo(MemoEvent(id: id(10), ts: ts("13:16:30.900"), positionID: posB, orderID: b3, text: "損切り、板が薄かった")),
        ]
    }

    private func encodedText() throws -> String {
        try events.map { try EventCoding.line($0) + "\n" }.joined()
    }

    func testEncoderOutputMatchesFixtureByteForByte() throws {
        let actual = try encodedText()
        if ProcessInfo.processInfo.environment["PANEL_FIXTURE_UPDATE"] == "1" {
            try FileManager.default.createDirectory(at: Self.fixtureURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(actual.utf8).write(to: Self.fixtureURL)
        }
        let data = try XCTUnwrap(try? Data(contentsOf: Self.fixtureURL), "見本ファイルが読めない: \(Self.fixtureURL.path)")
        let expected = String(decoding: data, as: UTF8.self)

        let actualLines = actual.components(separatedBy: "\n")
        let expectedLines = expected.components(separatedBy: "\n")
        XCTAssertEqual(expectedLines.count, actualLines.count, "行数が違う")
        for (i, (e, a)) in zip(expectedLines, actualLines).enumerated() {
            XCTAssertEqual(a, e, "\(i + 1) 行目が見本と違う")
        }
        XCTAssertEqual(actual, expected, "ファイル全体（末尾の改行を含む）が一致しない")
    }

    func testFixtureDecodesBackToTheSameEvents() throws {
        let text = String(decoding: try Data(contentsOf: Self.fixtureURL), as: UTF8.self)
        let lines = text.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
        let decoded = try lines.map { try EventCoding.decode(line: $0) }
        XCTAssertEqual(decoded, events)
    }
}

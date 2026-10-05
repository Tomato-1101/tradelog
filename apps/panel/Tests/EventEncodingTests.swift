import XCTest
@testable import PanelKit

final class EventEncodingTests: XCTestCase {
    let pos = UUID(uuidString: "11111111-2222-3333-4444-555555555555")!
    let oid = UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!

    /// 2026-10-05 09:01:23.456 JST
    var ts: Date { JST.parse("2026-10-05T09:01:23.456+09:00")! }

    private func object(_ e: PaperEvent) throws -> [String: Any] {
        let line = try EventCoding.line(e)
        XCTAssertFalse(line.contains("\n"), "1 イベント = 1 行")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line.utf8), options: [.fragmentsAllowed]) as? [String: Any])
    }

    func testTimestampIsMillisWithJSTOffset() {
        XCTAssertEqual(JST.format(ts), "2026-10-05T09:01:23.456+09:00")
        // UTC で作った時刻も JST で書かれる
        let utc = ISO8601DateFormatter().date(from: "2026-10-05T00:01:23Z")!
        XCTAssertEqual(JST.format(utc), "2026-10-05T09:01:23.000+09:00")
    }

    func testNowMillisRoundTripsExactly() {
        for _ in 0..<200 {
            let d = JST.nowMillis()
            let text = JST.format(d)
            XCTAssertEqual(JST.parse(text).map(JST.format), text)
            // 書いた文字列のミリ秒と内部値のミリ秒が一致する（浮動小数の切り捨てで 1ms ずれない）
            let ms = Int((d.timeIntervalSince1970 * 1000).rounded()) % 1000
            XCTAssertEqual(String(text.dropFirst(20).prefix(3)), String(format: "%03d", ms))
        }
    }

    func testMarketOrderWithShot() throws {
        let shot = Shot(path: "shots/2026-10-05/x.png", priceText: "2,345.5", price: "2345.5", symbolText: "7203", confidence: 0.98)
        let o = try object(.order(OrderEvent(id: oid, ts: ts, positionID: pos, intent: .open, symbol: "7203", side: .buy,
                                             qty: "100", orderType: .market, limitPrice: nil, shot: shot)))
        XCTAssertEqual(Set(o.keys), ["v", "id", "type", "ts", "position_id", "intent", "symbol", "side", "qty",
                                     "order_type", "limit_price", "shot"])
        XCTAssertEqual(o["v"] as? Int, 1)
        XCTAssertEqual(o["id"] as? String, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
        XCTAssertEqual(o["type"] as? String, "order")
        XCTAssertEqual(o["ts"] as? String, "2026-10-05T09:01:23.456+09:00")
        XCTAssertEqual(o["position_id"] as? String, "11111111-2222-3333-4444-555555555555")
        XCTAssertEqual(o["intent"] as? String, "open")
        XCTAssertEqual(o["symbol"] as? String, "7203")
        XCTAssertEqual(o["side"] as? String, "buy")
        XCTAssertEqual(o["qty"] as? String, "100", "数量は文字列")
        XCTAssertEqual(o["order_type"] as? String, "market")
        XCTAssertTrue(o["limit_price"] is NSNull, "成行の limit_price は null を明示")
        let s = try XCTUnwrap(o["shot"] as? [String: Any])
        XCTAssertEqual(Set(s.keys), ["path", "price_text", "price", "symbol_text", "confidence"])
        XCTAssertEqual(s["path"] as? String, "shots/2026-10-05/x.png")
        XCTAssertEqual(s["price_text"] as? String, "2,345.5")
        XCTAssertEqual(s["price"] as? String, "2345.5", "価格は文字列")
        XCTAssertEqual(s["symbol_text"] as? String, "7203")
        XCTAssertEqual(s["confidence"] as? Double, 0.98)
    }

    func testRawLineFormatForStringDecimals() throws {
        let line = try EventCoding.line(.order(OrderEvent(id: oid, ts: ts, positionID: pos, intent: .open, symbol: "285A",
                                                         side: .sell, qty: "300", orderType: .limit, limitPrice: "1234.5", shot: nil)))
        XCTAssertTrue(line.contains(#""qty":"300""#))
        XCTAssertTrue(line.contains(#""limit_price":"1234.5""#))
        XCTAssertTrue(line.contains(#""shot":null"#), "撮れなかったら shot は null")
        XCTAssertTrue(line.contains(#""symbol":"285A""#))
        XCTAssertFalse(line.contains(#"\/"#), "スラッシュをエスケープしない")
    }

    func testShotWithUnreadableValuesKeepsNullKeys() throws {
        let o = try object(.order(OrderEvent(id: oid, ts: ts, positionID: pos, intent: .open, symbol: "7203", side: .buy,
                                             qty: "100", orderType: .market, shot: Shot(path: "shots/a.png"))))
        let s = try XCTUnwrap(o["shot"] as? [String: Any])
        XCTAssertTrue(s["price_text"] is NSNull)
        XCTAssertTrue(s["price"] is NSNull)
        XCTAssertTrue(s["symbol_text"] is NSNull)
        XCTAssertTrue(s["confidence"] is NSNull)
    }

    /// 新しい shot のキー（captured_at / window_title / ocr_path）は値がある時だけ書く（旧形式の行と見本はそのまま）
    func testShotCaptureFieldsAreOptional() throws {
        let plain = try XCTUnwrap(try object(.order(OrderEvent(id: oid, ts: ts, positionID: pos, intent: .open, symbol: "7203", side: .buy,
                                                               qty: "100", orderType: .market, shot: Shot(path: "shots/a.png"))))["shot"] as? [String: Any])
        XCTAssertEqual(Set(plain.keys), ["path", "price_text", "price", "symbol_text", "confidence"])

        let captured = try XCTUnwrap(JST.parse(JST.format(ts.addingTimeInterval(0.085))))
        let shot = Shot(path: "shots/2026-10-05/a.png", capturedAt: captured, windowTitle: "全板　フジクラ(5803)",
                        ocrPath: "shots/2026-10-05/a.ocr.json")
        let e = PaperEvent.order(OrderEvent(id: oid, ts: ts, positionID: pos, intent: .open, symbol: "5803", side: .buy,
                                            qty: "100", orderType: .market, shot: shot))
        let s = try XCTUnwrap(try object(e)["shot"] as? [String: Any])
        XCTAssertEqual(s["captured_at"] as? String, JST.format(captured))
        XCTAssertEqual(s["window_title"] as? String, "全板　フジクラ(5803)")
        XCTAssertEqual(s["ocr_path"] as? String, "shots/2026-10-05/a.ocr.json")
        XCTAssertTrue(s["price"] is NSNull, "price は領域の読み取りだけ（領域が無ければ null）")
        XCTAssertEqual(try EventCoding.decode(line: EventCoding.line(e)), e)
    }

    func testFillMarkCancelMemo() throws {
        let f = try object(.fillMark(RefEvent(id: pos, ts: ts, orderID: oid)))
        XCTAssertEqual(Set(f.keys), ["v", "id", "type", "ts", "order_id"])
        XCTAssertEqual(f["type"] as? String, "fill_mark")
        XCTAssertEqual(f["order_id"] as? String, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")

        let c = try object(.cancel(RefEvent(id: pos, ts: ts, orderID: oid)))
        XCTAssertEqual(c["type"] as? String, "cancel")
        XCTAssertEqual(Set(c.keys), ["v", "id", "type", "ts", "order_id"])

        let m = try object(.memo(MemoEvent(id: oid, ts: ts, positionID: pos, orderID: nil, text: "押し目で入った、出来高増")))
        XCTAssertEqual(Set(m.keys), ["v", "id", "type", "ts", "position_id", "order_id", "text"])
        XCTAssertEqual(m["type"] as? String, "memo")
        XCTAssertTrue(m["order_id"] is NSNull)
        XCTAssertEqual(m["text"] as? String, "押し目で入った、出来高増")
    }

    func testRoundTrip() throws {
        let events: [PaperEvent] = [
            .order(OrderEvent(id: oid, ts: ts, positionID: pos, intent: .open, symbol: "7203", side: .buy, qty: "100",
                              orderType: .limit, limitPrice: "2340", shot: Shot(path: "p", priceText: "2,345", price: "2345", symbolText: "7203", confidence: 0.5))),
            .fillMark(RefEvent(ts: ts.addingTimeInterval(60), orderID: oid)),
            .memo(MemoEvent(ts: ts.addingTimeInterval(61), positionID: pos, orderID: oid, text: "改行\nも入る")),
            .cancel(RefEvent(ts: ts, orderID: oid)),
        ]
        for e in events {
            XCTAssertEqual(try EventCoding.decode(line: EventCoding.line(e)), e)
        }
    }
}

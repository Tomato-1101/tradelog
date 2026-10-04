import XCTest
@testable import PanelKit

/// Vision の読み取りを、オフスクリーンで描いた数字画像で確かめる
final class VisionReadTests: XCTestCase {
    func testReadsPriceWholeImage() {
        let img = TestImages.render(width: 240, height: 60, labels: [.init(text: "2,345.5", origin: CGPoint(x: 12, y: 10), fontSize: 36)])
        let r = TextReader.read(img, region: nil)
        XCTAssertEqual(r.text, "2,345.5")
        XCTAssertEqual(PriceParser.parse(r.text), "2345.5")
        XCTAssertNotNil(r.confidence)
    }

    func testReadsSmallTextByUpscaling() {
        // HYPER SBI 2 の現在値表示くらいの小さな文字（13pt 相当）
        let img = TestImages.render(width: 90, height: 20, labels: [.init(text: "12,345", origin: CGPoint(x: 4, y: 2), fontSize: 14)])
        let r = TextReader.read(img, region: nil)
        XCTAssertEqual(PriceParser.parse(r.text), "12345", "読んだ文字列: \(r.text ?? "nil")")
    }

    /// ウィンドウ全体の画像から、相対座標の領域だけ切り出して読む（左上原点の扱いを確認）
    func testReadsConfiguredRegionsFromWindowImage() throws {
        let img = TestImages.render(width: 1200, height: 800, labels: [
            .init(text: "7203", origin: CGPoint(x: 40, y: 30), fontSize: 28),
            .init(text: "TOYOTA", origin: CGPoint(x: 160, y: 30), fontSize: 28),
            .init(text: "3,021.5", origin: CGPoint(x: 820, y: 600), fontSize: 40),
            .init(text: "9,999", origin: CGPoint(x: 820, y: 100), fontSize: 40),  // 領域外の別の数字（拾ってはいけない）
        ])
        let symbolRegion = RelRect(x: 20.0 / 1200, y: 20.0 / 800, w: 120.0 / 1200, h: 50.0 / 800)
        let priceRegion = RelRect(x: 800.0 / 1200, y: 585.0 / 800, w: 260.0 / 1200, h: 70.0 / 800)

        let price = TextReader.read(img, region: priceRegion)
        XCTAssertEqual(PriceParser.parse(price.text), "3021.5", "読んだ文字列: \(price.text ?? "nil")")
        let symbol = TextReader.read(img, region: symbolRegion)
        XCTAssertEqual(SymbolParser.extract(symbol.text), "7203", "読んだ文字列: \(symbol.text ?? "nil")")
    }

    /// 端ぎりぎりで囲んだ領域・暗い背景に色付き文字（HYPER SBI 2 の配色に近い）でも読める
    func testTightRegionOnDarkBackground() {
        let img = TestImages.render(width: 400, height: 100, labels: [.init(text: "12,345.5", origin: CGPoint(x: 10, y: 20), fontSize: 30)],
                                    background: CGColor(gray: 0.1, alpha: 1), foreground: CGColor(red: 1, green: 0.3, blue: 0.3, alpha: 1))
        let r = TextReader.read(img, region: RelRect(x: 5.0 / 400, y: 22.0 / 100, w: 160.0 / 400, h: 36.0 / 100))
        XCTAssertEqual(PriceParser.parse(r.text), "12345.5", "読んだ文字列: \(r.text ?? "nil")")
    }

    func testMakeShotWritesPNGAndReadsRegions() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let log = EventLog(folder: dir)
        let img = TestImages.render(width: 600, height: 300, labels: [
            .init(text: "285A", origin: CGPoint(x: 20, y: 20), fontSize: 28),
            .init(text: "1,234", origin: CGPoint(x: 300, y: 200), fontSize: 36),
        ])
        let id = UUID()
        let ts = JST.parse("2026-10-05T10:00:00.000+09:00")!
        let loc = log.shotLocation(eventID: id, ts: ts)
        XCTAssertEqual(loc.relative, "shots/2026-10-05/\(id.uuidString.lowercased()).png")
        let shot = try XCTUnwrap(ScreenShotTaker.makeShot(
            image: img, url: loc.url, relative: loc.relative,
            priceRegion: RelRect(x: 0.45, y: 0.6, w: 0.4, h: 0.3), symbolRegion: RelRect(x: 0, y: 0, w: 0.3, h: 0.3)))
        XCTAssertTrue(FileManager.default.fileExists(atPath: loc.url.path))
        XCTAssertEqual(shot.path, loc.relative)
        XCTAssertEqual(shot.price, "1234")
        XCTAssertEqual(shot.priceText, "1,234")
        XCTAssertEqual(SymbolParser.extract(shot.symbolText), "285A")
        XCTAssertNotNil(shot.confidence)
    }

    func testBlankRegionGivesNulls() throws {
        let img = TestImages.render(width: 200, height: 100, labels: [])
        let r = TextReader.read(img, region: RelRect(x: 0.1, y: 0.1, w: 0.5, h: 0.5))
        XCTAssertNil(r.text)
        XCTAssertNil(PriceParser.parse(r.text))
    }
}

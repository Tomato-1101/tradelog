import CoreGraphics
import ImageIO
import XCTest
@testable import PanelKit

/// 全板ウィンドウの自動読み取り（ウィンドウタイトルの銘柄コード・「現在値」ラベルの右の価格と時刻）
final class BoardReaderTests: XCTestCase {
    static let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures")

    private func loadPNG(_ url: URL) throws -> CGImage {
        let src = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
        return try XCTUnwrap(CGImageSourceCreateImageAtIndex(src, 0, nil))
    }

    func testSymbolFromWindowTitle() {
        XCTAssertEqual(BoardReader.symbol(fromTitle: "全板　フジクラ(5803)"), "5803")
        XCTAssertEqual(BoardReader.symbol(fromTitle: "全板　キオクシアホールディングス(285A)"), "285A")
        XCTAssertEqual(BoardReader.symbol(fromTitle: "全板 フジクラ（5803）"), "5803", "全角括弧（Vision で読んだタイトル）")
        XCTAssertEqual(BoardReader.symbol(fromTitle: "全板　テスト(285a)"), "285A")
        XCTAssertNil(BoardReader.symbol(fromTitle: "全板"))
        XCTAssertNil(BoardReader.symbol(fromTitle: "ポートフォリオ(12345)"), "5 桁はコードではない")
        XCTAssertNil(BoardReader.symbol(fromTitle: nil))
    }

    func testParseLineTakesFirstNumberAndFollowingTime() {
        XCTAssertEqual(BoardReader.parseLine("5,566↑ C15:30"), .init(price: "5566", text: "5,566", time: "15:30"))
        XCTAssertEqual(BoardReader.parseLine("3,021.5 C 9:05"), .init(price: "3021.5", text: "3,021.5", time: "09:05"))
        XCTAssertNil(BoardReader.parseLine("C15:30").price, "時刻の数字を価格にしない")
        XCTAssertNil(BoardReader.parseLine("99S'S").price, "崩れた読み（実測: 全画面 OCR の 5,566）は採らない")
        XCTAssertNil(BoardReader.parseLine("---").price)
        XCTAssertEqual(BoardReader.parseLine("5,566T C 15:30").price, "5566", "矢印を T と読んでも価格は採る")
        XCTAssertEqual(BoardReader.parseLine("99S'S 15:30"), .init(time: "15:30"), "価格が崩れていても時刻は採る")
    }

    /// 実物の全板のヘッダー帯（Tests/Fixtures/hsbi-header-band.png。口座の数字は含まない）から現在値と時刻を読む
    func testHeaderBandFixtureReadsPriceAndTime() throws {
        let image = try loadPNG(Self.fixtures.appendingPathComponent("hsbi-header-band.png"))
        let items = BoardReader.recognize(image)
        XCTAssertTrue(items.contains { $0.text.contains("現在値") })
        let r = try XCTUnwrap(BoardReader.priceByLabel(image: image, items: items))
        XCTAssertEqual(r.price, "5566")
        XCTAssertEqual(r.time, "15:30")

        let sidecar = BoardReader.analyze(image: image, windowTitle: "全板　フジクラ(5803)", capturedAt: nil, regionShot: nil)
        XCTAssertEqual(sidecar.auto, AutoRead(price: "5566", priceText: r.text, priceTime: "15:30", symbol: "5803", source: "label"))
        XCTAssertEqual(sidecar.width, image.width)
        XCTAssertTrue(sidecar.items.allSatisfy { (0...1).contains($0.x) && (0...1).contains($0.y) })
    }

    /// 「現在値」の文字が無い画像では、画面のどこかの数字を拾わず null
    func testNoLabelGivesNull() {
        let img = TestImages.render(width: 800, height: 120, labels: [
            .init(text: "5,566", origin: CGPoint(x: 40, y: 30), fontSize: 32),
            .init(text: "15:30", origin: CGPoint(x: 240, y: 30), fontSize: 32),
        ])
        XCTAssertNil(BoardReader.priceByLabel(image: img, items: BoardReader.recognize(img)))
        let s = BoardReader.analyze(image: img, windowTitle: nil, capturedAt: nil, regionShot: nil)
        XCTAssertEqual(s.auto, AutoRead())
    }

    /// 描いた「現在値」ラベルの右の数字を読み、次のラベル（高値）より右は見ない
    func testLabelOnSyntheticImageStopsAtNextLabel() throws {
        let img = TestImages.render(width: 1400, height: 120, labels: [
            .init(text: "現在値", origin: CGPoint(x: 40, y: 40), fontSize: 26),
            .init(text: "3,021.5", origin: CGPoint(x: 160, y: 40), fontSize: 26),
            .init(text: "C 09:05", origin: CGPoint(x: 320, y: 40), fontSize: 26),
            .init(text: "高値", origin: CGPoint(x: 600, y: 40), fontSize: 26),
            .init(text: "3,100", origin: CGPoint(x: 700, y: 40), fontSize: 26),
        ])
        let r = try XCTUnwrap(BoardReader.priceByLabel(image: img, items: BoardReader.recognize(img)))
        XCTAssertEqual(r.price, "3021.5")
        XCTAssertEqual(r.time, "09:05")
    }

    /// 設定した読み取り領域で価格が読めていれば、それを優先する（source = "region"）
    func testRegionPriceTakesPrecedence() throws {
        let image = try loadPNG(Self.fixtures.appendingPathComponent("hsbi-header-band.png"))
        let shot = Shot(path: "shots/x.png", priceText: "5,570", price: "5570", symbolText: "5803")
        let s = BoardReader.analyze(image: image, windowTitle: nil, capturedAt: nil, regionShot: shot)
        XCTAssertEqual(s.auto.price, "5570")
        XCTAssertEqual(s.auto.priceText, "5,570")
        XCTAssertEqual(s.auto.source, "region")
        XCTAssertEqual(s.auto.priceTime, "15:30")
        XCTAssertEqual(s.auto.symbol, "5803", "タイトルが無ければ銘柄コード領域の読み")
    }

    /// サイドカーの形（web が読む契約）: キー名・null の書き方・座標
    func testSidecarJSONShape() throws {
        let t = JST.parse("2026-10-05T15:30:01.234+09:00")!
        let s = OCRSidecar(width: 3074, height: 2714, capturedAt: JST.format(t), windowTitle: "全板　フジクラ(5803)",
                           auto: AutoRead(price: "5566", priceText: "5,566", priceTime: "15:30", symbol: "5803", source: "label"),
                           items: [OCRItem(text: "現在値", conf: 0.98, x: 0.27, y: 0.06, w: 0.02, h: 0.01)])
        let json = try XCTUnwrap(String(data: try s.data(), encoding: .utf8))
        XCTAssertEqual(json, #"{"auto":{"price":"5566","price_text":"5,566","price_time":"15:30","source":"label","symbol":"5803"},"captured_at":"2026-10-05T15:30:01.234+09:00","height":2714,"items":[{"conf":0.98,"h":0.01,"text":"現在値","w":0.02,"x":0.27,"y":0.06}],"v":1,"width":3074,"window_title":"全板　フジクラ(5803)"}"#)
        let empty = try XCTUnwrap(String(data: try OCRSidecar(width: 1, height: 1, capturedAt: nil, windowTitle: nil, auto: AutoRead(), items: []).data(), encoding: .utf8))
        XCTAssertEqual(empty, #"{"auto":{"price":null,"price_text":null,"price_time":null,"source":null,"symbol":null},"captured_at":null,"height":1,"items":[],"v":1,"width":1,"window_title":null}"#)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("shots/2026-10-05/x.ocr.json")
        try s.write(to: url)
        XCTAssertEqual(OCRSidecar.load(url), s)
    }

    /// 全画面の実画像（口座の数字を含むので gitignore 済み。無ければ飛ばす）
    func testFullBoardImageIfPresent() throws {
        let url = Self.fixtures.deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shots-dev/hsbi-board-full.png")
        try XCTSkipUnless(FileManager.default.fileExists(atPath: url.path), "shots-dev/hsbi-board-full.png が無い")
        let image = try loadPNG(url)
        let start = Date()
        let s = BoardReader.analyze(image: image, windowTitle: "全板　フジクラ(5803)", capturedAt: nil, regionShot: nil)
        print("全画面 OCR: \(Int(Date().timeIntervalSince(start) * 1000))ms 語数 \(s.items.count)")
        XCTAssertEqual(s.auto.price, "5566")
        XCTAssertEqual(s.auto.priceTime, "15:30")
        XCTAssertEqual(s.auto.source, "label")
    }
}

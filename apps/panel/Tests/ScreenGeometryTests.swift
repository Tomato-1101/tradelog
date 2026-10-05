import XCTest
@testable import PanelKit

/// 画面上で囲んだ矩形（AppKit 座標）→ CG 座標 → 対象ウィンドウに対する比率（RelRect）の変換
final class ScreenGeometryTests: XCTestCase {
    private func assertRect(_ a: CGRect, _ b: CGRect, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(a.minX, b.minX, accuracy: 1e-9, file: file, line: line)
        XCTAssertEqual(a.minY, b.minY, accuracy: 1e-9, file: file, line: line)
        XCTAssertEqual(a.width, b.width, accuracy: 1e-9, file: file, line: line)
        XCTAssertEqual(a.height, b.height, accuracy: 1e-9, file: file, line: line)
    }

    private func assertRel(_ r: RelRect?, _ x: Double, _ y: Double, _ w: Double, _ h: Double,
                           file: StaticString = #filePath, line: UInt = #line) {
        guard let r else { return XCTFail("nil", file: file, line: line) }
        XCTAssertEqual(r.x, x, accuracy: 1e-9, file: file, line: line)
        XCTAssertEqual(r.y, y, accuracy: 1e-9, file: file, line: line)
        XCTAssertEqual(r.w, w, accuracy: 1e-9, file: file, line: line)
        XCTAssertEqual(r.h, h, accuracy: 1e-9, file: file, line: line)
    }

    /// 主ディスプレイ 1 枚: 左下原点 → 左上原点で y が反転する
    func testAppKitToCGOnPrimaryDisplay() {
        let cg = ScreenGeometry.cgRect(fromAppKit: CGRect(x: 100, y: 700, width: 50, height: 20), primaryHeight: 900)
        assertRect(cg, CGRect(x: 100, y: 180, width: 50, height: 20))
        assertRect(ScreenGeometry.appKitRect(fromCG: cg, primaryHeight: 900), CGRect(x: 100, y: 700, width: 50, height: 20))
    }

    /// 全画面のウィンドウ（主ディスプレイ 2560×1440）で、右下の数字を囲む
    func testSelectionToRelRectOnFullScreenWindow() {
        let window = CGRect(x: 0, y: 0, width: 2560, height: 1440)  // SCWindow.frame（CG）
        let appKitSelection = CGRect(x: 2048, y: 144, width: 128, height: 36)  // 下から 144pt
        let cg = ScreenGeometry.cgRect(fromAppKit: appKitSelection, primaryHeight: 1440)
        assertRect(cg, CGRect(x: 2048, y: 1260, width: 128, height: 36))
        assertRel(ScreenGeometry.relRect(selection: cg, windowFrame: window), 0.8, 1260.0 / 1440, 0.05, 36.0 / 1440)
    }

    /// 主ディスプレイの左にある画面（x が負）。上端揃えなので AppKit の y は 1440-1080=360
    func testSecondaryDisplayOnTheLeftWithNegativeOrigin() {
        let primaryHeight: CGFloat = 1440
        let screens = [CGRect(x: 0, y: 0, width: 2560, height: 1440), CGRect(x: -1920, y: 360, width: 1920, height: 1080)]
        let window = CGRect(x: -1800, y: 100, width: 1000, height: 800)  // CG: 左の画面の中
        XCTAssertEqual(ScreenGeometry.screenIndex(forWindow: window, screenFrames: screens, primaryHeight: primaryHeight), 1)
        // CG で (-1700, 200) 100×40 の位置 → AppKit の y = 1440 - (200 + 40) = 1200
        let appKitSelection = CGRect(x: -1700, y: 1200, width: 100, height: 40)
        let cg = ScreenGeometry.cgRect(fromAppKit: appKitSelection, primaryHeight: primaryHeight)
        assertRect(cg, CGRect(x: -1700, y: 200, width: 100, height: 40))
        assertRel(ScreenGeometry.relRect(selection: cg, windowFrame: window), 0.1, 0.125, 0.1, 0.05)
    }

    /// 主ディスプレイの下にある画面（AppKit の y が負、CG の y は主ディスプレイの高さより大きい）
    func testSecondaryDisplayBelowPrimary() {
        let primaryHeight: CGFloat = 1440
        let screens = [CGRect(x: 0, y: 0, width: 2560, height: 1440), CGRect(x: 0, y: -1080, width: 1920, height: 1080)]
        let window = CGRect(x: 100, y: 1500, width: 800, height: 600)
        XCTAssertEqual(ScreenGeometry.screenIndex(forWindow: window, screenFrames: screens, primaryHeight: primaryHeight), 1)
        let appKitSelection = CGRect(x: 500, y: -390, width: 80, height: 30)  // CG では (500, 1800)
        let cg = ScreenGeometry.cgRect(fromAppKit: appKitSelection, primaryHeight: primaryHeight)
        assertRect(cg, CGRect(x: 500, y: 1800, width: 80, height: 30))
        assertRel(ScreenGeometry.relRect(selection: cg, windowFrame: window), 0.5, 0.5, 0.1, 0.05)
    }

    /// 主ディスプレイの上にある画面（CG の y が負）
    func testSecondaryDisplayAboveWithNegativeCGOrigin() {
        let primaryHeight: CGFloat = 1440
        let screens = [CGRect(x: 0, y: 0, width: 2560, height: 1440), CGRect(x: 320, y: 1440, width: 1920, height: 1080)]
        let window = CGRect(x: 400, y: -1000, width: 1000, height: 500)  // CG: 上の画面の中
        XCTAssertEqual(ScreenGeometry.screenIndex(forWindow: window, screenFrames: screens, primaryHeight: primaryHeight), 1)
        let cg = ScreenGeometry.cgRect(fromAppKit: CGRect(x: 900, y: 2190, width: 100, height: 50), primaryHeight: primaryHeight)
        assertRect(cg, CGRect(x: 900, y: -800, width: 100, height: 50))
        assertRel(ScreenGeometry.relRect(selection: cg, windowFrame: window), 0.5, 0.4, 0.1, 0.1)
    }

    /// 2 画面にまたがるウィンドウは、重なりの大きい画面にオーバーレイを出す。どこにも無ければ nil
    func testScreenIndexPicksLargestOverlap() {
        let screens = [CGRect(x: 0, y: 0, width: 1440, height: 900), CGRect(x: 1440, y: 0, width: 1920, height: 900)]
        XCTAssertEqual(ScreenGeometry.screenIndex(forWindow: CGRect(x: 1000, y: 0, width: 1000, height: 800), screenFrames: screens, primaryHeight: 900), 1)
        XCTAssertEqual(ScreenGeometry.screenIndex(forWindow: CGRect(x: 100, y: 0, width: 1500, height: 800), screenFrames: screens, primaryHeight: 900), 0)
        XCTAssertNil(ScreenGeometry.screenIndex(forWindow: CGRect(x: 5000, y: 0, width: 100, height: 100), screenFrames: screens, primaryHeight: 900))
    }

    /// ウィンドウの外にはみ出した分は切り詰める。重ならない・小さすぎるなら nil
    func testRelRectClipsToWindowAndRejectsOutside() {
        let window = CGRect(x: 100, y: 100, width: 1000, height: 500)
        assertRel(ScreenGeometry.relRect(selection: CGRect(x: 50, y: 80, width: 150, height: 70), windowFrame: window), 0, 0, 0.1, 0.1)
        XCTAssertNil(ScreenGeometry.relRect(selection: CGRect(x: 0, y: 0, width: 50, height: 50), windowFrame: window))
        XCTAssertNil(ScreenGeometry.relRect(selection: CGRect(x: 200, y: 200, width: 2, height: 40), windowFrame: window))
        XCTAssertNil(ScreenGeometry.relRect(selection: CGRect(x: 200, y: 200, width: 40, height: 40), windowFrame: .zero))
    }

    /// 比率 ↔ CG 矩形は往復で一致する
    func testRelRectRoundTrip() {
        let window = CGRect(x: -1800, y: 100, width: 1000, height: 800)
        let sel = CGRect(x: -1234, y: 345, width: 67, height: 21)
        let rel = try! XCTUnwrap(ScreenGeometry.relRect(selection: sel, windowFrame: window))
        assertRect(ScreenGeometry.cgRect(rel: rel, windowFrame: window), sel)
    }

    /// Retina（2 倍）: 撮影画像はポイント × 2 のピクセル数。比率で保存するので、読み取り側の pixelRect がそのまま 2 倍の位置を指す
    func testRetinaPixelRectFromPointSelection() {
        let window = CGRect(x: 0, y: 25, width: 1024, height: 800)  // ポイント（y=25 はメニューバーの下）
        let sel = CGRect(x: 768, y: 625, width: 128, height: 50)    // ウィンドウ内の (768, 600)
        let rel = try! XCTUnwrap(ScreenGeometry.relRect(selection: sel, windowFrame: window))
        XCTAssertEqual(rel.pixelRect(width: 2048, height: 1600), CGRect(x: 1536, y: 1200, width: 256, height: 100))
        XCTAssertEqual(rel.pixelRect(width: 1024, height: 800), CGRect(x: 768, y: 600, width: 128, height: 50))
    }

    /// 選んだ領域を画像から切り出したものが、設定画面に出す拡大表示の元になる（Retina の画像で読めること）
    @MainActor
    func testCropFromRetinaImageIsReadable() throws {
        let img = TestImages.render(width: 2048, height: 1600, labels: [.init(text: "3,021.5", origin: CGPoint(x: 1620, y: 1170), fontSize: 48)])
        let window = CGRect(x: 0, y: 0, width: 1024, height: 800)
        let rel = try XCTUnwrap(ScreenGeometry.relRect(selection: CGRect(x: 800, y: 575, width: 160, height: 50), windowFrame: window))
        let crop = try XCTUnwrap(SettingsModel.crop(img, rel))
        XCTAssertEqual(crop.width, 320)
        XCTAssertEqual(crop.height, 100)
        XCTAssertEqual(PriceParser.parse(TextReader.read(img, region: rel).text), "3021.5")
        let shown = RegionResult.displaySize(crop)
        XCTAssertEqual(shown.height, 64, accuracy: 1e-9)
    }
}

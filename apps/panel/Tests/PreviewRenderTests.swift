import AppKit
import SwiftUI
import XCTest
@testable import PanelKit

/// 見た目の確認用に、小窓と設定画面をオフスクリーンで PNG に書き出す（画面には一切出さない）。
/// 出力先: apps/panel/shots-dev/（gitignore 済み）
@MainActor
final class PreviewRenderTests: XCTestCase {
    static var outDir: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shots-dev", isDirectory: true)
    }

    override func setUp() async throws {
        // テストプロセスが Dock に出たり前面に来たりしないように
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        try FileManager.default.createDirectory(at: Self.outDir, withIntermediateDirectories: true)
    }

    /// NSHostingView を表示しないウィンドウに載せて描画する（ImageRenderer は AppKit の部品を描けないため）
    private func render<V: View>(_ view: V, size: CGSize, dark: Bool, name: String) throws {
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: true)
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        let host = NSHostingView(rootView: view.background(Color(nsColor: .windowBackgroundColor)))
        host.frame = NSRect(origin: .zero, size: size)
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        host.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        let data = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
        let url = Self.outDir.appendingPathComponent("\(name).png")
        try data.write(to: url)
        print("preview: \(url.path)")
        XCTAssertGreaterThan(data.count, 2000)
    }

    private func sampleStore() throws -> (PanelStore, Date) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let suite = "panel-preview-\(UUID().uuidString)"
        let settings = PanelSettings(defaults: UserDefaults(suiteName: suite)!)
        let log = EventLog(folder: dir)
        let t0 = JST.parse("2026-10-05T09:03:10.120+09:00")!
        let long = UUID(), short = UUID(), pendingPos = UUID()
        let limitOrder = OrderEvent(ts: t0.addingTimeInterval(200), positionID: pendingPos, intent: .open, symbol: "6758",
                                    side: .buy, qty: "100", orderType: .limit, limitPrice: "3120")
        let events: [PaperEvent] = [
            .order(OrderEvent(ts: t0, positionID: long, intent: .open, symbol: "7203", side: .buy, qty: "100", orderType: .market,
                              shot: Shot(path: "shots/a.png", priceText: "2,345.5", price: "2345.5"))),
            .order(OrderEvent(ts: t0.addingTimeInterval(60), positionID: long, intent: .add, symbol: "7203", side: .buy, qty: "200",
                              orderType: .market, shot: Shot(path: "shots/b.png", priceText: "2,350", price: "2350"))),
            .order(OrderEvent(ts: t0.addingTimeInterval(120), positionID: short, intent: .open, symbol: "285A", side: .sell,
                              qty: "300", orderType: .market, shot: nil)),
            .order(limitOrder),
        ]
        for e in events { try log.append(e) }
        let store = PanelStore(settings: settings, shotTaker: FakeShotTaker { _, _, _ in nil })
        store.open(folder: dir)
        store.symbol = "7203"
        store.qtyText = "100"
        store.orderType = .limit
        store.limitPriceText = "2,360"
        store.memoText = "寄り後の押し目で拾った。出来高が増えている"
        store.memoTarget = long
        return (store, t0.addingTimeInterval(432))
    }

    func testRenderPanel() throws {
        let (store, now) = try sampleStore()
        for dark in [false, true] {
            try render(PanelView(store: store, openSettings: {}, now: now), size: CGSize(width: 360, height: 620), dark: dark,
                       name: dark ? "panel-dark" : "panel-light")
        }
    }

    func testRenderEmptyPanel() throws {
        let suite = "panel-preview-\(UUID().uuidString)"
        let store = PanelStore(settings: PanelSettings(defaults: UserDefaults(suiteName: suite)!), shotTaker: FakeShotTaker { _, _, _ in nil })
        try render(PanelView(store: store, openSettings: {}, now: Date()), size: CGSize(width: 360, height: 440), dark: false, name: "panel-empty")
    }

    func testRenderSettings() throws {
        let (store, _) = try sampleStore()
        store.settings.priceRegion = RelRect(x: 0.66, y: 0.72, w: 0.24, h: 0.1)
        store.settings.symbolRegion = RelRect(x: 0.02, y: 0.02, w: 0.12, h: 0.07)
        let fakeWindow = TestImages.render(width: 1200, height: 800, labels: [
            .init(text: "7203", origin: CGPoint(x: 40, y: 30), fontSize: 28),
            .init(text: "3,021.5", origin: CGPoint(x: 820, y: 600), fontSize: 40),
        ])
        try render(SettingsView(store: store, preview: fakeWindow), size: CGSize(width: 600, height: 900), dark: false, name: "settings")
    }
}

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
        store.settings.priceRegion = RelRect(x: 0.66, y: 0.72, w: 0.165, h: 0.1)
        store.settings.symbolRegion = RelRect(x: 0.02, y: 0.02, w: 0.12, h: 0.07)
        let fakeWindow = TestImages.render(width: 1200, height: 800, labels: [
            .init(text: "7203", origin: CGPoint(x: 40, y: 30), fontSize: 28),
            .init(text: "現在値", origin: CGPoint(x: 660, y: 606), fontSize: 30),
            .init(text: "3,021.5", origin: CGPoint(x: 820, y: 600), fontSize: 40),
            .init(text: "C 15:30", origin: CGPoint(x: 1010, y: 606), fontSize: 30),
        ])
        try render(SettingsView(store: store, preview: fakeWindow, previewTitle: "全板　トヨタ自動車(7203)"),
                   size: CGSize(width: 600, height: 1000), dark: false, name: "settings")
    }

    /// ネッティングの表示: 押す前の 1 行（買い増し／ドテン）、ドテンの予告、待機中のドテン指値（1 行にまとめる）
    func testRenderNettingAndFlipPreview() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let settings = PanelSettings(defaults: UserDefaults(suiteName: "panel-preview-\(UUID().uuidString)")!)
        let log = EventLog(folder: dir)
        let t0 = JST.parse("2026-10-05T09:12:00.000+09:00")!
        let long = UUID(), short = UUID()
        let events: [PaperEvent] = [
            .order(OrderEvent(ts: t0, positionID: long, intent: .open, symbol: "5803", side: .buy, qty: "200", orderType: .market,
                              shot: Shot(path: "shots/a.png", priceText: "5,566", price: "5566"))),
            .order(OrderEvent(ts: t0.addingTimeInterval(30), positionID: short, intent: .open, symbol: "285A", side: .sell, qty: "300",
                              orderType: .market, shot: Shot(path: "shots/b.png", priceText: "2,810", price: "2810"))),
            // 285A の指値ドテン（決済 300 ＋ 新規買い 100）が待機中
            .order(OrderEvent(ts: t0.addingTimeInterval(90), positionID: short, intent: .close, symbol: "285A", side: .buy, qty: "300",
                              orderType: .limit, limitPrice: "2780", shot: nil)),
            .order(OrderEvent(ts: t0.addingTimeInterval(90), positionID: UUID(), intent: .open, symbol: "285A", side: .buy, qty: "100",
                              orderType: .limit, limitPrice: "2780", shot: nil)),
        ]
        for e in events { try log.append(e) }
        let store = PanelStore(settings: settings, shotTaker: FakeShotTaker { _, _, _ in nil })
        store.open(folder: dir)
        store.symbol = "5803"
        store.qtyText = "300"
        store.orderType = .market
        let now = t0.addingTimeInterval(200)
        try render(PanelView(store: store, openSettings: {}, now: now), size: CGSize(width: 360, height: 620), dark: false,
                   name: "panel-netting-light")
        store.placeOrder(side: .sell)  // ドテンなので 1 回目は予告だけ
        XCTAssertEqual(store.armedFlip, .sell)
        try render(PanelView(store: store, openSettings: {}, now: now), size: CGSize(width: 360, height: 620), dark: true,
                   name: "panel-flip-armed-dark")
    }

    // MARK: 録画リプレイ練習

    /// data/paper/replay/recordings/ に合成の録画を置き、その練習中の小窓・再生ウィンドウを描く
    private func replayStore() async throws -> (PanelStore, ReplaySession, URL) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let settings = PanelSettings(defaults: UserDefaults(suiteName: "panel-preview-\(UUID().uuidString)")!)
        let started = JST.parse("2026-10-06T08:53:12.345+09:00")!
        let id = "20261006-085300"
        let files = RecordingPaths.files(dataFolder: dir, id: id, day: "2026-10-06")
        let img = ReplayModeTests.twoBoards()
        try await SyntheticVideo.write(url: files.mp4, width: 1200, height: 400, frames: [(ms: 0, image: img)], endMs: 2000)
        var meta = RecordingMeta(id: id, status: .done, width: 1200, height: 400, plannedMinutes: 37, startedAt: started)
        meta.endedAt = started.addingTimeInterval(37 * 60)
        meta.samples = [RecSample(tMs: 0, windows: [ReplayModeTests.left, ReplayModeTests.right])]
        try meta.write(to: files.json)
        let store = PanelStore(settings: settings, shotTaker: FakeShotTaker { _, _, _ in nil })
        store.makeReplayTaker = { _ in
            FakeShotTaker { id, ts, log in Shot(path: log.shotLocation(eventID: id, ts: ts).relative, priceText: "3,021.5", price: "3021.5",
                                                capturedAt: ts) }
        }
        store.open(folder: dir)
        let entry = try XCTUnwrap(RecordingEntry.scan(dataFolder: dir).first)
        let session = try XCTUnwrap(ReplaySession(entry: entry))
        await store.enterReplay(session)
        return (store, session, dir)
    }

    func testRenderReplayPanel() async throws {
        let (store, session, _) = try await replayStore()
        session.windowOpen = true
        session.isPlaying = true
        session.positionOverride = 483_123
        store.symbol = "6758"
        store.qtyText = "100"
        store.orderType = .market
        store.placeOrder(side: .buy)
        await store.flush()
        store.memoText = "板の厚い 3,020 で拾う"
        let now = ReplayClock.ts(startedAt: session.startedAt, videoMs: 540_000)
        try render(PanelView(store: store, openSettings: {}, now: now), size: CGSize(width: 360, height: 620), dark: false,
                   name: "panel-replay-light")
        session.isPlaying = false
        try render(PanelView(store: store, openSettings: {}, now: now), size: CGSize(width: 360, height: 620), dark: true,
                   name: "panel-replay-paused-dark")
        await store.exitReplay()
    }

    func testRenderReplayPlayer() async throws {
        let (store, session, _) = try await replayStore()
        session.windowOpen = true
        session.positionOverride = 483_123
        try render(ReplayPlayerView(session: session), size: CGSize(width: 1100, height: 520), dark: false, name: "replay-player")
        await store.exitReplay()
    }

    /// 設定の「録画」: 録画中の状態、保存済みの一覧（成功・失敗・途中で止めた録画）と合計サイズ
    func testRenderSettingsRecording() async throws {
        let (store, _, dir) = try await replayStore()
        await store.exitReplay()
        let started = JST.parse("2026-10-07T08:53:04.120+09:00")!
        var failed = RecordingMeta(id: "20261007-085300", status: .failed)
        failed.endedAt = started
        failed.issues = [RecIssue(at: started, tMs: nil, kind: "no_permission", message: "画面収録の許可がありません")]
        try failed.write(to: RecordingPaths.files(dataFolder: dir, id: failed.id, day: "2026-10-07").json)
        let s2 = JST.parse("2026-10-08T08:53:03.500+09:00")!
        var stopped = RecordingMeta(id: "20261008-085300", status: .stopped, width: 1200, height: 400, plannedMinutes: 37, startedAt: s2)
        stopped.endedAt = s2.addingTimeInterval(21 * 60)
        stopped.issues = [RecIssue(at: s2.addingTimeInterval(300), tMs: 300_000, kind: "black", message: "画面が真っ黒です（ロック・スリープの疑い）")]
        let f2 = RecordingPaths.files(dataFolder: dir, id: stopped.id, day: "2026-10-08")
        try stopped.write(to: f2.json)
        try Data(repeating: 0, count: 180_000_000 / 1000).write(to: f2.mp4)
        store.recording.isRecording = true
        store.recording.statusLine = "録画中 08:57 / 残り 33 分"
        try render(SettingsView(store: store), size: CGSize(width: 600, height: 1400), dark: false, name: "settings-recording")
    }
}

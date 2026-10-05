import AVFoundation
import CoreGraphics
import ImageIO
import XCTest
@testable import PanelKit

/// 録画リプレイ練習（時刻の換算・記録先の分離・発注の可否・全板の切り出し）。画面収録は使わず、合成した録画で確かめる
@MainActor
final class ReplayModeTests: XCTestCase {
    var dir: URL!
    var defaults: UserDefaults!
    let started = JST.parse("2026-10-06T08:53:12.345+09:00")!

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let suite = "panel-replay-tests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
        defaults.removePersistentDomain(forName: suite)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: dir)
    }

    /// 全板 2 枚（左 トヨタ 7203 / 右 ソニー 6758）が並んだ 1200x400 の画面
    static let left = RecWindow(title: "全板　トヨタ自動車(7203)", frame: RecRect(x: 0, y: 0, w: 600, h: 400))
    static let right = RecWindow(title: "全板　ソニーグループ(6758)", frame: RecRect(x: 600, y: 0, w: 600, h: 400))

    static func twoBoards() -> CGImage {
        let ctx = CGContext(data: nil, width: 1200, height: 400, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        // 左は青み・右は黄み（切り出した側を色で見分ける）
        ctx.setFillColor(CGColor(red: 0.80, green: 0.87, blue: 1.0, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: 600, height: 400))
        ctx.setFillColor(CGColor(red: 1.0, green: 0.95, blue: 0.75, alpha: 1))
        ctx.fill(CGRect(x: 600, y: 0, width: 600, height: 400))
        let labels = TestImages.render(width: 1200, height: 400, labels: [
            .init(text: "現在値", origin: CGPoint(x: 40, y: 160), fontSize: 40),
            .init(text: "2,345.5", origin: CGPoint(x: 200, y: 160), fontSize: 40),
            .init(text: "現在値", origin: CGPoint(x: 640, y: 160), fontSize: 40),
            .init(text: "3,021.5", origin: CGPoint(x: 800, y: 160), fontSize: 40),
        ], background: CGColor(gray: 1, alpha: 0))
        ctx.draw(labels, in: CGRect(x: 0, y: 0, width: 1200, height: 400))
        return ctx.makeImage()!
    }

    /// data/paper/replay/recordings/2026-10-06/<id>.{mp4,json} を作って一覧から返す
    private func makeRecording(id: String = "20261006-085300", samples: [RecSample]? = nil) async throws -> RecordingEntry {
        let files = RecordingPaths.files(dataFolder: dir, id: id, day: "2026-10-06")
        let img = Self.twoBoards()
        try await SyntheticVideo.write(url: files.mp4, width: 1200, height: 400, frames: [(ms: 0, image: img), (ms: 100, image: img)], endMs: 3000)
        var meta = RecordingMeta(id: id, status: .done, width: 1200, height: 400, plannedMinutes: 37, startedAt: started)
        meta.endedAt = started.addingTimeInterval(3)
        meta.samples = samples ?? [RecSample(tMs: 0, windows: [Self.left, Self.right])]
        try meta.write(to: files.json)
        return try XCTUnwrap(RecordingEntry.scan(dataFolder: dir).first { $0.id == id })
    }

    private func loadPNG(_ url: URL) throws -> CGImage {
        let src = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
        return try XCTUnwrap(CGImageSourceCreateImageAtIndex(src, 0, nil))
    }

    // MARK: 時刻

    func testReplayClockIsMillisecondExact() throws {
        let ts = ReplayClock.ts(startedAt: started, videoMs: 483_123)
        XCTAssertEqual(JST.format(ts), "2026-10-06T09:01:15.468+09:00")
        XCTAssertEqual(ReplayClock.videoMs(ts: ts, startedAt: started), 483_123)
        // 1 ミリ秒ずつ足しても .999 等にずれない
        for ms in [0, 1, 999, 1000, 37 * 60 * 1000 - 1] {
            let t = ReplayClock.ts(startedAt: started, videoMs: ms)
            XCTAssertEqual(ReplayClock.videoMs(ts: t, startedAt: started), ms)
            XCTAssertEqual(JST.parse(JST.format(t)).map { ReplayClock.videoMs(ts: $0, startedAt: started) }, ms, "書いた文字列から戻しても同じ")
        }
        XCTAssertEqual(ReplayClock.videoMs(CMTime(value: 1999, timescale: 1000)), 1999)
        XCTAssertEqual(ReplayClock.videoMs(CMTime(value: 2999, timescale: 600)), 4998, "切り捨て（押した位置より後にしない）")
        XCTAssertEqual(ReplayClock.videoMs(.invalid), 0)
        XCTAssertEqual(ReplayClock.cmTime(videoMs: 483_123), CMTime(value: 483_123, timescale: 1000))
        XCTAssertEqual(ReplaySession.label(ts), "2026-10-06 09:01:15")
    }

    // MARK: 再生ウィンドウの大きさ

    func testReplayWindowInitialSizeFitsScreen() {
        // 1512x949 の画面に 3024x1964 の録画 → 高さで決まる（縦横比を保つ）
        let s = ReplayWindowSize.initial(visible: CGSize(width: 1512, height: 949), videoWidth: 3024, videoHeight: 1964)
        XCTAssertLessThanOrEqual(s.width, 1512 * 0.85 + 0.5)
        XCTAssertLessThanOrEqual(s.height, 949 * 0.85 + 0.5)
        XCTAssertEqual(Double(s.width / (s.height - ReplayWindowSize.headerHeight)), 3024.0 / 1964.0, accuracy: 0.01)
        XCTAssertGreaterThan(s.width, 1100, "以前の固定 1100 より大きく出す")
        // 横長の録画 → 幅で決まる
        let wide = ReplayWindowSize.initial(visible: CGSize(width: 2560, height: 1400), videoWidth: 5120, videoHeight: 1440)
        XCTAssertEqual(wide.width, 2176)
        // 大きさの分からない録画は画面の 85%
        XCTAssertEqual(ReplayWindowSize.initial(visible: CGSize(width: 1000, height: 800), videoWidth: 0, videoHeight: 0), CGSize(width: 850, height: 680))
    }

    // MARK: 切り出す全板の選択

    func testCropChoice() {
        let ws = [Self.left, Self.right, RecWindow(title: "ポートフォリオ", frame: RecRect(x: 0, y: 0, w: 100, h: 100))]
        XCTAssertEqual(ReplayCrop.choose(windows: ws, symbol: "6758"), .init(window: Self.right, ambiguous: false))
        XCTAssertEqual(ReplayCrop.choose(windows: ws, symbol: " 7203 "), .init(window: Self.left, ambiguous: false))
        XCTAssertEqual(ReplayCrop.choose(windows: ws, symbol: "9984"), .init(window: nil, ambiguous: true), "どれも合わなければ全体・現在値は使わない")
        XCTAssertEqual(ReplayCrop.choose(windows: [Self.right], symbol: "9984"), .init(window: Self.right, ambiguous: true),
                       "1 つだけの全板が別の銘柄なら切り出すが、現在値は使わない")
        XCTAssertEqual(ReplayCrop.choose(windows: [Self.right], symbol: ""), .init(window: Self.right, ambiguous: true),
                       "発注銘柄が分からなければ一致を確かめられないので現在値は使わない")
        let untitled = RecWindow(title: "全板", frame: RecRect(x: 0, y: 0, w: 600, h: 400))
        XCTAssertEqual(ReplayCrop.choose(windows: [untitled], symbol: "6758"), .init(window: untitled, ambiguous: true),
                       "タイトルにコードが無い 1 つだけの全板は切り出すが、発注銘柄と確かめられないので現在値は使わない")
        XCTAssertEqual(ReplayCrop.choose(windows: [], symbol: "6758"), .init(window: nil, ambiguous: true),
                       "全板が無いフレーム全体の OCR は銘柄不明なので現在値を使わない")
        XCTAssertEqual(ReplayCrop.choose(windows: [ws[2]], symbol: "6758"), .init(window: nil, ambiguous: true))
        XCTAssertEqual(ReplayCrop.choose(windows: [Self.left, Self.right], symbol: "285a"),
                       .init(window: nil, ambiguous: true))
    }

    // MARK: 行の形

    func testReplayLineHasAllNormalKeysPlusReplay() throws {
        let sid = UUID()
        let o = OrderEvent(ts: ReplayClock.ts(startedAt: started, videoMs: 483_123), positionID: UUID(), intent: .open, symbol: "6758",
                           side: .buy, qty: "100", orderType: .market, shot: Shot(path: "replay/shots/2026-10-06/x.png"))
        let normal = try EventCoding.line(.order(o))
        let tagged = try EventCoding.line(.order(o), replay: ReplayRef(recordingID: "20261006-085300", sessionID: sid, videoMs: 483_123))
        let a = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(normal.utf8)) as? [String: Any])
        let b = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(tagged.utf8)) as? [String: Any])
        XCTAssertEqual(Set(b.keys), Set(a.keys).union(["replay"]))
        XCTAssertEqual(b["v"] as? Int, 1, "v は 1 のまま")
        XCTAssertEqual(b["ts"] as? String, "2026-10-06T09:01:15.468+09:00")
        let r = try XCTUnwrap(b["replay"] as? [String: Any])
        XCTAssertEqual(r["recording_id"] as? String, "20261006-085300")
        XCTAssertEqual(r["session_id"] as? String, sid.uuidString.lowercased())
        XCTAssertEqual(r["video_ms"] as? Int, 483_123)
        XCTAssertEqual(try EventCoding.decode(line: tagged), .order(o), "通常の読み手は replay を無視して読める")
        XCTAssertEqual(EventCoding.replayRef(line: tagged), ReplayRef(recordingID: "20261006-085300", sessionID: sid, videoMs: 483_123))
        XCTAssertNil(EventCoding.replayRef(line: normal))
    }

    // MARK: 記録先の分離と発注の可否

    func testReplayWritesSeparateLogAndRestoresNormalBook() async throws {
        let settings = PanelSettings(defaults: defaults)
        let fake = FakeShotTaker { id, ts, log in Shot(path: log.shotLocation(eventID: id, ts: ts).relative, capturedAt: ts) }
        let store = PanelStore(settings: settings, shotTaker: FakeShotTaker { _, _, _ in nil })
        store.makeReplayTaker = { _ in fake }
        var presented: [ReplaySession] = []
        var dismissed = 0
        store.presentReplayWindow = { presented.append($0) }
        store.dismissReplayWindow = { dismissed += 1 }
        store.open(folder: dir)

        // 通常のペーパーの建玉を 1 つ持っておく
        store.symbol = "7203"
        store.qtyText = "100"
        store.orderType = .market
        store.placeOrder(side: .buy)
        await store.flush()
        let normalURL = dir.appendingPathComponent("events.jsonl")
        let normalBefore = try String(contentsOf: normalURL, encoding: .utf8)
        XCTAssertEqual(store.book.openPositions.count, 1)

        let entry = try await makeRecording()
        XCTAssertTrue(entry.canReplay)
        let session = try XCTUnwrap(ReplaySession(entry: entry))
        await store.enterReplay(session)
        XCTAssertTrue(store.replay === session)
        XCTAssertEqual(presented.count, 1, "再生ウィンドウを出す")
        XCTAssertTrue(store.book.openPositions.isEmpty, "練習は空の建玉から始める（通常の建玉と混ぜない）")
        XCTAssertTrue(store.events.isEmpty)

        store.symbol = "6758"
        store.qtyText = "200"
        store.orderType = .market
        session.positionOverride = 483_123
        XCTAssertFalse(store.canOrder, "一時停止中（再生前）は発注できない")
        session.windowOpen = true
        XCTAssertFalse(store.canOrder, "ウィンドウがあっても再生していなければ発注できない")
        session.isPlaying = true
        XCTAssertTrue(store.canOrder)
        store.placeOrder(side: .buy)
        await store.flush()
        let pid = try XCTUnwrap(store.book.openPositions.first?.id)

        // 一時停止: 全決済・約定・取消は押せない（何も書かない）、メモは書ける
        session.isPlaying = false
        XCTAssertTrue(store.replayBlocked)
        XCTAssertFalse(store.canOrder)
        let count = store.events.count
        store.closeAll(positionID: pid)
        XCTAssertEqual(store.events.count, count, "一時停止中の全決済は何もしない")
        session.positionOverride = 490_000
        store.memoText = "押し目を待つ"
        XCTAssertTrue(store.canSaveMemo)
        store.saveMemo()
        // 再生ウィンドウを閉じた時も押せない
        session.isPlaying = true
        session.windowOpen = false
        XCTAssertFalse(store.canOrder)
        await store.flush()

        let replayLines = try String(contentsOf: dir.appendingPathComponent("replay/events.jsonl"), encoding: .utf8)
            .split(separator: "\n").map(String.init)
        XCTAssertEqual(replayLines.count, 2)
        guard case .order(let o) = try EventCoding.decode(line: replayLines[0]) else { return XCTFail("1 行目は order") }
        XCTAssertEqual(JST.format(o.ts), "2026-10-06T09:01:15.468+09:00", "ts = started_at + video_ms")
        XCTAssertEqual(o.symbol, "6758")
        XCTAssertTrue(o.shot?.path.hasPrefix("replay/shots/") == true, "スクショは data/paper/ からの相対で replay/ の下: \(o.shot?.path ?? "nil")")
        XCTAssertEqual(EventCoding.replayRef(line: replayLines[0]),
                       ReplayRef(recordingID: "20261006-085300", sessionID: session.sessionID, videoMs: 483_123))
        guard case .memo(let m) = try EventCoding.decode(line: replayLines[1]) else { return XCTFail("2 行目は memo") }
        XCTAssertEqual(m.positionID, pid)
        XCTAssertEqual(EventCoding.replayRef(line: replayLines[1])?.videoMs, 490_000, "一時停止中のメモは再生位置の時刻")
        XCTAssertEqual(try String(contentsOf: normalURL, encoding: .utf8), normalBefore, "通常の events.jsonl は変わらない")

        // 練習を終えると通常の建玉に戻る
        await store.exitReplay()
        XCTAssertNil(store.replay)
        XCTAssertEqual(dismissed, 1)
        XCTAssertEqual(store.book.openPositions.map(\.symbol), ["7203"])
        XCTAssertFalse(store.replayBlocked)

        // もう一度始めると新しい session_id・空の建玉
        let again = try XCTUnwrap(ReplaySession(entry: entry))
        XCTAssertNotEqual(again.sessionID, session.sessionID)
        await store.enterReplay(again)
        XCTAssertTrue(store.book.openPositions.isEmpty)
        await store.exitReplay()
    }

    /// リプレイ中に記録先を選び直しても、通常の events.jsonl を読み込まない（印の無い行が通常側に書かれるのを防ぐ）
    func testReplayKeepsLogWhenFolderIsReopened() async throws {
        let store = PanelStore(settings: PanelSettings(defaults: defaults), shotTaker: FakeShotTaker { _, _, _ in nil })
        store.makeReplayTaker = { _ in FakeShotTaker { _, _, _ in nil } }
        store.open(folder: dir)
        let entry = try await makeRecording()
        let session = try XCTUnwrap(ReplaySession(entry: entry))
        await store.enterReplay(session)

        let other = dir.appendingPathComponent("other")
        try FileManager.default.createDirectory(at: other, withIntermediateDirectories: true)
        store.open(folder: other)
        XCTAssertTrue(store.replay === session, "練習は続いている")
        XCTAssertEqual(store.dataFolder, dir, "記録先は変わらない")
        XCTAssertEqual(store.status, PanelStore.folderLockedInReplay)
        store.chooseDataFolder()
        XCTAssertEqual(store.status, PanelStore.folderLockedInReplay, "選ぶ画面も出さない")

        store.symbol = "6758"
        store.qtyText = "100"
        store.orderType = .market
        session.positionOverride = 1000
        session.windowOpen = true
        session.isPlaying = true
        store.placeOrder(side: .buy)
        await store.flush()
        let replayLines = try String(contentsOf: dir.appendingPathComponent("replay/events.jsonl"), encoding: .utf8)
            .split(separator: "\n").map(String.init)
        XCTAssertEqual(replayLines.count, 1)
        XCTAssertNotNil(EventCoding.replayRef(line: replayLines[0]), "リプレイの印付きで replay/ に書く")
        XCTAssertFalse(FileManager.default.fileExists(atPath: other.appendingPathComponent("events.jsonl").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("events.jsonl").path))
        await store.exitReplay()
        store.open(folder: other)
        XCTAssertEqual(store.dataFolder, other, "練習を終えた後は選び直せる")
    }

    /// 建てた後に録画を巻き戻して決済すると、決済の時刻が建てた時刻より前になる。最後に記録した位置より前には戻さない
    func testReplayCannotGoBeforeLastRecordedEvent() async throws {
        let store = PanelStore(settings: PanelSettings(defaults: defaults), shotTaker: FakeShotTaker { _, _, _ in nil })
        store.makeReplayTaker = { _ in FakeShotTaker { _, _, _ in nil } }
        store.open(folder: dir)
        let entry = try await makeRecording()
        let session = try XCTUnwrap(ReplaySession(entry: entry))
        await store.enterReplay(session)
        XCTAssertEqual(session.floorMs, 0)

        store.symbol = "6758"
        store.qtyText = "100"
        store.orderType = .market
        session.windowOpen = true
        session.isPlaying = true
        session.positionOverride = 2000
        store.placeOrder(side: .buy)
        await store.flush()
        let pid = try XCTUnwrap(store.book.openPositions.first?.id)
        XCTAssertEqual(session.floorMs, 2000, "最後に記録した位置が床になる")

        // 床より前の位置では発注・全決済とも押せない
        session.positionOverride = 1500
        XCTAssertFalse(session.canTrade)
        XCTAssertTrue(store.replayBlocked)
        XCTAssertFalse(store.canOrder)
        let count = store.events.count
        store.closeAll(positionID: pid)
        store.placeOrder(side: .sell)
        XCTAssertEqual(store.events.count, count, "巻き戻した位置では何も書かない")

        // 再生位置の更新で床より前に来たら床に戻し、理由を出す
        session.positionOverride = nil
        session.handleTime(500)
        XCTAssertEqual(session.videoMs, 2000)
        let notice = try XCTUnwrap(session.floorNotice)
        XCTAssertTrue(notice.contains("08:53:14"), notice)
        XCTAssertTrue(notice.contains("練習を終える"), notice)
        session.handleTime(2500)
        XCTAssertEqual(session.videoMs, 2500, "床より後は普通に進む")

        // 床と同じか後の位置なら決済できる。決済の時刻は建てた時刻より前にならない
        session.positionOverride = 2600
        store.closeAll(positionID: pid)
        await store.flush()
        let ts = store.events.compactMap { e -> Date? in if case .order(let o) = e { return o.ts } else { return nil } }
        XCTAssertEqual(ts.count, 2)
        XCTAssertLessThanOrEqual(ts[0], ts[1])

        // 録画を開き直した新しい練習は最初から
        await store.exitReplay()
        let again = try XCTUnwrap(ReplaySession(entry: entry))
        await store.enterReplay(again)
        XCTAssertEqual(again.floorMs, 0)
        XCTAssertNil(again.floorNotice)
        await store.exitReplay()
    }

    // MARK: 全板の切り出し（録画のフレームから）

    func testReplayShotCropsOrderedSymbolsBoard() async throws {
        let entry = try await makeRecording(samples: [
            RecSample(tMs: 0, windows: [Self.left, Self.right]),
            RecSample(tMs: 1000, windows: [Self.right]),
            RecSample(tMs: 2000, windows: []),
        ])
        let meta = try XCTUnwrap(entry.meta)
        var position = 500
        let taker = ReplayShotTaker(videoURL: entry.mp4, meta: meta, startedAt: started) { position }
        let log = EventLog(folder: RecordingPaths.replayFolder(dir),
                           replay: ReplayTag(recordingID: meta.id, sessionID: UUID(), startedAt: started))

        func shot(_ ms: Int, _ symbol: String) async throws -> (Shot, CGImage, OCRSidecar) {
            let ts = ReplayClock.ts(startedAt: started, videoMs: ms)
            let taken = await taker.takeShot(eventID: UUID(), ts: ts, log: log, symbol: symbol)
            let s = try XCTUnwrap(taken)
            await taker.waitForBackground()
            XCTAssertEqual(s.capturedAt, ts, "録画のフレームなので撮影の遅れは 0")
            XCTAssertTrue(s.path.hasPrefix("replay/shots/"))
            let base = dir!
            let img = try loadPNG(base.appendingPathComponent(s.path))
            let side = try XCTUnwrap(OCRSidecar.load(base.appendingPathComponent(try XCTUnwrap(s.ocrPath))))
            return (s, img, side)
        }

        // 2 枚並んでいて、発注銘柄（6758）の板だけを切り出す
        let (s1, img1, side1) = try await shot(500, "6758")
        XCTAssertEqual(img1.width, 600)
        XCTAssertEqual(img1.height, 400)
        XCTAssertEqual(s1.windowTitle, Self.right.title)
        let c1 = SyntheticVideo.averageColor(img1, in: CGRect(x: 10, y: 300, width: 100, height: 80))
        XCTAssertGreaterThan(c1.r, c1.b + 30, "右（黄み）の板: \(c1)")
        XCTAssertEqual(side1.auto.price, "3021.5")
        XCTAssertEqual(side1.auto.symbol, "6758")

        let (_, img2, side2) = try await shot(500, "7203")
        XCTAssertEqual(img2.width, 600)
        let c2 = SyntheticVideo.averageColor(img2, in: CGRect(x: 10, y: 300, width: 100, height: 80))
        XCTAssertGreaterThan(c2.b, c2.r + 20, "左（青み）の板: \(c2)")
        XCTAssertEqual(side2.auto.price, "2345.5")

        // どれも合わない → フレーム全体・現在値は使わない
        let (s3, img3, side3) = try await shot(500, "9984")
        XCTAssertEqual(img3.width, 1200)
        XCTAssertNil(s3.windowTitle)
        XCTAssertNil(side3.auto.price, "どちらの板か分からないので現在値を使わない")
        XCTAssertNil(side3.auto.source)

        // 1.5 秒の時点では全板は 6758 だけ。別の銘柄で発注しても切り出すが、現在値は使わない
        let (_, img4, side4) = try await shot(1500, "9984")
        XCTAssertEqual(img4.width, 600)
        XCTAssertNil(side4.auto.price)

        // 2.5 秒の時点では全板が無い → フレーム全体。銘柄が確かめられないので一番上の現在値を拾わない
        let (s5, img5, side5) = try await shot(2500, "6758")
        XCTAssertEqual(img5.width, 1200)
        XCTAssertNil(s5.windowTitle)
        XCTAssertNil(side5.auto.price, "全板が無いフレーム全体の OCR では現在値を使わない")

        // 銘柄コードの自動入力: 今の位置で全板が 1 つだけならそのコード
        position = 500
        let atTwo = await taker.readSymbol()
        XCTAssertNil(atTwo, "全板が 2 つの時は決めない")
        position = 1500
        let atOne = await taker.readSymbol()
        XCTAssertEqual(atOne, "6758")
    }
}

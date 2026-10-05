import AVFoundation
import AVKit
import Combine
import CoreGraphics
import Foundation
import SwiftUI
import os

/// 録画を再生しながらの練習 1 回分（録画を開くたびに新しい session_id）。
/// 速度は 1 倍だけ（J/L キー等で速めても 1 倍に戻す）。一時停止中・再生ウィンドウが無い時は発注できない
@MainActor
public final class ReplaySession: ObservableObject {
    public let entry: RecordingEntry
    public let meta: RecordingMeta
    public let startedAt: Date
    public let sessionID = UUID()
    public let player: AVPlayer
    /// 表示用の再生位置（0.1 秒ごとに更新）。発注時は currentVideoMs() で取り直す
    @Published public private(set) var videoMs = 0
    @Published public internal(set) var isPlaying = false
    @Published public var windowOpen = false
    /// この練習で最後に記録した発注・約定・取消の再生位置。これより前には戻さない
    /// （戻って決済すると決済の時刻が建てた時刻より前になり、振り返りで向きが逆に見えるため）
    @Published public private(set) var floorMs = 0
    /// 戻ろうとして止めた時の理由（小窓に 1 行出す）
    @Published public private(set) var floorNotice: String?
    /// テストで再生位置を固定する
    var positionOverride: Int?
    private var timeObserver: Any?
    private var rateObservation: NSKeyValueObservation?

    public init?(entry: RecordingEntry) {
        guard entry.canReplay, let meta = entry.meta, let started = meta.startedAt else { return nil }
        self.entry = entry
        self.meta = meta
        self.startedAt = started
        player = AVPlayer(url: entry.mp4)
        player.actionAtItemEnd = .pause
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 10), queue: .main) { [weak self] t in
            MainActor.assumeIsolated { self?.handleTime(ReplayClock.videoMs(t)) }
        }
        rateObservation = player.observe(\.rate, options: [.new]) { [weak self] player, _ in
            let rate = player.rate
            Task { @MainActor in
                guard let self else { return }
                // 練習は実時間で行う（倍速・逆再生は 1 倍に戻す）
                if rate != 0 && rate != 1 { self.player.rate = 1 }
                self.isPlaying = self.player.rate != 0
            }
        }
    }

    /// 発注できる状態（再生中で、再生ウィンドウが開いていて、最後に記録した位置より前に戻っていない）
    public var canTrade: Bool { isPlaying && windowOpen && currentVideoMs() >= floorMs }

    /// 記録した位置を床にする（PanelStore が建玉を計算し直すたびに渡す）
    func setFloor(_ ms: Int) {
        floorMs = max(0, ms)
    }

    /// 再生位置の更新。床より前へ動いたら床に戻して理由を出す
    func handleTime(_ ms: Int) {
        guard ms < floorMs else {
            videoMs = ms
            // 床を越えて 5 秒進んだら理由は消す
            if floorNotice != nil, ms >= floorMs + 5000 { floorNotice = nil }
            return
        }
        videoMs = floorMs
        floorNotice = "記録した \(JST.clock(ReplayClock.ts(startedAt: startedAt, videoMs: floorMs))) より前には戻れません（もっと前から練習するなら「練習を終える」→ 録画を開き直す）"
        player.seek(to: ReplayClock.cmTime(videoMs: floorMs), toleranceBefore: .zero, toleranceAfter: .zero)
    }

    /// 押した瞬間の再生位置（ミリ秒）
    public func currentVideoMs() -> Int { positionOverride ?? ReplayClock.videoMs(player.currentTime()) }

    /// 録画上の実時刻（表示用）
    public var realTime: Date { ReplayClock.ts(startedAt: startedAt, videoMs: positionOverride ?? videoMs) }

    public func close() {
        player.pause()
        if let timeObserver { player.removeTimeObserver(timeObserver) }
        timeObserver = nil
        rateObservation = nil
        isPlaying = false
    }

    /// 「2026-10-06 09:01:23」
    public static func label(_ date: Date) -> String { "\(JST.day(date)) \(JST.clock(date))" }
}

/// 再生ウィンドウの最初の大きさ: 画面（メニューバーと Dock を除く）の 85% に、録画の縦横比を保って収める
public enum ReplayWindowSize {
    /// 上の時刻の帯のぶん（動画の外）の高さ
    public static let headerHeight: CGFloat = 60

    public static func initial(visible: CGSize, videoWidth: Int, videoHeight: Int) -> CGSize {
        let maxW = visible.width * 0.85, maxH = visible.height * 0.85
        guard videoWidth > 0, videoHeight > 0, maxH > headerHeight else { return CGSize(width: maxW, height: maxH) }
        let scale = min(maxW / CGFloat(videoWidth), (maxH - headerHeight) / CGFloat(videoHeight))
        return CGSize(width: (CGFloat(videoWidth) * scale).rounded(), height: (CGFloat(videoHeight) * scale + headerHeight).rounded())
    }
}

/// リプレイの撮影: 押した瞬間の録画のフレーム（許容誤差 0）を取り出し、発注銘柄の全板ウィンドウを切り出して、通常と同じ形で保存・読み取る
public final class ReplayShotTaker: ShotTaking, @unchecked Sendable {
    public var onAutoRead: ((String, AutoRead) -> Void)?
    let meta: RecordingMeta
    let startedAt: Date
    private let generator: AVAssetImageGenerator
    /// 銘柄コードの自動入力に使う、今の再生位置
    private let position: @MainActor () -> Int
    private let lock = NSLock()
    private var background: [UUID: Task<Void, Never>] = [:]
    static let logger = Logger(subsystem: "com.tomato.tradelog.panel", category: "replay")

    public init(videoURL: URL, meta: RecordingMeta, startedAt: Date, position: @escaping @MainActor () -> Int) {
        self.meta = meta
        self.startedAt = startedAt
        self.position = position
        generator = AVAssetImageGenerator(asset: AVURLAsset(url: videoURL))
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        generator.appliesPreferredTrackTransform = true
    }

    @MainActor
    public convenience init(session: ReplaySession) {
        self.init(videoURL: session.entry.mp4, meta: session.meta, startedAt: session.startedAt) { [weak session] in
            session?.currentVideoMs() ?? 0
        }
    }

    public func takeShot(eventID: UUID, ts: Date, log: EventLog) async -> Shot? {
        await takeShot(eventID: eventID, ts: ts, log: log, symbol: "")
    }

    public func takeShot(eventID: UUID, ts: Date, log: EventLog, symbol: String) async -> Shot? {
        let videoMs = ReplayClock.videoMs(ts: ts, startedAt: startedAt)
        let frame: CGImage
        do {
            frame = try await generator.image(at: ReplayClock.cmTime(videoMs: videoMs)).image
        } catch {
            Self.logger.error("録画のフレームを取り出せない \(videoMs, privacy: .public)ms: \(error.localizedDescription, privacy: .public)")
            return nil
        }
        let choice = ReplayCrop.choose(windows: meta.sample(at: videoMs)?.windows ?? [], symbol: symbol)
        let cropped = Self.crop(frame, choice.window, meta: meta)
        let image = cropped ?? frame
        let title = cropped == nil ? nil : choice.window?.title
        let loc = log.shotLocation(eventID: eventID, ts: ts)
        let ocr = log.ocrLocation(eventID: eventID, ts: ts)
        return await Task.detached(priority: .userInitiated) { () -> Shot? in
            guard var shot = ScreenShotTaker.makeShot(image: image, url: loc.url, relative: loc.relative, priceRegion: nil, symbolRegion: nil)
            else { return nil }
            // 録画のフレームなので撮影の遅れは無い（captured_at = ts）
            shot.capturedAt = ts
            shot.windowTitle = title
            shot.ocrPath = ocr.relative
            self.startFullOCR(image: image, shot: shot, ambiguous: choice.ambiguous, url: ocr.url, relative: ocr.relative)
            return shot
        }.value
    }

    /// 切り出し。ウィンドウが無い・画像の外なら nil（フレーム全体を使う）
    static func crop(_ frame: CGImage, _ window: RecWindow?, meta: RecordingMeta) -> CGImage? {
        guard let window, let r = ReplayCrop.pixelRect(window.frame, videoWidth: meta.width, videoHeight: meta.height,
                                                        imageWidth: frame.width, imageHeight: frame.height) else { return nil }
        return frame.cropping(to: r)
    }

    private func startFullOCR(image: CGImage, shot: Shot, ambiguous: Bool, url: URL, relative: String) {
        let key = UUID()
        lock.lock()
        defer { lock.unlock() }
        background[key] = Task.detached(priority: .utility) { [weak self] in
            var sidecar = BoardReader.analyze(image: image, windowTitle: shot.windowTitle, capturedAt: shot.capturedAt, regionShot: shot)
            if ambiguous {
                // どの全板が発注銘柄か分からない時は、別の銘柄の値を拾わないよう現在値を使わない
                sidecar.auto.price = nil
                sidecar.auto.priceText = nil
                sidecar.auto.source = nil
            }
            do {
                try sidecar.write(to: url)
                self?.onAutoRead?(relative, sidecar.auto)
            } catch {
                Self.logger.error("サイドカーを書けない: \(error.localizedDescription, privacy: .public)")
            }
            self?.finish(key)
        }
    }

    private func finish(_ key: UUID) {
        lock.lock()
        background[key] = nil
        lock.unlock()
    }

    public func waitForBackground() async {
        lock.lock()
        let tasks = Array(background.values)
        lock.unlock()
        for t in tasks { await t.value }
    }

    /// 今の再生位置で全板が 1 つだけなら、そのタイトルの銘柄コード
    public func readSymbol() async -> String? {
        let ms = await position()
        let boards = (meta.sample(at: ms)?.windows ?? []).filter { ReplayCrop.isBoard($0.title) }
        return boards.count == 1 ? BoardReader.symbol(fromTitle: boards[0].title) : nil
    }

    public func refreshTarget() {}
}

// MARK: 再生ウィンドウ

/// 再生ウィンドウの中身: 録画上の実時刻（大きく）と AVPlayerView（再生・一時停止・シーク）
public struct ReplayPlayerView: View {
    @ObservedObject var session: ReplaySession

    public init(session: ReplaySession) {
        self.session = session
    }

    public var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(JST.clock(session.realTime))
                    .font(.system(size: 44, weight: .bold, design: .monospaced))
                    .monospacedDigit()
                Text(JST.day(session.realTime))
                    .font(.title3.monospacedDigit())
                    .foregroundStyle(.secondary)
                Spacer()
                Text(session.isPlaying ? "再生中（1 倍速）" : "一時停止中・発注できません")
                    .font(.headline)
                    .foregroundStyle(session.isPlaying ? Color.secondary : Color.orange)
                Text("録画 \(session.meta.id)")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            PlayerViewRepresentable(player: session.player)
        }
        .frame(minWidth: 640, minHeight: 420)
    }
}

struct PlayerViewRepresentable: NSViewRepresentable {
    let player: AVPlayer

    func makeNSView(context: Context) -> AVPlayerView {
        let v = AVPlayerView()
        v.player = player
        v.controlsStyle = .inline
        v.showsFrameSteppingButtons = false
        v.showsSharingServiceButton = false
        v.showsFullScreenToggleButton = true
        v.videoGravity = .resizeAspect
        return v
    }

    func updateNSView(_ nsView: AVPlayerView, context: Context) {
        if nsView.player !== player { nsView.player = player }
    }
}

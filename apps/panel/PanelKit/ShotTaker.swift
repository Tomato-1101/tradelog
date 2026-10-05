import CoreGraphics
import Foundation
import os

/// 発注時の撮影と読み取り。失敗しても発注の記録は残すので、ここは nil を返すだけで例外を外に出さない。
public protocol ShotTaking: AnyObject {
    func takeShot(eventID: UUID, ts: Date, log: EventLog) async -> Shot?
    /// 発注銘柄も渡す版（リプレイでは、どの全板を切り出すかに使う）。既定は銘柄を使わずに上を呼ぶ
    func takeShot(eventID: UUID, ts: Date, log: EventLog, symbol: String) async -> Shot?
    /// 銘柄コード欄の自動入力用（ウィンドウタイトルの「(5803)」→ 無ければ銘柄コード領域を撮って読む。画像は保存しない）
    func readSymbol() async -> String?
    /// 撮影対象のウィンドウを探し直して覚えておく（発注時は撮るだけにするため）
    func refreshTarget()
    /// 裏で走っている全画面 OCR が終わるまで待つ（終了時）
    func waitForBackground() async
    /// 全画面 OCR が終わってサイドカーを書いた時に呼ぶ（引数は shot.ocr_path と自動読み取りの結果）
    var onAutoRead: ((String, AutoRead) -> Void)? { get set }
}

public extension ShotTaking {
    func takeShot(eventID: UUID, ts: Date, log: EventLog, symbol: String) async -> Shot? {
        await takeShot(eventID: eventID, ts: ts, log: log)
    }
}

public final class ScreenShotTaker: ShotTaking, @unchecked Sendable {
    let settings: PanelSettings
    /// 撮影（と読み取り領域の OCR）がこの秒数で終わらなければ shot = null で記録する（記録を止めない）
    public var timeout: TimeInterval = 3
    public var onAutoRead: ((String, AutoRead) -> Void)?
    private let target = CaptureTarget()
    private let lock = NSLock()
    private var background: [UUID: Task<Void, Never>] = [:]
    private var refreshing = false
    static let logger = Logger(subsystem: "com.tomato.tradelog.panel", category: "shot")

    public init(settings: PanelSettings) {
        self.settings = settings
    }

    public func refreshTarget() {
        let id = settings.targetWindowID
        let title = settings.targetWindowTitle
        lock.lock()
        if refreshing { lock.unlock(); return }
        refreshing = true
        lock.unlock()
        let target = target
        Task.detached(priority: .utility) { [weak self] in
            let t0 = Date()
            let ok = (try? await target.refresh(preferredID: id, preferredTitle: title)) != nil
            Self.logger.debug("撮影対象の更新 \(ok ? "OK" : "失敗", privacy: .public) \(Self.ms(since: t0), privacy: .public)ms")
            guard let self else { return }
            self.lock.lock()
            self.refreshing = false
            self.lock.unlock()
        }
    }

    public func takeShot(eventID: UUID, ts: Date, log: EventLog) async -> Shot? {
        let priceRegion = settings.priceRegion
        let symbolRegion = settings.symbolRegion
        let id = settings.targetWindowID
        let title = settings.targetWindowTitle
        let loc = log.shotLocation(eventID: eventID, ts: ts)
        let ocr = log.ocrLocation(eventID: eventID, ts: ts)
        let target = target
        let shot: Shot? = await withTimeout(timeout) {
            let t0 = Date()
            guard let cap = try? await target.capture(preferredID: id, preferredTitle: title) else {
                Self.logger.error("撮影に失敗 \(Self.ms(since: t0), privacy: .public)ms")
                return nil
            }
            let capturedAt = JST.nowMillis()
            Self.logger.info("撮影 押下から \(Self.ms(from: ts, to: capturedAt), privacy: .public)ms（撮影処理 \(Self.ms(since: t0), privacy: .public)ms） \(cap.image.width, privacy: .public)x\(cap.image.height, privacy: .public)")
            return await Task.detached(priority: .userInitiated) { () -> Shot? in
                let t1 = Date()
                guard var shot = Self.makeShot(image: cap.image, url: loc.url, relative: loc.relative,
                                               priceRegion: priceRegion, symbolRegion: symbolRegion) else { return nil }
                shot.capturedAt = capturedAt
                shot.windowTitle = cap.title.isEmpty ? nil : cap.title
                shot.ocrPath = ocr.relative
                Self.logger.info("PNG 保存＋領域 OCR \(Self.ms(since: t1), privacy: .public)ms")
                self.startFullOCR(image: cap.image, shot: shot, url: ocr.url, relative: ocr.relative)
                return shot
            }.value
        }
        return shot
    }

    /// 全画面 OCR は発注の記録を待たせないよう裏で走らせ、終わったらサイドカーに書く
    private func startFullOCR(image: CGImage, shot: Shot, url: URL, relative: String) {
        let key = UUID()
        // 登録より先に終わって消し損ねないよう、ロックを持ったまま作って登録する
        lock.lock()
        defer { lock.unlock() }
        background[key] = Task.detached(priority: .utility) { [weak self] in
            let t0 = Date()
            let sidecar = BoardReader.analyze(image: image, windowTitle: shot.windowTitle, capturedAt: shot.capturedAt, regionShot: shot)
            do {
                try sidecar.write(to: url)
                Self.logger.info("全画面 OCR \(Self.ms(since: t0), privacy: .public)ms 語数 \(sidecar.items.count, privacy: .public) 現在値 \(sidecar.auto.price ?? "null", privacy: .public)（\(sidecar.auto.source ?? "null", privacy: .public)）")
                self?.onAutoRead?(relative, sidecar.auto)
            } catch {
                Self.logger.error("サイドカーを書けない: \(error.localizedDescription, privacy: .public)")
            }
            self?.finishBackground(key)
        }
    }

    private func finishBackground(_ key: UUID) {
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

    public func readSymbol() async -> String? {
        let region = settings.symbolRegion
        let id = settings.targetWindowID
        let title = settings.targetWindowTitle
        let target = target
        return await withTimeout(timeout) {
            // タイトルは撮影せずに取れるので先に見る
            if let code = BoardReader.symbol(fromTitle: await target.currentTitle(preferredID: id, preferredTitle: title)) { return code }
            guard let region, let image = try? await target.capture(preferredID: id, preferredTitle: title).image else { return nil }
            return await Task.detached { SymbolParser.extract(TextReader.read(image, region: region).text) }.value
        }
    }

    static func ms(since t: Date) -> Int { Int((Date().timeIntervalSince(t) * 1000).rounded()) }
    static func ms(from a: Date, to b: Date) -> Int { Int((b.timeIntervalSince(a) * 1000).rounded()) }

    /// 画像を保存して、設定済みの領域を読む。PNG が書けなければ shot = null
    static func makeShot(image: CGImage, url: URL, relative: String, priceRegion: RelRect?, symbolRegion: RelRect?) -> Shot? {
        do {
            try TextReader.writePNG(image, to: url)
        } catch {
            return nil
        }
        var shot = Shot(path: relative)
        if let priceRegion {
            let r = TextReader.read(image, region: priceRegion)
            shot.priceText = r.text
            shot.price = PriceParser.parse(r.text)
            shot.confidence = r.confidence
        }
        if let symbolRegion {
            shot.symbolText = TextReader.read(image, region: symbolRegion).text
        }
        return shot
    }
}

/// body が timeout 秒以内に終われば結果、終わらなければ nil。
/// TaskGroup は子の終了を待ってしまい、キャンセルに応じない撮影だと時間切れにならないので、先着 1 回だけ resume する形で書く
func withTimeout<T: Sendable>(_ seconds: TimeInterval, _ body: @escaping @Sendable () async -> T?) async -> T? {
    let once = FireOnce()
    return await withCheckedContinuation { (cont: CheckedContinuation<T?, Never>) in
        Task {
            let v = await body()
            if once.fire() { cont.resume(returning: v) }
        }
        Task {
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            if once.fire() { cont.resume(returning: nil) }
        }
    }
}

/// 先着 1 回だけ true を返す
private final class FireOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func fire() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if done { return false }
        done = true
        return true
    }
}

import CoreGraphics
import Foundation

/// 発注時の撮影と読み取り。失敗しても発注の記録は残すので、ここは nil を返すだけで例外を外に出さない。
public protocol ShotTaking: AnyObject {
    func takeShot(eventID: UUID, ts: Date, log: EventLog) async -> Shot?
    /// 銘柄コード欄の自動入力用（撮影して銘柄コード領域だけ読む。画像は保存しない）
    func readSymbol() async -> String?
}

public final class ScreenShotTaker: ShotTaking {
    let settings: PanelSettings
    /// 撮影がこの秒数で終わらなければ shot = null で記録する（記録を止めない）
    public var timeout: TimeInterval = 3

    public init(settings: PanelSettings) {
        self.settings = settings
    }

    public func takeShot(eventID: UUID, ts: Date, log: EventLog) async -> Shot? {
        let priceRegion = settings.priceRegion
        let symbolRegion = settings.symbolRegion
        let id = settings.targetWindowID
        let title = settings.targetWindowTitle
        let loc = log.shotLocation(eventID: eventID, ts: ts)
        return await withTimeout(timeout) {
            guard let image = try? await WindowCapturer.capture(preferredID: id, preferredTitle: title).0 else { return nil }
            return await Task.detached(priority: .userInitiated) {
                Self.makeShot(image: image, url: loc.url, relative: loc.relative, priceRegion: priceRegion, symbolRegion: symbolRegion)
            }.value
        }
    }

    public func readSymbol() async -> String? {
        guard let region = settings.symbolRegion else { return nil }
        let id = settings.targetWindowID
        let title = settings.targetWindowTitle
        return await withTimeout(timeout) {
            guard let image = try? await WindowCapturer.capture(preferredID: id, preferredTitle: title).0 else { return nil }
            return await Task.detached { SymbolParser.extract(TextReader.read(image, region: region).text) }.value
        }
    }

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

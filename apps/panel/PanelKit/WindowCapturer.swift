import CoreGraphics
import Foundation
import ScreenCaptureKit

/// HYPER SBI 2 のウィンドウを ScreenCaptureKit で撮る。画面収録の権限が要る。
public struct CapturableWindow: Identifiable, Hashable, Sendable {
    public let id: CGWindowID
    public let title: String
    public let width: Int
    public let height: Int
}

public enum CaptureError: LocalizedError {
    case noWindow
    public var errorDescription: String? {
        switch self {
        case .noWindow: return "HYPER SBI 2 のウィンドウが見つからない"
        }
    }
}

public enum WindowCapturer {
    public static let targetBundleID = "jp.co.sbisec.HYPERSBI2"

    /// 画面収録の権限があるか（ダイアログは出さない）
    public static var hasPermission: Bool { CGPreflightScreenCaptureAccess() }

    /// 権限を求める（初回は OS のダイアログが出る。設定から許可したらアプリの再起動が要る）
    @discardableResult
    public static func requestPermission() -> Bool { CGRequestScreenCaptureAccess() }

    private static func targetWindows() async throws -> [SCWindow] {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        return content.windows.filter {
            $0.owningApplication?.bundleIdentifier == targetBundleID
                && $0.windowLayer == 0 && $0.frame.width > 80 && $0.frame.height > 40
        }
    }

    public static func listWindows() async throws -> [CapturableWindow] {
        try await targetWindows().map {
            CapturableWindow(id: $0.windowID, title: $0.title ?? "", width: Int($0.frame.width), height: Int($0.frame.height))
        }
    }

    /// 選ぶ順: 前回のウィンドウ ID → タイトル完全一致 → タイトル先頭の語が一致 → 画面に出ている最大のウィンドウ
    static func choose(_ windows: [SCWindow], preferredID: CGWindowID?, preferredTitle: String?) -> SCWindow? {
        if let preferredID, let w = windows.first(where: { $0.windowID == preferredID }) { return w }
        if let t = preferredTitle, !t.isEmpty {
            if let w = windows.first(where: { $0.title == t }) { return w }
            // HYPER SBI 2 のタイトルは全角スペース区切り（例「全板　フジクラ(5803)」）なので空白はすべて区切りとみなす
            let head = t.split(whereSeparator: { $0.isWhitespace }).first.map(String.init) ?? t
            if let w = windows.first(where: { ($0.title ?? "").hasPrefix(head) }) { return w }
        }
        let byArea = windows.sorted { $0.frame.width * $0.frame.height > $1.frame.width * $1.frame.height }
        return byArea.first(where: \.isOnScreen) ?? byArea.first
    }

    /// 撮影対象のウィンドウの位置（画面上で囲む時の基準）。frame は SCWindow.frame（左上原点のグローバル座標・ポイント）
    public static func locate(preferredID: CGWindowID?, preferredTitle: String?) async throws -> (id: CGWindowID, frame: CGRect, isOnScreen: Bool) {
        let windows = try await targetWindows()
        guard let w = choose(windows, preferredID: preferredID, preferredTitle: preferredTitle) else { throw CaptureError.noWindow }
        return (w.windowID, w.frame, w.isOnScreen)
    }

    public static func capture(preferredID: CGWindowID?, preferredTitle: String?) async throws -> (CGImage, CapturableWindow) {
        let windows = try await targetWindows()
        guard let w = choose(windows, preferredID: preferredID, preferredTitle: preferredTitle) else { throw CaptureError.noWindow }
        let filter = SCContentFilter(desktopIndependentWindow: w)
        let config = makeConfig(size: w.frame.size, scale: CGFloat(filter.pointPixelScale))
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        return (image, CapturableWindow(id: w.windowID, title: w.title ?? "", width: Int(w.frame.width), height: Int(w.frame.height)))
    }
}

extension WindowCapturer {
    /// 撮影の設定: 実ピクセル（縮小しない）・最高解像度・カーソルなし・影なし
    static func makeConfig(size: CGSize, scale: CGFloat) -> SCStreamConfiguration {
        let config = SCStreamConfiguration()
        config.width = max(Int((size.width * scale).rounded()), 1)
        config.height = max(Int((size.height * scale).rounded()), 1)
        config.captureResolution = .best
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        return config
    }

    /// ウィンドウの今のタイトルと大きさ（ポイント）。閉じられていれば nil。
    /// SCShareableContent を引き直すより桁違いに速いので、発注時はこちらで確かめる
    static func liveInfo(_ id: CGWindowID) -> (title: String?, size: CGSize)? {
        guard let list = CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String: Any]],
              let info = list.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id }),
              let boundsDict = info[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary) else { return nil }
        let title = info[kCGWindowName as String] as? String
        return (title?.isEmpty == false ? title : nil, bounds.size)
    }
}

/// 撮影対象（SCWindow と SCContentFilter）を覚えておく。
/// 発注のたびに SCShareableContent を引くと撮影が遅れるので、小窓にマウスが乗った時と定期的に作り直し、発注時は撮るだけにする
public final class CaptureTarget: @unchecked Sendable {
    private struct Key: Equatable {
        var id: CGWindowID?
        var title: String?
    }

    private let lock = NSLock()
    private var key: Key?
    private var window: SCWindow?
    private var filter: SCContentFilter?

    public init() {}

    private func cached(for k: Key) -> (SCWindow, SCContentFilter)? {
        lock.lock()
        defer { lock.unlock() }
        guard key == k, let window, let filter else { return nil }
        return (window, filter)
    }

    /// ウィンドウを探し直して覚える
    @discardableResult
    func refresh(preferredID: CGWindowID?, preferredTitle: String?) async throws -> (SCWindow, SCContentFilter) {
        let windows = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false).windows.filter {
            $0.owningApplication?.bundleIdentifier == WindowCapturer.targetBundleID
                && $0.windowLayer == 0 && $0.frame.width > 80 && $0.frame.height > 40
        }
        guard let w = WindowCapturer.choose(windows, preferredID: preferredID, preferredTitle: preferredTitle) else {
            invalidate()
            throw CaptureError.noWindow
        }
        let f = SCContentFilter(desktopIndependentWindow: w)
        lock.lock()
        key = Key(id: preferredID, title: preferredTitle)
        window = w
        filter = f
        lock.unlock()
        return (w, f)
    }

    func invalidate() {
        lock.lock()
        window = nil
        filter = nil
        lock.unlock()
    }

    /// 覚えているウィンドウ（閉じられていれば探し直す）の ID
    private func target(preferredID: CGWindowID?, preferredTitle: String?) async throws -> (SCWindow, SCContentFilter) {
        if let t = cached(for: Key(id: preferredID, title: preferredTitle)), WindowCapturer.liveInfo(t.0.windowID) != nil { return t }
        return try await refresh(preferredID: preferredID, preferredTitle: preferredTitle)
    }

    /// 今のウィンドウタイトル（撮影しない。銘柄コードの自動入力用）
    func currentTitle(preferredID: CGWindowID?, preferredTitle: String?) async -> String? {
        guard let t = try? await target(preferredID: preferredID, preferredTitle: preferredTitle) else { return nil }
        return WindowCapturer.liveInfo(t.0.windowID)?.title ?? t.0.title
    }

    /// 撮る。大きさとタイトルは撮る直前に CGWindowList で取り直す（リサイズ・銘柄切替に追従）。
    /// 失敗したら 1 回だけ探し直して撮り直す
    func capture(preferredID: CGWindowID?, preferredTitle: String?) async throws -> (image: CGImage, title: String) {
        let t = try await target(preferredID: preferredID, preferredTitle: preferredTitle)
        do {
            return try await shoot(t)
        } catch {
            return try await shoot(try await refresh(preferredID: preferredID, preferredTitle: preferredTitle))
        }
    }

    private func shoot(_ t: (SCWindow, SCContentFilter)) async throws -> (image: CGImage, title: String) {
        let (w, f) = t
        let live = WindowCapturer.liveInfo(w.windowID)
        let config = WindowCapturer.makeConfig(size: live?.size ?? w.frame.size, scale: CGFloat(f.pointPixelScale))
        let image = try await SCScreenshotManager.captureImage(contentFilter: f, configuration: config)
        return (image, live?.title ?? w.title ?? "")
    }
}

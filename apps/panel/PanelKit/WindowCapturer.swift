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
            let head = t.split(separator: " ").first.map(String.init) ?? t
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
        let scale = CGFloat(filter.pointPixelScale)
        let config = SCStreamConfiguration()
        config.width = Int(w.frame.width * scale)
        config.height = Int(w.frame.height * scale)
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        return (image, CapturableWindow(id: w.windowID, title: w.title ?? "", width: Int(w.frame.width), height: Int(w.frame.height)))
    }
}

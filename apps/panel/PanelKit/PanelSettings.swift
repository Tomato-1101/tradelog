import CoreGraphics
import Foundation

/// 小窓の設定（UserDefaults に保存。テストでは別の suite を渡す）
public final class PanelSettings {
    let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    private enum Key {
        static let bookmark = "dataFolderBookmark"
        static let windowTitle = "targetWindowTitle"
        static let windowID = "targetWindowID"
        static let priceRegion = "priceRegion"
        static let symbolRegion = "symbolRegion"
        static let lastQty = "lastQty"
        static let orderType = "orderType"
    }

    public var dataFolderBookmark: Data? {
        get { defaults.data(forKey: Key.bookmark) }
        set { defaults.set(newValue, forKey: Key.bookmark) }
    }

    public var targetWindowTitle: String? {
        get { defaults.string(forKey: Key.windowTitle) }
        set { defaults.set(newValue, forKey: Key.windowTitle) }
    }

    /// ウィンドウ ID は HYPER SBI 2 を起動し直すと変わる。変わったらタイトルで探し直す
    public var targetWindowID: CGWindowID? {
        get { (defaults.object(forKey: Key.windowID) as? NSNumber).map { CGWindowID($0.uint32Value) } }
        set { defaults.set(newValue.map { NSNumber(value: $0) }, forKey: Key.windowID) }
    }

    public var priceRegion: RelRect? {
        get { region(Key.priceRegion) }
        set { setRegion(newValue, Key.priceRegion) }
    }

    public var symbolRegion: RelRect? {
        get { region(Key.symbolRegion) }
        set { setRegion(newValue, Key.symbolRegion) }
    }

    public var lastQty: String {
        get { defaults.string(forKey: Key.lastQty) ?? "100" }
        set { defaults.set(newValue, forKey: Key.lastQty) }
    }

    public var orderType: OrderType {
        get { defaults.string(forKey: Key.orderType).flatMap(OrderType.init(rawValue:)) ?? .market }
        set { defaults.set(newValue.rawValue, forKey: Key.orderType) }
    }

    private func region(_ key: String) -> RelRect? {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(RelRect.self, from: $0) }
    }

    private func setRegion(_ r: RelRect?, _ key: String) {
        defaults.set(r.flatMap { try? JSONEncoder().encode($0) }, forKey: key)
    }
}

import AppKit
import SwiftUI

/// 設定画面: データフォルダ・画面収録の権限・撮影対象ウィンドウ・読み取り領域
public struct SettingsView: View {
    @ObservedObject var store: PanelStore
    @StateObject private var model: SettingsModel

    public init(store: PanelStore, preview: CGImage? = nil) {
        self.store = store
        _model = StateObject(wrappedValue: SettingsModel(settings: store.settings, preview: preview))
    }

    public var body: some View {
        Form {
            Section("データフォルダ") {
                HStack {
                    Text(store.dataFolder?.path ?? "未設定")
                        .font(.system(.callout, design: .monospaced))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    Button("選ぶ…") { store.chooseDataFolder() }
                }
            }
            Section("画面収録の権限") {
                HStack {
                    Text(model.hasPermission ? "許可されています" : "未許可")
                        .foregroundStyle(model.hasPermission ? Color.primary : Color.red)
                    Spacer()
                    Button("権限を求める") { model.requestPermission() }
                        .disabled(model.hasPermission)
                }
                Text("システム設定 > プライバシーとセキュリティ > 画面とシステムオーディオの収録 で「ペーパー発注」を許可し、アプリを再起動してください。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Section("撮影対象のウィンドウ（HYPER SBI 2）") {
                HStack {
                    Picker("ウィンドウ", selection: $model.selectedTitle) {
                        Text("自動（最大のウィンドウ）").tag(String?.none)
                        ForEach(model.windows) { w in
                            Text("\(w.title.isEmpty ? "(無題)" : w.title)  \(w.width)×\(w.height)").tag(String?.some(w.title))
                        }
                    }
                    Button("一覧を更新") { model.refreshWindows() }
                }
            }
            Section("読み取り領域") {
                HStack {
                    Picker("", selection: $model.editing) {
                        Text("現在値").tag(RegionKind.price)
                        Text("銘柄コード").tag(RegionKind.symbol)
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .frame(width: 200)
                    Spacer()
                    Button("いま撮影") { model.capture() }
                }
                Text("撮った画像の上でドラッグして囲みます。保存はウィンドウの大きさに対する比率なので、ウィンドウの位置を動かしても使えます。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                RegionCanvas(model: model)
                    .frame(minHeight: 260)
                VStack(alignment: .leading, spacing: 2) {
                    Text("現在値: \(model.priceReading)")
                    Text("銘柄コード: \(model.symbolReading)")
                }
                .font(.system(.callout, design: .monospaced))
            }
            if let message = model.message {
                Text(message).font(.caption).foregroundStyle(.red)
            }
        }
        .formStyle(.grouped)
        .frame(minWidth: 560, minHeight: 640)
    }
}

enum RegionKind { case price, symbol }

@MainActor
final class SettingsModel: ObservableObject {
    let settings: PanelSettings
    @Published var windows: [CapturableWindow] = []
    @Published var selectedTitle: String? {
        didSet {
            settings.targetWindowTitle = selectedTitle
            settings.targetWindowID = windows.first { $0.title == selectedTitle }?.id
        }
    }
    @Published var editing: RegionKind = .price
    @Published var image: CGImage?
    @Published var priceRegion: RelRect? { didSet { settings.priceRegion = priceRegion; updateReadings() } }
    @Published var symbolRegion: RelRect? { didSet { settings.symbolRegion = symbolRegion; updateReadings() } }
    @Published var priceReading = "-"
    @Published var symbolReading = "-"
    @Published var message: String?
    @Published var hasPermission = WindowCapturer.hasPermission

    init(settings: PanelSettings, preview: CGImage?) {
        self.settings = settings
        self.selectedTitle = settings.targetWindowTitle
        self.priceRegion = settings.priceRegion
        self.symbolRegion = settings.symbolRegion
        self.image = preview
        updateReadings()
    }

    func requestPermission() {
        WindowCapturer.requestPermission()
        hasPermission = WindowCapturer.hasPermission
    }

    func refreshWindows() {
        Task {
            do {
                windows = try await WindowCapturer.listWindows()
                message = windows.isEmpty ? "HYPER SBI 2 のウィンドウが見つかりません（起動していますか）" : nil
            } catch {
                message = "ウィンドウ一覧を取れません（画面収録の権限を確認）: \(error.localizedDescription)"
            }
        }
    }

    func capture() {
        Task {
            do {
                let (img, w) = try await WindowCapturer.capture(preferredID: settings.targetWindowID, preferredTitle: settings.targetWindowTitle)
                image = img
                settings.targetWindowID = w.id
                message = nil
                updateReadings()
            } catch {
                message = "撮影できません: \(error.localizedDescription)"
            }
        }
    }

    func setRegion(_ r: RelRect) {
        switch editing {
        case .price: priceRegion = r
        case .symbol: symbolRegion = r
        }
    }

    private func updateReadings() {
        guard let image else { return }
        if let priceRegion {
            let r = TextReader.read(image, region: priceRegion)
            priceReading = "「\(r.text ?? "")」 → \(PriceParser.parse(r.text) ?? "null（解釈できず）")"
        }
        if let symbolRegion {
            let r = TextReader.read(image, region: symbolRegion)
            symbolReading = "「\(r.text ?? "")」 → \(SymbolParser.extract(r.text) ?? "読めず")"
        }
    }
}

/// 撮った画像を縮小表示し、ドラッグで矩形を決める
struct RegionCanvas: View {
    @ObservedObject var model: SettingsModel
    @State private var dragStart: CGPoint?
    @State private var dragNow: CGPoint?

    var body: some View {
        GeometryReader { geo in
            if let image = model.image {
                let size = fitted(CGSize(width: image.width, height: image.height), in: geo.size)
                ZStack(alignment: .topLeading) {
                    Image(decorative: image, scale: 1)
                        .resizable()
                        .frame(width: size.width, height: size.height)
                    if let r = model.priceRegion { box(r, size, .red, "現在値") }
                    if let r = model.symbolRegion { box(r, size, .blue, "銘柄") }
                    if let a = dragStart, let b = dragNow {
                        Rectangle()
                            .stroke(Color.orange, lineWidth: 2)
                            .frame(width: abs(b.x - a.x), height: abs(b.y - a.y))
                            .offset(x: min(a.x, b.x), y: min(a.y, b.y))
                    }
                }
                .frame(width: size.width, height: size.height)
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 2)
                        .onChanged { v in
                            dragStart = clamp(v.startLocation, size)
                            dragNow = clamp(v.location, size)
                        }
                        .onEnded { v in
                            let a = clamp(v.startLocation, size), b = clamp(v.location, size)
                            dragStart = nil
                            dragNow = nil
                            guard abs(b.x - a.x) > 3, abs(b.y - a.y) > 3 else { return }
                            model.setRegion(RelRect(x: min(a.x, b.x) / size.width, y: min(a.y, b.y) / size.height,
                                                    w: abs(b.x - a.x) / size.width, h: abs(b.y - a.y) / size.height))
                        }
                )
            } else {
                Text("「いま撮影」で HYPER SBI 2 のウィンドウを撮ってください")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private func box(_ r: RelRect, _ size: CGSize, _ color: Color, _ label: String) -> some View {
        Rectangle()
            .stroke(color, lineWidth: 2)
            .frame(width: r.w * size.width, height: r.h * size.height)
            .overlay(alignment: .topLeading) {
                Text(label).font(.caption2.bold()).foregroundStyle(.white).padding(1).background(color).offset(y: -14)
            }
            .offset(x: r.x * size.width, y: r.y * size.height)
    }

    private func fitted(_ image: CGSize, in box: CGSize) -> CGSize {
        guard image.width > 0, image.height > 0, box.width > 0, box.height > 0 else { return .zero }
        let s = min(box.width / image.width, box.height / image.height)
        return CGSize(width: image.width * s, height: image.height * s)
    }

    private func clamp(_ p: CGPoint, _ size: CGSize) -> CGPoint {
        CGPoint(x: min(max(p.x, 0), size.width), y: min(max(p.y, 0), size.height))
    }
}

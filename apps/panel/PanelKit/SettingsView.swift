import AppKit
import SwiftUI

/// 設定画面: データフォルダ・画面収録の権限・撮影対象ウィンドウ・読み取り領域
public struct SettingsView: View {
    @ObservedObject var store: PanelStore
    @StateObject private var model: SettingsModel

    public init(store: PanelStore, preview: CGImage? = nil, previewTitle: String? = nil) {
        self.store = store
        _model = StateObject(wrappedValue: SettingsModel(settings: store.settings, preview: preview, previewTitle: previewTitle))
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
            Section("自動読み取り") {
                HStack {
                    Text("現在値は画面の「現在値」の右から、銘柄コードはウィンドウタイトルの「(5803)」から自動で読みます。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("いま撮影") { model.capture() }
                }
                ForEach(model.autoReading, id: \.self) { line in
                    Text(line)
                        .font(.system(.callout, design: .monospaced))
                        .textSelection(.enabled)
                }
            }
            Section("読み取り領域（任意：自動で読めない時だけ）") {
                HStack {
                    Picker("", selection: $model.editing) {
                        Text("現在値").tag(RegionKind.price)
                        Text("銘柄コード").tag(RegionKind.symbol)
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .frame(width: 200)
                    Spacer()
                    Button("画面上で囲む") { model.pickOnScreen() }
                }
                Text("通常は設定不要です。上の自動読み取りで読めない時だけ使います（現在値の領域を設定すると、発注時はその領域の値を優先します）。「画面上で囲む」を押すと画面が暗くなるので、HYPER SBI 2 の実物の数字をドラッグで囲みます（Esc で取り消し）。保存はウィンドウの大きさに対する比率なので、ウィンドウの位置を動かしても使えます。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                RegionResult(title: "現在値", color: .red, crop: model.priceCrop, reading: model.priceReading)
                RegionResult(title: "銘柄コード", color: .blue, crop: model.symbolCrop, reading: model.symbolReading)
                VStack(alignment: .leading, spacing: 4) {
                    Text("ウィンドウ全体（位置の確認用。ドラッグで囲み直すこともできます）")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    RegionCanvas(model: model)
                        .frame(minHeight: 200)
                        .padding(.top, 14)  // 枠のラベルが上にはみ出して説明文に重ならないように
                }
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
    /// 撮った画像から領域を切り出したもの（設定画面で拡大して見せる）
    @Published var priceCrop: CGImage?
    @Published var symbolCrop: CGImage?
    @Published var message: String?
    @Published var hasPermission = WindowCapturer.hasPermission
    /// 「いま撮影」で自動読み取りした結果（現在値・時刻・銘柄の行）
    @Published var autoReading: [String] = ["「いま撮影」を押すと、ここに読み取り結果が出ます"]

    init(settings: PanelSettings, preview: CGImage?, previewTitle: String? = nil) {
        self.settings = settings
        self.selectedTitle = settings.targetWindowTitle
        self.priceRegion = settings.priceRegion
        self.symbolRegion = settings.symbolRegion
        self.image = preview
        updateReadings()
        // プレビュー描画では結果をその場で出す（実機では撮影のたびに裏で読む）
        if let preview { autoReading = Self.describeAuto(image: preview, title: previewTitle) }
    }

    /// 全画面を読んで、自動読み取りの結果を行にする（全画面 OCR は 1 秒前後かかるので呼び出し側で裏に回す）
    nonisolated static func describeAuto(image: CGImage, title: String?) -> [String] {
        let label = BoardReader.priceByLabel(image: image, items: BoardReader.recognize(image))
        let price: String
        if let label {
            price = "現在値 \(label.price ?? "読めず")（「\(label.text ?? "")」）"
        } else {
            price = "現在値 読めず（画面に「現在値」の文字が見つからない）"
        }
        let time = "時刻 \(label?.time ?? "読めず")"
        let symbol = "銘柄 \(BoardReader.symbol(fromTitle: title) ?? "読めず")（タイトル「\(title ?? "")」）"
        return [price, time, symbol]
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
                autoReading = ["読み取り中…"]
                let title = w.title
                autoReading = await Task.detached(priority: .userInitiated) { Self.describeAuto(image: img, title: title) }.value
            } catch {
                message = "撮影できません: \(error.localizedDescription)"
            }
        }
    }

    func setRegion(_ r: RelRect) {
        setRegion(r, for: editing)
    }

    private func setRegion(_ r: RelRect, for kind: RegionKind) {
        switch kind {
        case .price: priceRegion = r
        case .symbol: symbolRegion = r
        }
    }

    /// 実物の HYPER SBI 2 の上に出したオーバーレイでドラッグして囲み、直後に 1 回撮影して読む
    func pickOnScreen() {
        let kind = editing
        Task {
            do {
                let target = try await WindowCapturer.locate(preferredID: settings.targetWindowID, preferredTitle: settings.targetWindowTitle)
                let screens = NSScreen.screens
                let primaryHeight = screens.first?.frame.height ?? 0
                guard target.isOnScreen,
                      let i = ScreenGeometry.screenIndex(forWindow: target.frame, screenFrames: screens.map(\.frame), primaryHeight: primaryHeight)
                else {
                    message = "HYPER SBI 2 のウィンドウが今の画面に出ていません（最小化・別のスペース）。表示してからもう一度押してください"
                    return
                }
                settings.targetWindowID = target.id
                message = nil
                let name = kind == .price ? "現在値" : "銘柄コード"
                guard let picked = await RegionPicker.pick(on: screens[i], windowFrame: target.frame, primaryHeight: primaryHeight,
                                                           prompt: "HYPER SBI 2 の「\(name)」の数字をドラッグで囲む（Esc で取り消し）")
                else { return }
                let selection = ScreenGeometry.cgRect(fromAppKit: picked, primaryHeight: primaryHeight)
                guard let rel = ScreenGeometry.relRect(selection: selection, windowFrame: target.frame) else {
                    message = "囲んだ範囲が HYPER SBI 2 のウィンドウの外か、小さすぎます"
                    return
                }
                setRegion(rel, for: kind)
                capture()
            } catch {
                message = "HYPER SBI 2 のウィンドウを探せません（起動・画面収録の権限を確認）: \(error.localizedDescription)"
            }
        }
    }

    private func updateReadings() {
        guard let image else { return }
        priceCrop = priceRegion.flatMap { Self.crop(image, $0) }
        symbolCrop = symbolRegion.flatMap { Self.crop(image, $0) }
        if let priceRegion {
            let r = TextReader.read(image, region: priceRegion)
            priceReading = "「\(r.text ?? "")」 → \(PriceParser.parse(r.text) ?? "null（解釈できず）")"
        }
        if let symbolRegion {
            let r = TextReader.read(image, region: symbolRegion)
            symbolReading = "「\(r.text ?? "")」 → \(SymbolParser.extract(r.text) ?? "読めず")"
        }
    }

    static func crop(_ image: CGImage, _ region: RelRect) -> CGImage? {
        region.pixelRect(width: image.width, height: image.height).flatMap { image.cropping(to: $0) }
    }
}

/// 選んだ領域の切り出し（数字が読める大きさに拡大）と、読み取り結果（生の文字列 → 解釈した値）
struct RegionResult: View {
    let title: String
    let color: Color
    let crop: CGImage?
    let reading: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Circle().fill(color).frame(width: 8, height: 8)
                Text(title).font(.callout.bold())
            }
            if let crop {
                let size = Self.displaySize(crop)
                Image(decorative: crop, scale: 1)
                    .resizable()
                    .interpolation(.high)
                    .frame(width: size.width, height: size.height)
                    .border(color.opacity(0.7))
            } else {
                Text("未設定または未撮影（「画面上で囲む」で選ぶ）")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Text(reading)
                .font(.system(.callout, design: .monospaced))
                .lineLimit(2)
                .textSelection(.enabled)
        }
    }

    /// 高さ 64pt に揃えて拡大（小さい数字でも読める大きさ）。横に長すぎる時は幅 480pt に収める
    static func displaySize(_ image: CGImage) -> CGSize {
        let w = CGFloat(max(image.width, 1)), h = CGFloat(max(image.height, 1))
        let s = min(64 / h, 480 / w)
        return CGSize(width: w * s, height: h * s)
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

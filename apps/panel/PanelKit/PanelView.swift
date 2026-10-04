import SwiftUI

/// 常に最前面の発注小窓の中身。標準部品で素直に組む（見た目は後で整える）。
public struct PanelView: View {
    @ObservedObject var store: PanelStore
    var openSettings: () -> Void
    /// プレビュー描画で経過時間を固定するため
    var now: Date?
    @FocusState private var memoFocused: Bool

    public init(store: PanelStore, openSettings: @escaping () -> Void, now: Date? = nil) {
        self.store = store
        self.openSettings = openSettings
        self.now = now
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            orderSection
            Divider()
            positionsSection
            if !store.book.pendingLimits.isEmpty {
                Divider()
                pendingSection
            }
            Divider()
            memoSection
            Text(store.status)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(10)
        .frame(minWidth: 340, idealWidth: 360)
        .onHover { inside in
            if inside { store.refreshSymbolFromScreen() }
        }
        .onChange(of: store.memoFocusRequest) { _, _ in memoFocused = true }
    }

    // MARK: 発注

    private var orderSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("銘柄")
                TextField("7203", text: $store.symbol)
                    .frame(width: 64)
                    .font(.system(.body, design: .monospaced))
                Button {
                    store.refreshSymbolFromScreen(force: true)
                } label: {
                    Image(systemName: "text.viewfinder")
                }
                .help("HYPER SBI 2 の画面から銘柄コードを読む")
                Text("株数")
                TextField("100", text: $store.qtyText)
                    .frame(width: 64)
                    .font(.system(.body, design: .monospaced))
                Spacer()
                Button(action: openSettings) {
                    Image(systemName: "gearshape")
                }
                .help("設定")
            }
            HStack(spacing: 6) {
                Picker("", selection: $store.orderType) {
                    ForEach(OrderType.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 110)
                Text("価格")
                TextField("指値", text: $store.limitPriceText)
                    .font(.system(.body, design: .monospaced))
                    .disabled(store.orderType == .market)
            }
            HStack(spacing: 8) {
                orderButton("買い", side: .buy, tint: .red)
                orderButton("売り", side: .sell, tint: .blue)
            }
            if store.dataFolder == nil {
                Button("データフォルダを選ぶ…") { store.chooseDataFolder() }
            }
        }
    }

    private func orderButton(_ title: String, side: Side, tint: Color) -> some View {
        Button {
            store.placeOrder(side: side)
        } label: {
            Text(title)
                .font(.title2.bold())
                .frame(maxWidth: .infinity, minHeight: 36)
        }
        .buttonStyle(SolidButtonStyle(color: tint))
        .disabled(!store.canOrder)
    }

    // MARK: 建玉

    private var positionsSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("建玉").font(.headline)
            if store.book.openPositions.isEmpty {
                Text("なし").foregroundStyle(.secondary).font(.callout)
            }
            ForEach(store.book.openPositions) { p in
                PositionRow(position: p, now: now, store: store)
            }
        }
    }

    // MARK: 待機中の指値

    private var pendingSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("待機中の指値").font(.headline)
            ForEach(store.book.pendingLimits, id: \.id) { o in
                HStack(spacing: 6) {
                    Text("\(o.symbol) \(intentLabel(o)) \(o.qty)株 @\(o.limitPrice ?? "-")")
                        .font(.system(.callout, design: .monospaced))
                    Text(JST.clock(o.ts)).font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("約定した") { store.markFilled(orderID: o.id) }
                    Button("取消") { store.cancel(orderID: o.id) }
                }
                .controlSize(.small)
            }
        }
    }

    private func intentLabel(_ o: OrderEvent) -> String {
        switch o.intent {
        case .open: return o.side == .buy ? "新規買" : "新規売"
        case .add: return o.side == .buy ? "買増" : "売増"
        case .close: return o.side == .buy ? "返済買" : "返済売"
        }
    }

    // MARK: メモ

    private var memoSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("メモ").font(.headline)
                Picker("", selection: $store.memoTarget) {
                    if store.book.memoTargets.isEmpty { Text("建玉なし").tag(UUID?.none) }
                    ForEach(store.book.memoTargets.prefix(12)) { p in
                        Text(memoLabel(p)).tag(UUID?.some(p.id))
                    }
                }
                .labelsHidden()
            }
            TextEditor(text: $store.memoText)
                .font(.body)
                .frame(height: 64)
                .focused($memoFocused)
                .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.secondary.opacity(0.3)))
            HStack {
                Spacer()
                Button("保存 ⌘↩") { store.saveMemo() }
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!store.canSaveMemo)
            }
        }
    }

    private func memoLabel(_ p: Position) -> String {
        let state = p.isOpen ? "保有中" : (p.closedAt != nil ? "決済済" : "未約定")
        return "\(p.symbol) \(p.direction.label) \(state) \(JST.clock(p.openedAt ?? p.lastActivity))"
    }
}

struct PositionRow: View {
    let position: Position
    let now: Date?
    @ObservedObject var store: PanelStore
    @State private var qty: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(position.direction == .buy ? "買" : "売")
                    .font(.callout.bold())
                    .foregroundStyle(position.direction == .buy ? Color.red : Color.blue)
                Text(position.symbol).font(.system(.callout, design: .monospaced).bold())
                Text("\(position.qty.contractString)株")
                Text(position.avgPrice.map { "@\($0.displayString)" } ?? "@不明")
                    .foregroundStyle(position.avgPrice == nil ? .secondary : .primary)
                Spacer()
                if let now {
                    Text(elapsed(now)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                } else {
                    TimelineView(.periodic(from: .now, by: 1)) { ctx in
                        Text(elapsed(ctx.date)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    }
                }
            }
            .font(.system(.callout, design: .monospaced))
            HStack(spacing: 6) {
                TextField("数量", text: $qty)
                    .frame(width: 64)
                    .font(.system(.callout, design: .monospaced))
                Button("決済（成行）") { store.close(positionID: position.id, qtyText: qty, type: .market) }
                Button("決済（指値）") { store.close(positionID: position.id, qtyText: qty, type: .limit) }
                    .help("上の「価格」欄の値で指値を置く")
            }
            .controlSize(.small)
        }
        .onAppear { qty = position.closableQty.contractString }
        .onChange(of: position.closableQty) { _, v in qty = v.contractString }
    }

    private func elapsed(_ now: Date) -> String {
        guard let opened = position.openedAt else { return "" }
        let s = max(Int(now.timeIntervalSince(opened)), 0)
        if s >= 3600 { return String(format: "%d時間%02d分", s / 3600, (s % 3600) / 60) }
        return String(format: "%d分%02d秒", s / 60, s % 60)
    }
}

/// 買い＝赤・売り＝青を、窓が非アクティブでも灰色にせず常に出す
/// （標準の borderedProminent は key でない窓で灰色になり、最前面の小窓では大半の時間そうなるため）
struct SolidButtonStyle: ButtonStyle {
    let color: Color
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(.white)
            .background(RoundedRectangle(cornerRadius: 8).fill(color))
            .opacity(isEnabled ? (configuration.isPressed ? 0.7 : 1) : 0.35)
            .contentShape(RoundedRectangle(cornerRadius: 8))
    }
}

import SwiftUI

/// 常に最前面の発注小窓の中身。標準部品で素直に組む（見た目は後で整える）。
public struct PanelView: View {
    @ObservedObject var store: PanelStore
    var openSettings: () -> Void
    /// プレビュー描画で経過時間を固定するため
    var now: Date?
    @FocusState private var memoFocused: Bool
    @Environment(\.colorScheme) private var colorScheme

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
            if inside { store.hoverEntered() }
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
            planPreview
            if store.dataFolder == nil {
                Button("データフォルダを選ぶ…") { store.chooseDataFolder() }
            }
        }
    }

    private func orderButton(_ title: String, side: Side, tint: Color) -> some View {
        let armed = store.armedFlip == side
        return Button {
            store.placeOrder(side: side)
        } label: {
            Text(armed ? "もう一度でドテン" : title)
                .font(armed ? .headline : .title2.bold())
                .frame(maxWidth: .infinity, minHeight: 36)
        }
        .buttonStyle(SolidButtonStyle(color: armed ? .orange : tint))
        .disabled(!store.canOrder)
    }

    /// 押す前に、それぞれのボタンで何が起きるかを 1 行ずつ出す（ドテンになる方は橙の帯）
    private var planPreview: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach([Side.buy, .sell], id: \.self) { side in
                if let plan = store.previewPlan(side: side) {
                    if plan.isFlip {
                        // ライトの白地では素の橙が読みにくいので、濃い橙の文字＋薄い橙の帯にする
                        flipText(plan)
                            .foregroundStyle(colorScheme == .dark ? Color.orange : Color(red: 0.60, green: 0.26, blue: 0))
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 3)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: 5)
                                .fill(Color.orange.opacity(colorScheme == .dark ? 0.2 : 0.14)))
                    } else {
                        Text(plan.summary)
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// ドテンの 1 行。決済数・新規数は太字（何株決済して何株建てるかを一目で）
    private func flipText(_ plan: OrderPlan) -> Text {
        guard case .flip(let closeQty, let openQty) = plan.kind else { return Text(plan.summary) }
        var s = AttributedString(plan.summary)
        // Text 全体の fontWeight は run ごとのフォントより優先されて太字が消えるので、太さはすべて run 側で付ける
        s.font = .caption.monospacedDigit().weight(.medium)
        for (label, n) in [("決済 ", closeQty), ("新規\(plan.side == .buy ? "買い" : "売り") ", openQty)] {
            if let r = s.range(of: label + n.contractString) {
                let numStart = s.index(r.lowerBound, offsetByCharacters: label.count)
                s[numStart..<r.upperBound].font = .caption.monospacedDigit().weight(.heavy)
            }
        }
        return Text(s)
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
            // ドテンの 2 行（決済＋新規）は 1 行にまとめる。約定・取消は 2 行そろって記録される
            ForEach(store.book.pendingLimits.filter { !(store.book.flipPartner(of: $0.id) != nil && $0.intent == .open) }, id: \.id) { o in
                HStack(spacing: 6) {
                    Text("\(o.symbol) \(pendingLabel(o)) @\(o.limitPrice ?? "-")")
                        .font(.system(.callout, design: .monospaced))
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    Text(JST.clock(o.ts)).font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("約定した") { store.markFilled(orderID: o.id) }
                    Button("取消") { store.cancel(orderID: o.id) }
                }
                .controlSize(.small)
            }
        }
    }

    private func pendingLabel(_ o: OrderEvent) -> String {
        if let partner = store.book.flipPartner(of: o.id) {
            let total = (Decimal(contract: o.qty) ?? 0) + (Decimal(contract: partner.qty) ?? 0)
            return "ドテン\(o.side.label) \(total.contractString)株"
        }
        return "\(intentLabel(o)) \(o.qty)株"
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

    var body: some View {
        // 一部決済・ドテンは上の大きな「買い」「売り」で行う。ここは成行の全決済だけ
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
            Button("全決済") { store.closeAll(positionID: position.id) }
                .controlSize(.small)
                .help("保有全数を成行で決済する（この建玉の待機中の指値は取り消す）")
        }
        .font(.system(.callout, design: .monospaced))
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

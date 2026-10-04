import AppKit
import Foundation

/// 小窓の状態。本物の発注は存在せず、やることは events.jsonl への追記だけ。
@MainActor
public final class PanelStore: ObservableObject {
    // 入力欄
    @Published public var symbol = ""
    @Published public var qtyText: String { didSet { settings.lastQty = qtyText } }
    @Published public var orderType: OrderType { didSet { settings.orderType = orderType } }
    @Published public var limitPriceText = ""
    @Published public var memoText = ""
    @Published public var memoTarget: UUID?

    // 状態
    @Published public private(set) var events: [PaperEvent] = []
    @Published public private(set) var book = PositionBook()
    @Published public private(set) var dataFolder: URL?
    @Published public private(set) var status = ""
    @Published public private(set) var badLines = 0
    /// 値が変わるたびに画面がメモ欄へフォーカスを移す
    @Published public private(set) var memoFocusRequest = 0

    public let settings: PanelSettings
    let shotTaker: ShotTaking
    private var log: EventLog?
    /// 書き込みを押した順に直列化する（発注の撮影待ちの間に押したメモ等が先に書かれないように）
    private var writeChain: Task<Void, Never>?
    private var lastAutoSymbol: String?
    private var lastSymbolRead = Date.distantPast
    /// マウスが乗った時の自動読み取りの間隔と可否（テストで差し替える）
    var autoReadInterval: TimeInterval = 1.5
    var autoCaptureAllowed: () -> Bool = { WindowCapturer.hasPermission }

    public init(settings: PanelSettings, shotTaker: ShotTaking) {
        self.settings = settings
        self.shotTaker = shotTaker
        self.qtyText = settings.lastQty
        self.orderType = settings.orderType
    }

    // MARK: データフォルダ

    /// 保存済みの bookmark からフォルダを開いて、events.jsonl を再生する
    public func restoreDataFolder() {
        guard let bm = settings.dataFolderBookmark, let resolved = DataFolder.resolve(bm) else {
            status = "データフォルダが未設定です（設定で選んでください）"
            return
        }
        if let refreshed = resolved.refreshed { settings.dataFolderBookmark = refreshed }
        open(folder: resolved.url)
    }

    /// フォルダを開く（テストやプレビューでは bookmark を介さずに直接渡す）
    public func open(folder: URL) {
        let log = EventLog(folder: folder)
        do {
            let r = try log.load()
            self.log = log
            dataFolder = folder
            events = r.events
            badLines = r.badLines
            recompute()
            status = r.badLines > 0 ? "読めない行が \(r.badLines) 件あります（無視しました）" : "記録 \(r.events.count) 件を読み込みました"
            memoTarget = book.memoTargets.first?.id
        } catch {
            status = "events.jsonl を読めません: \(error.localizedDescription)"
        }
    }

    public func chooseDataFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "このフォルダに記録する"
        panel.message = "記録先（tradelog/data/paper）を選んでください。events.jsonl と shots/ がここに作られます。"
        let candidate = DataFolder.defaultCandidate
        panel.directoryURL = FileManager.default.fileExists(atPath: candidate.path) ? candidate : candidate.deletingLastPathComponent()
        NSApp.activate()
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            settings.dataFolderBookmark = try DataFolder.makeBookmark(url)
        } catch {
            status = "フォルダを覚えられません: \(error.localizedDescription)"
            return
        }
        restoreDataFolder()
    }

    // MARK: 発注

    public var canOrder: Bool {
        log != nil && SymbolParser.isValid(symbol) && QtyParser.parse(qtyText) != nil
            && (orderType == .market || PriceParser.parse(limitPriceText) != nil)
    }

    /// 大きな「買い」「売り」。同じ銘柄・同じ向きの建玉があれば買い増し、無ければ新規建て（売りの新規 = 空売り）
    public func placeOrder(side: Side) {
        let ts = JST.nowMillis()
        guard canOrder, let qty = QtyParser.parse(qtyText) else { return }
        let existing = book.openPosition(symbol: symbol, direction: side)
        let order = OrderEvent(ts: ts, positionID: existing?.id ?? UUID(), intent: existing == nil ? .open : .add,
                               symbol: symbol, side: side, qty: qty, orderType: orderType,
                               limitPrice: orderType == .limit ? PriceParser.parse(limitPriceText) : nil)
        submit(order)
    }

    /// 建玉の決済。数量は保有中（待機中の決済指値を除く）を超えない
    public func close(positionID: UUID, qtyText: String, type: OrderType) {
        let ts = JST.nowMillis()
        guard log != nil, let p = book.positions[positionID], let q = QtyParser.parse(qtyText),
              let qd = Decimal(contract: q), qd <= p.closableQty else {
            status = "決済できる数量を超えています"
            return
        }
        var limit: String?
        if type == .limit {
            guard let lp = PriceParser.parse(limitPriceText) else {
                status = "指値決済は上の「価格」欄に指値を入れてください"
                return
            }
            limit = lp
        }
        let order = OrderEvent(ts: ts, positionID: p.id, intent: .close, symbol: p.symbol, side: p.direction.opposite,
                               qty: q, orderType: type, limitPrice: limit)
        submit(order)
    }

    private func submit(_ order: OrderEvent) {
        guard let log else { return }
        // 状態は押した瞬間に反映し、撮影の完了を待ってから shot 付きで 1 行書く
        events.append(.order(order))
        recompute()
        memoTarget = order.positionID
        memoFocusRequest += 1
        status = "\(order.symbol) \(order.side.label) \(order.qty) \(order.orderType.label) \(JST.clock(order.ts)) 撮影中…"

        let previous = writeChain
        let taker = shotTaker
        writeChain = Task { [weak self] in
            let shot = await taker.takeShot(eventID: order.id, ts: order.ts, log: log)
            await previous?.value
            var final = order
            final.shot = shot
            guard let self else { return }
            if let i = self.events.firstIndex(where: { $0.id == order.id }) { self.events[i] = .order(final) }
            self.recompute()
            self.write(.order(final), to: log) {
                let shotText: String
                if let shot {
                    shotText = "撮影OK 現在値 \(shot.price ?? "読めず")"
                } else {
                    shotText = "撮影なし（記録は保存）"
                }
                return "\(order.symbol) \(order.side.label) \(order.qty) \(order.orderType.label) \(JST.clock(order.ts)) \(shotText)"
            }
        }
    }

    // MARK: 指値

    public func markFilled(orderID: UUID) { appendRef(.fillMark(RefEvent(ts: JST.nowMillis(), orderID: orderID)), done: "約定を記録しました") }
    public func cancel(orderID: UUID) { appendRef(.cancel(RefEvent(ts: JST.nowMillis(), orderID: orderID)), done: "取消を記録しました") }

    private func appendRef(_ e: PaperEvent, done: String) {
        guard log != nil else { return }
        events.append(e)
        recompute()
        enqueueWrite(e, done: done)
    }

    // MARK: メモ

    public var canSaveMemo: Bool {
        log != nil && memoTarget != nil && !memoText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public func saveMemo() {
        guard canSaveMemo, let target = memoTarget else { return }
        let e = PaperEvent.memo(MemoEvent(ts: JST.nowMillis(), positionID: target,
                                          orderID: book.positions[target]?.lastOrderID, text: memoText))
        events.append(e)
        recompute()
        memoText = ""
        enqueueWrite(e, done: "メモを保存しました")
    }

    // MARK: 銘柄コードの自動入力

    /// 画面の銘柄コード領域を読み、前回読んだコードから変わった時だけ欄を上書きする
    /// （手で直した値は、HYPER SBI 2 側で銘柄を切り替えるまで残る）
    public func refreshSymbolFromScreen(force: Bool = false) {
        guard settings.symbolRegion != nil else { return }
        // 権限が無いうちはマウスが乗るたびに OS のダイアログを出さない
        guard force || (autoCaptureAllowed() && Date().timeIntervalSince(lastSymbolRead) >= autoReadInterval) else { return }
        lastSymbolRead = Date()
        let taker = shotTaker
        Task { [weak self] in
            guard let code = await taker.readSymbol(), let self else { return }
            if force || code != self.lastAutoSymbol {
                self.lastAutoSymbol = code
                self.symbol = code
            }
        }
    }

    // MARK: 終了

    /// 書きかけのイベントを全部書き切るまで待つ（終了時に呼ぶ）
    public func flush() async {
        await writeChain?.value
    }

    // MARK: 内部

    private func enqueueWrite(_ e: PaperEvent, done: String) {
        guard let log else { return }
        let previous = writeChain
        writeChain = Task { [weak self] in
            await previous?.value
            self?.write(e, to: log) { done }
        }
    }

    private func write(_ e: PaperEvent, to log: EventLog, done: () -> String) {
        do {
            try log.append(e)
            status = done()
        } catch {
            status = "書き込みに失敗: \(error.localizedDescription)"
        }
    }

    private func recompute() {
        book = PositionBook.replay(events)
    }
}

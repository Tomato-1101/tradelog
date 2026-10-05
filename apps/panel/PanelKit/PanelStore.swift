import AppKit
import Combine
import Foundation

/// 小窓の状態。本物の発注は存在せず、やることは events.jsonl への追記だけ。
@MainActor
public final class PanelStore: ObservableObject {
    // 入力欄
    @Published public var symbol = "" { didSet { disarmFlip() } }
    @Published public var qtyText: String { didSet { settings.lastQty = qtyText; disarmFlip() } }
    @Published public var orderType: OrderType { didSet { settings.orderType = orderType; disarmFlip() } }
    @Published public var limitPriceText = "" { didSet { disarmFlip() } }
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
    /// ドテンになる発注は 1 回目の押下でここに向きを入れ、3 秒以内にもう一度押すと書く
    @Published public private(set) var armedFlip: Side?
    /// 直近の発注の、押下から撮影完了までのミリ秒（小窓の状態表示用）
    @Published public private(set) var lastShotLatencyMs: Int?
    /// リプレイ練習中の録画（nil なら通常のペーパー）。記録先・時刻・撮影がすべて録画側に切り替わる
    @Published public private(set) var replay: ReplaySession?

    public let settings: PanelSettings
    let shotTaker: ShotTaking
    /// 録画（開始・停止・一覧）
    public let recording = RecordingController()
    /// 再生ウィンドウを出す・閉じる（アプリ側が入れる）
    public var presentReplayWindow: ((ReplaySession) -> Void)?
    public var dismissReplayWindow: (() -> Void)?
    /// リプレイの撮影（テストで差し替える）
    var makeReplayTaker: (ReplaySession) -> ShotTaking = { ReplayShotTaker(session: $0) }
    private var replayTaker: ShotTaking?
    private var replayObservation: AnyCancellable?
    private var log: EventLog?
    /// 書き込みを押した順に直列化する（発注の撮影待ちの間に押したメモ等が先に書かれないように）
    private var writeChain: Task<Void, Never>?
    private var lastAutoSymbol: String?
    private var lastSymbolRead = Date.distantPast
    private var armedAt = Date.distantPast
    /// 予告した時の内容。2 回目に計算し直した内容と完全に同じ時だけ書く
    private var armedPlan: OrderPlan?
    /// 書き込みに失敗した回数。積んだ時点の値と違えば、先に積んだ書き込みが失敗している（続きも書かずに画面から戻す）
    private var writeFailures = 0
    private var refreshLoop: Task<Void, Never>?
    /// 全画面 OCR のサイドカーで後から読めた現在値（ocr_path → 価格）。建値の表示にだけ使う
    private var autoByPath: [String: String] = [:]
    /// マウスが乗った時の自動読み取りの間隔と可否（テストで差し替える）
    var autoReadInterval: TimeInterval = 1.5
    var autoCaptureAllowed: () -> Bool = { WindowCapturer.hasPermission }
    /// ドテンの確認の猶予（秒）
    var flipConfirmWindow: TimeInterval = 3

    public init(settings: PanelSettings, shotTaker: ShotTaking) {
        self.settings = settings
        self.shotTaker = shotTaker
        self.qtyText = settings.lastQty
        self.orderType = settings.orderType
        shotTaker.onAutoRead = { [weak self] path, auto in
            Task { @MainActor in self?.applyAutoRead(path: path, auto: auto) }
        }
        recording.dataFolder = { [weak self] in self?.dataFolder }
    }

    /// いま使う撮影（リプレイ中は録画のフレーム）
    private var taker: ShotTaking { replayTaker ?? shotTaker }

    /// 押した瞬間の時刻。リプレイ中は録画上の実時刻（started_at ＋ 再生位置）
    private func now() -> Date {
        guard let replay else { return JST.nowMillis() }
        return ReplayClock.ts(startedAt: replay.startedAt, videoMs: replay.currentVideoMs())
    }

    /// リプレイ中で、一時停止中か再生ウィンドウが無い（時刻が決まらないので発注・約定・取消・全決済を押せない）
    public var replayBlocked: Bool { replay.map { !$0.canTrade } ?? false }

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
        // リプレイ中に通常の events.jsonl を読み込むと、リプレイの印の無い行が通常側に書かれてしまう
        guard replay == nil else {
            status = Self.folderLockedInReplay
            return
        }
        let log = EventLog(folder: folder)
        do {
            let r = try log.load()
            self.log = log
            dataFolder = folder
            events = r.events
            badLines = r.badLines
            autoByPath = [:]
            recompute()
            loadAutoReadsForOpenPositions(folder: folder)
            status = r.badLines > 0 ? "読めない行が \(r.badLines) 件あります（無視しました）" : "記録 \(r.events.count) 件を読み込みました"
            if let first = book.warnings.first {
                status += "・要確認 \(book.warnings.count) 件（\(first)）"
            }
            memoTarget = book.memoTargets.first?.id
        } catch {
            status = "events.jsonl を読めません: \(error.localizedDescription)"
        }
    }

    static let folderLockedInReplay = "リプレイ練習中は記録先を変えられません（「練習を終える」の後に選び直してください）"

    public func chooseDataFolder() {
        guard replay == nil else {
            status = Self.folderLockedInReplay
            return
        }
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
        log != nil && !replayBlocked && SymbolParser.isValid(symbol) && QtyParser.parse(qtyText) != nil
            && (orderType == .market || PriceParser.parse(limitPriceText) != nil)
    }

    /// 今の入力でそのボタンを押したら何が起きるか（押す前の表示用）。押せない入力なら nil
    public func previewPlan(side: Side) -> OrderPlan? {
        guard canOrder, let qty = QtyParser.parse(qtyText) else { return nil }
        return book.plan(symbol: symbol, side: side, qty: qty, orderType: orderType,
                         limitPrice: orderType == .limit ? PriceParser.parse(limitPriceText) : nil, ts: Date())
    }

    /// 大きな「買い」「売り」。銘柄ごとに建玉は 1 つ（ネッティング）で、新規・買い増し・決済・ドテンをここだけで行う。
    /// ドテンになる時だけ、1 回目は予告して止まり、3 秒以内のもう一度で書く
    public func placeOrder(side: Side) {
        let ts = now()
        guard canOrder, let qty = QtyParser.parse(qtyText),
              let plan = book.plan(symbol: symbol, side: side, qty: qty, orderType: orderType,
                                   limitPrice: orderType == .limit ? PriceParser.parse(limitPriceText) : nil, ts: ts)
        else { return }
        if plan.isFlip {
            let confirming = armedFlip == side && Date().timeIntervalSince(armedAt) <= flipConfirmWindow
            // 予告した時と書く内容（決済数・新規数・取消対象）が完全に同じ時だけ書く。変わっていたら予告し直す
            guard confirming, armedPlan?.sameEffect(as: plan) == true else {
                armFlip(side, plan: plan, changed: confirming)
                return
            }
        }
        disarmFlip()
        execute(plan)
    }

    /// 建玉の行の「全決済」。成行で保有全数を反対売買する（その建玉の待機中の指値は取り消す）
    public func closeAll(positionID: UUID) {
        let ts = now()
        guard log != nil, !replayBlocked, let p = book.positions[positionID], p.isOpen,
              let plan = book.plan(symbol: p.symbol, side: p.direction.opposite, qty: p.qty.contractString, orderType: .market,
                                   limitPrice: nil, ts: ts, target: p.id)
        else { return }
        disarmFlip()
        execute(plan)
    }

    private func armFlip(_ side: Side, plan: OrderPlan, changed: Bool = false) {
        armedFlip = side
        armedPlan = plan
        let at = Date()
        armedAt = at
        status = "\(changed ? "内容が変わりました: " : "")\(plan.summary)。もう一度押すと発注します"
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64((self?.flipConfirmWindow ?? 3) * 1_000_000_000))
            guard let self, self.armedAt == at, self.armedFlip != nil else { return }
            self.disarmFlip()
            self.status = "ドテンを取りやめました"
        }
    }

    private func disarmFlip() {
        if armedFlip != nil { armedFlip = nil }
        armedPlan = nil
    }

    private func execute(_ plan: OrderPlan) {
        guard let log, let first = plan.orders.first else { return }
        // 状態は押した瞬間に反映し、撮影の完了を待ってから shot 付きで書く（取消 → order の順）
        let cancels = plan.cancels.map { PaperEvent.cancel(RefEvent(ts: first.ts, orderID: $0.id)) }
        events.append(contentsOf: cancels)
        events.append(contentsOf: plan.orders.map(PaperEvent.order))
        recompute()
        memoTarget = plan.orders.last?.positionID
        memoFocusRequest += 1
        let head = "\(first.symbol) \(plan.summary) \(first.orderType.label) \(JST.clock(first.ts))"
        status = "\(head) 撮影中…"

        let previous = writeChain
        let taker = taker
        let failuresAtPress = writeFailures
        writeChain = Task { [weak self] in
            // ドテンの 2 行は同じ画像・同じ OCR を共有する（ファイル名は 1 行目の id）
            let shot = await taker.takeShot(eventID: first.id, ts: first.ts, log: log, symbol: first.symbol)
            await previous?.value
            guard let self else { return }
            let finals = plan.orders.map { o -> OrderEvent in
                var final = o
                final.shot = shot
                return final
            }
            let latency = shot?.capturedAt.map { Int(($0.timeIntervalSince(first.ts) * 1000).rounded()) }
            self.lastShotLatencyMs = latency
            // 取消と order（ドテンなら 2 行）をまとめて 1 回で書く。失敗したら画面からも外す
            guard self.commit(cancels + finals.map(PaperEvent.order), to: log, failuresAtPress: failuresAtPress) else { return }
            for final in finals {
                if let i = self.events.firstIndex(where: { $0.id == final.id }) { self.events[i] = .order(final) }
            }
            self.recompute()
            if let shot {
                let ms = latency.map { "撮影 \($0)ms" } ?? "撮影OK"
                self.status = "\(head) \(ms) 現在値 \(shot.price ?? "自動読み取り中")"
            } else {
                self.status = "\(head) 撮影なし（記録は保存）"
            }
        }
    }

    // MARK: 指値

    /// ドテンの 2 行の片方なら、相方も同じ時刻で約定・取消にする（片方だけだと両建てになる）。
    /// 決済指値の約定で建玉が 0 になる時は、その建玉に残る新規・買い増し指値も取り消す（PositionBook.refEvents）
    public func markFilled(orderID: UUID) { appendRefs(orderID, fill: true, done: "約定を記録しました") }
    public func cancel(orderID: UUID) { appendRefs(orderID, fill: false, done: "取消を記録しました") }

    private func appendRefs(_ orderID: UUID, fill: Bool, done: String) {
        guard log != nil, !replayBlocked else { return }
        let batch = book.refEvents(orderID: orderID, fill: fill, ts: now())
        guard !batch.isEmpty else { return }
        // 建玉が変わるので、ドテンの予告は解除する（変わった数量を確認なしに書かない）
        disarmFlip()
        events.append(contentsOf: batch)
        recompute()
        let extra = fill ? batch.filter { if case .cancel = $0 { return true } else { return false } }.count : 0
        enqueueWrite(batch, done: extra > 0 ? "\(done)（建玉が 0 になったので残りの指値 \(extra) 件を取消）" : done)
    }

    // MARK: メモ

    public var canSaveMemo: Bool {
        log != nil && memoTarget != nil && !memoText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public func saveMemo() {
        guard canSaveMemo, let target = memoTarget else { return }
        // リプレイ中は一時停止していても、再生位置の時刻で書ける
        let e = PaperEvent.memo(MemoEvent(ts: now(), positionID: target,
                                          orderID: book.positions[target]?.lastOrderID, text: memoText))
        events.append(e)
        recompute()
        memoText = ""
        enqueueWrite([e], done: "メモを保存しました")
    }

    // MARK: 撮影対象のキャッシュと銘柄コードの自動入力

    /// 小窓にマウスが乗った: 撮影対象のウィンドウを探し直しておき（発注時は撮るだけにする）、銘柄コードを読む
    public func hoverEntered() {
        if replay == nil, autoCaptureAllowed() { shotTaker.refreshTarget() }
        refreshSymbolFromScreen()
    }

    /// 撮影対象のキャッシュを定期的に更新する（アプリの起動時に 1 回呼ぶ）
    public func startBackgroundRefresh(every seconds: TimeInterval = 10) {
        refreshLoop?.cancel()
        refreshLoop = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if self.autoCaptureAllowed() { self.shotTaker.refreshTarget() }
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            }
        }
    }

    /// 銘柄コードを読み（ウィンドウタイトルの「(5803)」→ 無ければ銘柄コード領域の OCR）、
    /// 前回読んだコードから変わった時だけ欄を上書きする（手で直した値は、HYPER SBI 2 側で銘柄を切り替えるまで残る）
    public func refreshSymbolFromScreen(force: Bool = false) {
        // 権限が無いうちはマウスが乗るたびに OS のダイアログを出さない
        // リプレイ中は録画のメタから読むので、画面収録の権限は要らない
        guard force || ((replay != nil || autoCaptureAllowed()) && Date().timeIntervalSince(lastSymbolRead) >= autoReadInterval) else { return }
        lastSymbolRead = Date()
        let taker = taker
        Task { [weak self] in
            guard let code = await taker.readSymbol(), let self else { return }
            if force || code != self.lastAutoSymbol {
                self.lastAutoSymbol = code
                self.symbol = code
            }
        }
    }

    // MARK: 終了

    /// 書きかけのイベントと、裏で走っている全画面 OCR を書き切るまで待つ（終了時に呼ぶ）
    public func flush() async {
        await writeChain?.value
        await shotTaker.waitForBackground()
        await replayTaker?.waitForBackground()
    }

    // MARK: リプレイ練習

    /// 保存済みの録画で練習を始める（設定の一覧・メニューから）
    public func startReplay(_ entry: RecordingEntry) {
        Task {
            // 一覧の確認がまだでも、開く前に mp4 が再生できるかを確かめる
            guard entry.canReplay, await RecordingEntry.hasPlayableVideo(entry.mp4), let session = ReplaySession(entry: entry) else {
                status = "この録画は再生できません（\(entry.id)）"
                return
            }
            await enterReplay(session)
        }
    }

    /// 記録先を data/paper/replay/events.jsonl に切り替え、新しい練習（建玉は空）を始める。通常のペーパーの建玉とは混ぜない
    public func enterReplay(_ session: ReplaySession) async {
        await writeChain?.value
        guard let folder = dataFolder else {
            status = "データフォルダが未設定です（設定で選んでください）"
            return
        }
        replay?.close()
        let tag = ReplayTag(recordingID: session.meta.id, sessionID: session.sessionID, startedAt: session.startedAt)
        log = EventLog(folder: RecordingPaths.replayFolder(folder), replay: tag)
        let t = makeReplayTaker(session)
        t.onAutoRead = { [weak self] path, auto in
            Task { @MainActor in self?.applyAutoRead(path: path, auto: auto) }
        }
        replayTaker = t
        replay = session
        // 発注できるかどうか（再生中・ウィンドウあり）が変わったら小窓を描き直す
        replayObservation = session.$isPlaying.combineLatest(session.$windowOpen)
            .removeDuplicates { $0 == $1 }
            .sink { [weak self] _ in self?.objectWillChange.send() }
        events = []
        badLines = 0
        autoByPath = [:]
        disarmFlip()
        recompute()
        memoTarget = nil
        lastAutoSymbol = nil
        status = "リプレイ練習 \(session.meta.id)（再生すると発注できます）"
        presentReplayWindow?(session)
    }

    /// 再生ウィンドウを出し直す（閉じた後に小窓から）
    public func showReplayWindow() {
        if let replay { presentReplayWindow?(replay) }
    }

    /// 練習を終えて通常のペーパーに戻る（events.jsonl を読み直す）
    public func exitReplay() async {
        guard let session = replay else { return }
        await writeChain?.value
        await replayTaker?.waitForBackground()
        session.close()
        dismissReplayWindow?()
        replay = nil
        replayTaker = nil
        replayObservation = nil
        lastAutoSymbol = nil
        if let folder = dataFolder {
            open(folder: folder)
        } else {
            log = nil
            events = []
            recompute()
        }
    }

    // MARK: 内部

    private func enqueueWrite(_ batch: [PaperEvent], done: String) {
        guard let log else { return }
        let previous = writeChain
        let failuresAtPress = writeFailures
        writeChain = Task { [weak self] in
            await previous?.value
            guard let self, self.commit(batch, to: log, failuresAtPress: failuresAtPress) else { return }
            self.status = done
        }
    }

    /// 1 回の操作の行をまとめて 1 回の write で書く。書けなかったら（または先に積んだ書き込みが失敗していたら）
    /// その行を画面の状態からも外して、ファイルと画面を一致させる
    private func commit(_ batch: [PaperEvent], to log: EventLog, failuresAtPress: Int) -> Bool {
        if failuresAtPress == writeFailures {
            do {
                try log.append(contentsOf: batch)
                return true
            } catch {
                writeFailures += 1
                status = "書き込みに失敗: \(error.localizedDescription)（この操作は記録していません）"
            }
        }
        let ids = Set(batch.map(\.id))
        events.removeAll { ids.contains($0.id) }
        recompute()
        disarmFlip()
        if let t = memoTarget, book.positions[t] == nil { memoTarget = book.memoTargets.first?.id }
        return false
    }

    private func applyAutoRead(path: String, auto: AutoRead) {
        guard let price = auto.price else { return }
        autoByPath[path] = price
        recompute()
    }

    /// 起動時: 保有中の建玉で現在値が未記録（領域を設定していない）の成行だけ、サイドカーの自動読み取りを拾う
    private func loadAutoReadsForOpenPositions(folder: URL) {
        let open = Set(book.openPositions.map(\.id))
        var found = false
        for case .order(let o) in events where open.contains(o.positionID) && o.orderType == .market && o.shot?.price == nil {
            guard let path = o.shot?.ocrPath, autoByPath[path] == nil,
                  let price = OCRSidecar.load(folder.appendingPathComponent(path))?.auto.price else { continue }
            autoByPath[path] = price
            found = true
        }
        if found { recompute() }
    }

    private func recompute() {
        var auto: [UUID: String] = [:]
        if !autoByPath.isEmpty {
            for case .order(let o) in events where o.shot?.price == nil {
                if let path = o.shot?.ocrPath, let v = autoByPath[path] { auto[o.id] = v }
            }
        }
        book = PositionBook.replay(events, autoPrices: auto)
        if let replay {
            // 最後に記録した発注・約定・取消より前には戻さない（メモは一時停止中も書けるので床にしない）
            let floor = events.lazy.filter { if case .memo = $0 { return false } else { return true } }
                .map { ReplayClock.videoMs(ts: $0.ts, startedAt: replay.startedAt) }.max() ?? 0
            replay.setFloor(floor)
        }
    }
}

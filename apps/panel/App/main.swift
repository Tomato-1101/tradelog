import AppKit
import PanelKit
import SwiftUI

/// 常に最前面に出す小窓。クリックしても HYPER SBI 2 からアプリの切替を起こさない（nonactivatingPanel）が、
/// キー入力（メモ欄・音声入力）は受けられるように key window にはなれるようにする
final class FloatingPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuDelegate {
    private var panel: FloatingPanel!
    private var settingsWindow: NSWindow?
    private var replayWindow: NSWindow?
    private var replayMenu: NSMenu?
    /// 起動の途中で届いた録画の指示（データフォルダを開いてから始める）
    private var pendingRecordMinutes: Int?
    private var launched = false
    private let settings = PanelSettings()
    private lazy var store = PanelStore(settings: settings, shotTaker: ScreenShotTaker(settings: settings))

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = makeMainMenu()
        store.restoreDataFolder()
        // Vision の初回はモデルの読み込みで十数秒かかるので、最初の発注より前に裏で 1 回読んでおく
        Task.detached(priority: .utility) { BoardReader.warmUp() }
        // 撮影対象のウィンドウを覚えておき、発注時は撮るだけにする（マウスが乗った時にも作り直す）
        store.startBackgroundRefresh()

        panel = FloatingPanel(contentRect: NSRect(x: 0, y: 0, width: 360, height: 560),
                              styleMask: [.titled, .closable, .resizable, .utilityWindow, .nonactivatingPanel],
                              backing: .buffered, defer: false)
        panel.title = "ペーパー発注"
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = false
        // 全 Space に出し、フルスクリーンのアプリの上にも重ねる
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        panel.contentView = NSHostingView(rootView: PanelView(store: store, openSettings: { [weak self] in self?.showSettings() }))
        if !panel.setFrameUsingName("TradePanel") { panel.center() }
        panel.setFrameAutosaveName("TradePanel")
        panel.orderFrontRegardless()

        if settings.dataFolderBookmark == nil {
            showSettings()
        }

        store.presentReplayWindow = { [weak self] session in self?.showReplayWindow(session) }
        store.dismissReplayWindow = { [weak self] in self?.replayWindow?.close() }
        // 録画の指示: 起動引数 --record-minutes N（launchd の record から open -g -a … --args で来る）
        launched = true
        if let m = RecordCommand.minutes(fromArguments: ProcessInfo.processInfo.arguments) ?? pendingRecordMinutes {
            pendingRecordMinutes = nil
            store.recording.start(minutes: m)
        }
    }

    /// 起動中のインスタンスへの録画の指示: tradepanel://record?minutes=N（open -g -a TradePanel.app 'tradepanel://…'）
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            guard let m = RecordCommand.minutes(fromURL: url) else { continue }
            if launched {
                store.recording.start(minutes: m)
            } else {
                pendingRecordMinutes = m
            }
        }
    }

    /// 再生ウィンドウ（通常のウィンドウ。小窓はその上に重なる）
    private func showReplayWindow(_ session: ReplaySession) {
        if replayWindow == nil {
            // 最初は画面の 85% に録画の縦横比で収める（大きさを変えたら次からはその大きさ）
            let visible = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame.size ?? CGSize(width: 1300, height: 900)
            let size = ReplayWindowSize.initial(visible: visible, videoWidth: session.meta.width, videoHeight: session.meta.height)
            let w = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                             styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
            w.isReleasedWhenClosed = false
            w.delegate = self
            w.collectionBehavior = [.fullScreenPrimary, .moveToActiveSpace]
            replayWindow = w
            if !w.setFrameUsingName("TradePanelReplay") { w.center() }
            w.setFrameAutosaveName("TradePanelReplay")
        }
        replayWindow?.title = "リプレイ \(session.meta.id)"
        replayWindow?.contentView = NSHostingView(rootView: ReplayPlayerView(session: session))
        session.windowOpen = true
        NSApp.activate()
        replayWindow?.makeKeyAndOrderFront(nil)
    }

    // 小窓を閉じたら終了する（常駐アイコンは持たない）
    func windowWillClose(_ notification: Notification) {
        let w = notification.object as? NSWindow
        if w === panel { NSApp.terminate(nil) }
        // 再生ウィンドウを閉じたら一時停止して発注できなくする（練習は続く。小窓の「再生画面」で開き直せる）
        if w === replayWindow, let session = store.replay {
            session.player.pause()
            session.windowOpen = false
            replayWindow?.contentView = nil
            replayWindow = nil
        } else if w === replayWindow {
            replayWindow = nil
        }
    }

    @objc private func replayFromMenu(_ sender: NSMenuItem) {
        guard let e = sender.representedObject as? RecordingEntryBox else { return }
        store.startReplay(e.entry)
    }

    @objc private func recordNow(_ sender: NSMenuItem) {
        store.recording.start(minutes: 37)
    }

    @objc private func stopRecording(_ sender: NSMenuItem) {
        store.recording.stop()
    }

    /// 「リプレイ練習」メニューを開くたびに録画の一覧を作り直す
    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === replayMenu else { return }
        menu.removeAllItems()
        store.recording.reloadList()
        let entries = store.recording.entries.filter(\.canReplay).prefix(15)
        if entries.isEmpty {
            menu.addItem(withTitle: "録画がありません", action: nil, keyEquivalent: "").isEnabled = false
        }
        for e in entries {
            let title = e.meta?.startedAt.map { "\(JST.day($0)) \(JST.clock($0))" } ?? e.id
            let item = menu.addItem(withTitle: title, action: #selector(replayFromMenu(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = RecordingEntryBox(e)
            item.isEnabled = e.id != store.recording.activeID
        }
        menu.addItem(.separator())
        if store.recording.isRecording {
            menu.addItem(withTitle: "録画を止める", action: #selector(stopRecording(_:)), keyEquivalent: "").target = self
        } else {
            menu.addItem(withTitle: "今すぐ録画（37 分）", action: #selector(recordNow(_:)), keyEquivalent: "").target = self
        }
        menu.addItem(withTitle: "録画の一覧（設定）…", action: #selector(showSettings), keyEquivalent: "").target = self
    }

    // 撮影待ちのイベントと録画を書き切ってから終わる
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        Task { @MainActor in
            await store.flush()
            await store.recording.stopAndWait()
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    @objc func showSettings() {
        if settingsWindow == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 720),
                             styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
            w.title = "ペーパー発注 設定"
            w.isReleasedWhenClosed = false
            // フルスクリーンの HYPER SBI 2 のスペースでも開けるように（「画面上で囲む」は対象が今の画面に出ている必要がある）
            w.collectionBehavior = [.fullScreenAuxiliary, .moveToActiveSpace]
            w.contentView = NSHostingView(rootView: SettingsView(store: store))
            w.center()
            settingsWindow = w
        }
        NSApp.activate()
        settingsWindow?.makeKeyAndOrderFront(nil)
    }

    /// LSUIElement のアプリはメニューを組まないと ⌘V（音声入力の貼り付け）等が効かない
    private func makeMainMenu() -> NSMenu {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "設定…", action: #selector(showSettings), keyEquivalent: ",").target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "ペーパー発注を終了", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let replayItem = NSMenuItem()
        let replay = NSMenu(title: "リプレイ練習")
        replay.delegate = self
        replayItem.submenu = replay
        replayMenu = replay
        main.addItem(replayItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "編集")
        edit.addItem(withTitle: "取り消す", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "やり直す", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "カット", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "コピー", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "ペースト", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "すべてを選択", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)
        return main
    }
}

/// NSMenuItem.representedObject に構造体を載せるための箱
final class RecordingEntryBox: NSObject {
    let entry: RecordingEntry
    init(_ entry: RecordingEntry) { self.entry = entry }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
}

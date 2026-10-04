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
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var panel: FloatingPanel!
    private var settingsWindow: NSWindow?
    private let settings = PanelSettings()
    private lazy var store = PanelStore(settings: settings, shotTaker: ScreenShotTaker(settings: settings))

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = makeMainMenu()
        store.restoreDataFolder()

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
    }

    // 小窓を閉じたら終了する（常駐アイコンは持たない）
    func windowWillClose(_ notification: Notification) {
        if (notification.object as? NSWindow) === panel { NSApp.terminate(nil) }
    }

    // 撮影待ちのイベントを書き切ってから終わる
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        Task { @MainActor in
            await store.flush()
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

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
}

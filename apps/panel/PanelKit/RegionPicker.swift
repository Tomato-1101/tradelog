import AppKit

/// 画面上で直接ドラッグして読み取り領域を囲む（⌘⇧4 のような範囲選択）。
/// 枠の無い半透明のオーバーレイを 1 画面に出し、ユーザー自身のドラッグを受け取るだけ。
/// カーソルを動かす・クリックを合成するといった操作は一切しない。
@MainActor
final class RegionPicker {
    private let overlay: OverlayWindow
    private let view: OverlayView
    private var hidden: [NSWindow] = []
    private weak var previousKey: NSWindow?
    private var continuation: CheckedContinuation<CGRect?, Never>?

    /// screen: オーバーレイを出す画面。windowFrame: 対象ウィンドウの SCWindow.frame（CG 座標）。
    /// 戻り値は囲んだ矩形（AppKit のグローバル座標）。Esc なら nil
    static func pick(on screen: NSScreen, windowFrame: CGRect, primaryHeight: CGFloat, prompt: String) async -> CGRect? {
        let picker = RegionPicker(screen: screen, windowFrame: windowFrame, primaryHeight: primaryHeight, prompt: prompt)
        return await withCheckedContinuation { cont in picker.start(cont) }
    }

    private init(screen: NSScreen, windowFrame: CGRect, primaryHeight: CGFloat, prompt: String) {
        overlay = OverlayWindow(contentRect: screen.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        overlay.setFrame(screen.frame, display: false)
        overlay.isOpaque = false
        overlay.backgroundColor = .clear
        overlay.hasShadow = false
        overlay.ignoresMouseEvents = false
        overlay.isReleasedWhenClosed = false
        // HYPER SBI 2 がフルスクリーンでも、小窓（.floating）より上にも出す
        overlay.level = .screenSaver
        overlay.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        let windowRect = overlay.convertFromScreen(ScreenGeometry.appKitRect(fromCG: windowFrame, primaryHeight: primaryHeight))
        view = OverlayView(frame: NSRect(origin: .zero, size: screen.frame.size), windowRect: windowRect, prompt: prompt)
        overlay.contentView = view
    }

    private func start(_ cont: CheckedContinuation<CGRect?, Never>) {
        continuation = cont
        view.onFinish = { [self] local in finish(local) }
        // 自分の設定画面・小窓が HYPER SBI 2 の数字に重なっていると囲めないので、選んでいる間だけ隠す
        previousKey = NSApp.keyWindow
        hidden = NSApp.windows.filter { $0.isVisible && $0 !== overlay }
        hidden.forEach { $0.orderOut(nil) }
        NSApp.activate()
        overlay.makeKeyAndOrderFront(nil)
        overlay.makeFirstResponder(view)
    }

    private func finish(_ local: CGRect?) {
        view.onFinish = nil
        let result = local.map { overlay.convertToScreen($0) }
        overlay.orderOut(nil)
        hidden.forEach { $0.orderFrontRegardless() }
        hidden = []
        previousKey?.makeKeyAndOrderFront(nil)
        continuation?.resume(returning: result)
        continuation = nil
    }
}

private final class OverlayWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

private final class OverlayView: NSView {
    /// 対象ウィンドウの位置（このビューの座標。左下原点）
    let windowRect: CGRect
    let prompt: String
    var onFinish: ((CGRect?) -> Void)?
    private var start: CGPoint?
    private var current: CGPoint?

    init(frame: NSRect, windowRect: CGRect, prompt: String) {
        self.windowRect = windowRect
        self.prompt = prompt
        super.init(frame: frame)
    }

    required init?(coder: NSCoder) { nil }

    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .crosshair) }

    private var selection: CGRect? {
        guard let a = start, let b = current else { return nil }
        return CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(b.x - a.x), height: abs(b.y - a.y))
    }

    /// 囲める範囲は対象ウィンドウの中だけ
    private func clamp(_ p: CGPoint) -> CGPoint {
        CGPoint(x: min(max(p.x, windowRect.minX), windowRect.maxX), y: min(max(p.y, windowRect.minY), windowRect.maxY))
    }

    override func mouseDown(with event: NSEvent) {
        start = clamp(convert(event.locationInWindow, from: nil))
        current = start
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        current = clamp(convert(event.locationInWindow, from: nil))
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        current = clamp(convert(event.locationInWindow, from: nil))
        if let s = selection, s.width >= 4, s.height >= 4 {
            onFinish?(s)
        } else {
            // クリックだけ・小さすぎる時は選び直し（オーバーレイは閉じない）
            start = nil
            current = nil
            needsDisplay = true
        }
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { onFinish?(nil) } else { super.keyDown(with: event) }  // 53 = Esc
    }

    override func cancelOperation(_ sender: Any?) { onFinish?(nil) }

    override func draw(_ dirtyRect: NSRect) {
        // ウィンドウの外を暗くする（中は素通し）
        let dim = NSBezierPath(rect: bounds)
        dim.append(NSBezierPath(rect: windowRect))
        dim.windingRule = .evenOdd
        NSColor.black.withAlphaComponent(0.55).setFill()
        dim.fill()
        // 完全に透明な画素はクリックが下のウィンドウへ抜けるので、中もごく薄く塗っておく
        NSColor.black.withAlphaComponent(0.01).setFill()
        NSBezierPath(rect: windowRect).fill()

        let border = NSBezierPath(rect: windowRect.insetBy(dx: -1.5, dy: -1.5))
        border.lineWidth = 3
        NSColor.systemYellow.setStroke()
        border.stroke()

        if let s = selection {
            NSColor.white.withAlphaComponent(0.12).setFill()
            NSBezierPath(rect: s).fill()
            let p = NSBezierPath(rect: s)
            p.lineWidth = 2
            NSColor.systemOrange.setStroke()
            p.stroke()
        } else {
            drawPrompt()
        }
    }

    private func drawPrompt() {
        let text = NSAttributedString(string: prompt, attributes: [
            .font: NSFont.systemFont(ofSize: 15, weight: .medium),
            .foregroundColor: NSColor.white,
        ])
        let size = text.size()
        let box = CGRect(x: bounds.midX - size.width / 2 - 14, y: bounds.maxY - 72, width: size.width + 28, height: size.height + 14)
        NSColor.black.withAlphaComponent(0.75).setFill()
        NSBezierPath(roundedRect: box, xRadius: 8, yRadius: 8).fill()
        text.draw(at: CGPoint(x: box.minX + 14, y: box.minY + 7))
    }
}

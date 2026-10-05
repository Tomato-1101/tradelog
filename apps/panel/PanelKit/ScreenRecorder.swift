import AppKit
import CoreMedia
import Foundation
import ScreenCaptureKit
import os

/// 録画の 1 回分。HYPER SBI 2 のウィンドウだけを含めて、それが出ている画面を締め切りまで録る（画面収録の権限が要る）。
/// 途切れたら理由をメタの issues・os.Logger・状態表示に残し、数秒おきに録り直す（同じ mp4 に続けて書くので、再生位置と実時刻はずれない）
public final class ScreenRecorder: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    /// 状態表示用のスナップショット
    public struct Progress: Sendable {
        public var id: String
        public var startedAt: Date?
        public var deadline: Date
        public var frames: Int
        /// いま続いている問題（黒い画面・HYPER SBI 2 なし等）。無ければ nil
        public var problem: String?
        public var issueCount: Int
    }

    static let logger = Logger(subsystem: "com.tomato.tradelog.panel", category: "record")
    public let id: String
    public let mp4URL: URL
    public let jsonURL: URL
    public var onProgress: ((Progress) -> Void)?
    let fps = 10

    /// フレームの受け取り・書き出し・メタの更新はすべてこのキューで行う
    private let queue = DispatchQueue(label: "com.tomato.tradelog.panel.record")
    private var meta: RecordingMeta
    private var writer: RecordingWriter?
    private var deadline: Date
    private var stopRequested = false
    private var streamError: String?
    private var displayFrame: CGRect?
    private var lastFrameAt: Date?
    private var lastBlackCheck = Date.distantPast
    private var blackSince: Date?
    private var blackReported = false
    private var noFramesReported = false
    private var writeErrorReported = false
    private var problem: String?

    public init(dataFolder: URL, id: String, day: String, minutes: Int, now: Date = Date()) {
        self.id = id
        let files = RecordingPaths.files(dataFolder: dataFolder, id: id, day: day)
        mp4URL = files.mp4
        jsonURL = files.json
        deadline = now.addingTimeInterval(TimeInterval(minutes * 60))
        meta = RecordingMeta(id: id, fps: fps, plannedMinutes: minutes)
    }

    public func stop() { queue.sync { stopRequested = true } }

    /// 録画中にもう一度指示が来たら、締め切りを遅い方に延ばす
    public func extend(to date: Date) { queue.sync { deadline = max(deadline, date) } }

    public var currentDeadline: Date { queue.sync { deadline } }

    private var shouldStop: Bool { queue.sync { stopRequested || Date() >= deadline } }

    // MARK: 本体

    public func run() async {
        Self.logger.info("録画開始 \(self.id, privacy: .public) 締め切り \(JST.format(self.currentDeadline), privacy: .public)")
        writeMeta()
        guard WindowCapturer.hasPermission else {
            issue("no_permission", "画面収録の権限が無い（設定 > 画面とシステムオーディオの収録 で許可し、アプリを再起動）", problem: "画面収録の権限なし")
            await finish()
            return
        }
        var stream: SCStream?
        var app: NSRunningApplication?
        var retryAt = Date.distantPast
        var noAppReported = false
        var lastLocked: Bool?
        var lastMetaWrite = Date()
        while !shouldStop {
            let now = Date()
            let locked = Self.isScreenLocked()
            if let locked, locked != lastLocked, lastLocked != nil || locked {
                issue(locked ? "locked" : "unlocked", locked ? "画面がロックされた" : "画面のロックが解除された")
            }
            lastLocked = locked ?? lastLocked

            if let a = app, a.isTerminated {
                issue("no_app", "HYPER SBI 2 が終了した", problem: "HYPER SBI 2 が起動していない")
                try? await stream?.stopCapture()
                stream = nil
                app = nil
                noAppReported = true
                retryAt = now.addingTimeInterval(5)
            }
            if stream != nil, let err = queue.sync(execute: { () -> String? in defer { streamError = nil }; return streamError }) {
                issue("stream_error", "録画が止まった: \(err)（5 秒後に録り直す）", problem: "録画が止まった（録り直し待ち）")
                try? await stream?.stopCapture()
                stream = nil
                retryAt = now.addingTimeInterval(5)
            }
            if stream == nil, now >= retryAt {
                if let a = NSRunningApplication.runningApplications(withBundleIdentifier: WindowCapturer.targetBundleID).first(where: { !$0.isTerminated }) {
                    do {
                        stream = try await startStream(pid: a.processIdentifier)
                        app = a
                        noAppReported = false
                        setProblem(nil)
                        Self.logger.info("録画ストリーム開始 pid \(a.processIdentifier, privacy: .public)")
                    } catch {
                        issue("stream_error", "録画を開始できない: \(error.localizedDescription)（15 秒後に録り直す）", problem: "録画を開始できない（録り直し待ち）")
                        retryAt = now.addingTimeInterval(15)
                    }
                } else {
                    if !noAppReported {
                        issue("no_app", "HYPER SBI 2 が起動していない（起動するまで 5 秒おきに探す）", problem: "HYPER SBI 2 が起動していない")
                        noAppReported = true
                    }
                    retryAt = now.addingTimeInterval(5)
                }
            }
            if let app, stream != nil { sampleWindows(pid: app.processIdentifier, locked: locked, now: now) }
            checkStalls(now: now)
            if now.timeIntervalSince(lastMetaWrite) >= 5 {
                writeMeta()
                lastMetaWrite = now
            }
            report()
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
        try? await stream?.stopCapture()
        await finish()
    }

    private func startStream(pid: pid_t) async throws -> SCStream {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let scApp = content.applications.first(where: { $0.processID == pid }) else { throw CaptureError.noWindow }
        let appWindows = content.windows.filter { $0.owningApplication?.processID == pid && $0.windowLayer == 0 }
        let wanted = queue.sync { meta.displayID }
        // 録画の途中で画面を変えない（座標がずれる）。初回は HYPER SBI 2 のウィンドウが最も多く載っている画面
        let display = content.displays.first(where: { $0.displayID == wanted })
            ?? content.displays.max(by: { Self.overlap(appWindows, $0.frame) < Self.overlap(appWindows, $1.frame) })
        guard let display else { throw CaptureError.noWindow }
        let filter = SCContentFilter(display: display, including: [scApp], exceptingWindows: [])
        // 実ピクセル（発注時の撮影 ShotTaker と同じ pointPixelScale 倍）。1x では全板の現在値（色付きの数字）が OCR で読めなかった。
        // 2 本目以降は 1 本目の大きさに合わせる（同じ mp4 に書き続けるため）
        let scale = Double(filter.pointPixelScale)
        let size = queue.sync { writer.map { (w: $0.width, h: $0.height) } }
            ?? (w: Int((Double(display.width) * scale).rounded()), h: Int((Double(display.height) * scale).rounded()))

        let config = SCStreamConfiguration()
        config.width = size.w
        config.height = size.h
        config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        config.showsCursor = false
        config.queueDepth = 6
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        try await stream.startCapture()
        queue.sync {
            displayFrame = display.frame
            meta.displayID = display.displayID
            meta.display = RecRect(x: Int(display.frame.minX), y: Int(display.frame.minY),
                                   w: Int(display.frame.width), h: Int(display.frame.height))
            lastFrameAt = lastFrameAt ?? Date()
        }
        return stream
    }

    private static func overlap(_ windows: [SCWindow], _ display: CGRect) -> CGFloat {
        windows.reduce(0) { sum, w in
            let r = w.frame.intersection(display)
            return r.isNull ? sum : sum + r.width * r.height
        }
    }

    // MARK: フレーム（queue 上）

    public func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sb.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
              let pb = sb.imageBuffer else { return }
        let pts = sb.presentationTimeStamp
        let now = Date()
        if writer == nil {
            do {
                let w = try RecordingWriter(url: mp4URL, width: CVPixelBufferGetWidth(pb), height: CVPixelBufferGetHeight(pb), fps: fps)
                writer = w
                // pts はホストの時計。届くまでの遅れを引いて、最初のフレームの実時刻にする
                let age = max(CMTimeGetSeconds(CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), pts)), 0)
                let started = now.addingTimeInterval(-age)
                meta.startedAt = Date(timeIntervalSince1970: (started.timeIntervalSince1970 * 1000).rounded(.down) / 1000)
                meta.width = w.width
                meta.height = w.height
                meta.codec = w.codec
                Self.logger.info("最初のフレーム \(w.width, privacy: .public)x\(w.height, privacy: .public) \(w.codec, privacy: .public)")
            } catch {
                reportWriteError("動画ファイルを作れない: \(error.localizedDescription)")
                return
            }
        }
        guard let writer else { return }
        if !writer.append(pb, at: pts) {
            reportWriteError("動画を書けない: \(writer.error?.localizedDescription ?? "不明")")
        }
        meta.frames = writer.frames
        lastFrameAt = now
        if noFramesReported {
            noFramesReported = false
            addIssueLocked("frames_back", "フレームが届き始めた", now: now)
            problem = nil
        }
        if now.timeIntervalSince(lastBlackCheck) >= 1 {
            lastBlackCheck = now
            if BlackFrame.isMostlyBlack(pb) {
                if blackSince == nil { blackSince = now }
            } else {
                blackSince = nil
                if blackReported {
                    blackReported = false
                    addIssueLocked("black_end", "黒い画面から戻った", now: now)
                    problem = nil
                }
            }
        }
    }

    public func stream(_ stream: SCStream, didStopWithError error: Error) {
        let message = error.localizedDescription
        Self.logger.error("録画ストリームが止まった: \(message, privacy: .public)")
        queue.async { self.streamError = message }
    }

    private func reportWriteError(_ message: String) {
        guard !writeErrorReported else { return }
        writeErrorReported = true
        Self.logger.error("\(message, privacy: .public)")
        addIssueLocked("write_error", message, now: Date())
        problem = "動画を書けない"
    }

    // MARK: 監視（ループから）

    /// 黒い画面が 5 秒続いた・フレームが 60 秒来ない、を記録する（画面に変化が無いとフレームは来ないので、どちらも粗い判定）
    private func checkStalls(now: Date) {
        queue.sync {
            if let since = blackSince, !blackReported, now.timeIntervalSince(since) >= 5 {
                blackReported = true
                Self.logger.error("黒い画面が続いている \(self.id, privacy: .public)")
                addIssueLocked("black", "黒い画面が続いている（ロック中・ディスプレイのスリープの可能性）", now: now)
                problem = "黒い画面"
            }
            if let last = lastFrameAt, !noFramesReported, now.timeIntervalSince(last) >= 60 {
                noFramesReported = true
                Self.logger.error("60 秒以上フレームが来ない \(self.id, privacy: .public)")
                addIssueLocked("no_frames", "60 秒以上フレームが来ない（画面が止まっている・ロック中・スリープの可能性）", now: now)
                problem = "フレームが来ない"
            }
        }
    }

    /// 約 1 秒ごとの HYPER SBI 2 のウィンドウ（タイトルと動画のピクセル座標）。最初のフレームの前は書かない
    private func sampleWindows(pid: pid_t, locked: Bool?, now: Date) {
        let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
        queue.sync {
            guard let started = meta.startedAt, let display = displayFrame, meta.width > 0 else { return }
            var windows: [RecWindow] = []
            for info in list {
                guard (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
                      (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                      let b = info[kCGWindowBounds as String] as? NSDictionary,
                      let bounds = CGRect(dictionaryRepresentation: b as CFDictionary),
                      bounds.width > 80, bounds.height > 40,
                      let frame = ReplayCrop.videoFrame(window: bounds, display: display, videoWidth: meta.width, videoHeight: meta.height)
                else { continue }
                windows.append(RecWindow(title: info[kCGWindowName as String] as? String ?? "", frame: frame))
            }
            meta.samples.append(RecSample(tMs: ReplayClock.videoMs(ts: now, startedAt: started), locked: locked, windows: windows))
        }
    }

    /// 画面ロック中か（取れなければ nil）。キーはロック中だけ現れる
    static func isScreenLocked() -> Bool? {
        guard let d = CGSessionCopyCurrentDictionary() as? [String: Any] else { return nil }
        return (d["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue ?? false
    }

    // MARK: 記録

    private func issue(_ kind: String, _ message: String, problem: String? = nil) {
        Self.logger.error("録画 \(self.id, privacy: .public) [\(kind, privacy: .public)] \(message, privacy: .public)")
        queue.sync {
            addIssueLocked(kind, message, now: Date())
            if let problem { self.problem = problem }
        }
    }

    private func setProblem(_ p: String?) { queue.sync { problem = p } }

    /// queue 上で呼ぶ。直前と同じ内容は重ねない（録り直しの失敗が続いた時に同じ行で埋めない）
    private func addIssueLocked(_ kind: String, _ message: String, now: Date) {
        if let last = meta.issues.last, last.kind == kind, last.message == message { return }
        let t = meta.startedAt.map { ReplayClock.videoMs(ts: now, startedAt: $0) }
        meta.issues.append(RecIssue(at: JST.nowMillis(), tMs: t, kind: kind, message: message))
    }

    private func writeMeta() {
        let m = queue.sync { meta }
        do {
            try m.write(to: jsonURL)
        } catch {
            Self.logger.error("録画のメタを書けない: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func report() {
        let p = queue.sync {
            Progress(id: id, startedAt: meta.startedAt, deadline: deadline, frames: meta.frames, problem: problem, issueCount: meta.issues.count)
        }
        onProgress?(p)
    }

    private func finish() async {
        let w = queue.sync { writer }
        let ok = await w?.finish(at: CMClockGetTime(CMClockGetHostTimeClock())) ?? false
        queue.sync {
            meta.endedAt = JST.nowMillis()
            if let w { meta.frames = w.frames }
            meta.status = Self.finalStatus(hasWriter: w != nil, closed: ok, stopRequested: stopRequested)
            if w == nil {
                Self.logger.error("1 フレームも録れなかった \(self.id, privacy: .public)")
                if meta.issues.isEmpty { addIssueLocked("no_frames", "1 フレームも録れなかった", now: Date()) }
                problem = problem ?? "1 フレームも録れなかった"
            } else if !ok {
                reportWriteError("動画を閉じられない: \(w?.error?.localizedDescription ?? "不明")")
            }
        }
        writeMeta()
        report()
        let m = queue.sync { meta }
        Self.logger.info("録画終了 \(self.id, privacy: .public) \(m.status.rawValue, privacy: .public) フレーム \(m.frames, privacy: .public) 問題 \(m.issues.count, privacy: .public) 件")
    }

    /// 終わった録画の結果（状態表示用）
    public var finalMeta: RecordingMeta { queue.sync { meta } }

    /// 録画の最終状態。動画を閉じられなかった（mp4 が再生できない）時は止めた・満了に関係なく failed
    static func finalStatus(hasWriter: Bool, closed: Bool, stopRequested: Bool) -> RecStatus {
        guard hasWriter, closed else { return .failed }
        return stopRequested ? .stopped : .done
    }
}

import AVFoundation
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation

// 録画リプレイ練習の録画側（形式は docs/paper-events.md「リプレイ」）。
// ここは画面収録を使わない部品だけ（メタ・時刻の換算・切り出しの選択・動画の書き出し・黒画面の判定）で、ユニットテストで確かめる。

// MARK: メタ

public struct RecRect: Codable, Equatable, Sendable {
    public var x: Int, y: Int, w: Int, h: Int
    public init(x: Int, y: Int, w: Int, h: Int) {
        self.x = x
        self.y = y
        self.w = w
        self.h = h
    }
}

public struct RecWindow: Codable, Equatable, Sendable {
    public var title: String
    /// 動画のピクセル座標（左上原点）
    public var frame: RecRect
    public init(title: String, frame: RecRect) {
        self.title = title
        self.frame = frame
    }
}

public struct RecSample: Codable, Equatable, Sendable {
    public var tMs: Int
    public var locked: Bool?
    public var windows: [RecWindow]
    public init(tMs: Int, locked: Bool? = nil, windows: [RecWindow]) {
        self.tMs = tMs
        self.locked = locked
        self.windows = windows
    }

    enum CodingKeys: String, CodingKey {
        case tMs = "t_ms"
        case locked, windows
    }
}

public struct RecIssue: Codable, Equatable, Sendable {
    public var at: Date
    public var tMs: Int?
    public var kind: String
    public var message: String
    public init(at: Date, tMs: Int?, kind: String, message: String) {
        self.at = at
        self.tMs = tMs
        self.kind = kind
        self.message = message
    }

    enum CodingKeys: String, CodingKey {
        case at
        case tMs = "t_ms"
        case kind, message
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(JST.format(at), forKey: .at)
        try c.encode(tMs, forKey: .tMs)
        try c.encode(kind, forKey: .kind)
        try c.encode(message, forKey: .message)
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let text = try c.decode(String.self, forKey: .at)
        guard let at = JST.parse(text) else {
            throw DecodingError.dataCorruptedError(forKey: .at, in: c, debugDescription: "at が読めない: \(text)")
        }
        self.at = at
        tMs = try c.decodeIfPresent(Int.self, forKey: .tMs)
        kind = try c.decode(String.self, forKey: .kind)
        message = try c.decode(String.self, forKey: .message)
    }
}

public enum RecStatus: String, Codable, Sendable {
    case recording, done, stopped, failed
}

/// <rec_id>.json。録画中も数秒ごとに一時ファイルから置き換える
public struct RecordingMeta: Codable, Equatable, Sendable {
    public var v = 1
    public var id: String
    public var startedAt: Date?
    public var endedAt: Date?
    public var status: RecStatus
    public var fps: Int
    public var width: Int
    public var height: Int
    public var codec: String?
    public var display: RecRect?
    public var displayID: UInt32?
    public var frames: Int
    public var plannedMinutes: Int?
    public var samples: [RecSample]
    public var issues: [RecIssue]

    public init(id: String, status: RecStatus = .recording, fps: Int = 10, width: Int = 0, height: Int = 0,
                plannedMinutes: Int? = nil, startedAt: Date? = nil) {
        self.id = id
        self.status = status
        self.fps = fps
        self.width = width
        self.height = height
        self.plannedMinutes = plannedMinutes
        self.startedAt = startedAt
        self.frames = 0
        self.samples = []
        self.issues = []
    }

    enum CodingKeys: String, CodingKey {
        case v, id, status, fps, width, height, codec, display, frames, samples, issues
        case startedAt = "started_at"
        case endedAt = "ended_at"
        case plannedMinutes = "planned_minutes"
    }

    /// display は {id,x,y,w,h} の 1 つのオブジェクト
    private struct Display: Codable {
        var id: UInt32?
        var x: Int, y: Int, w: Int, h: Int
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(v, forKey: .v)
        try c.encode(id, forKey: .id)
        try c.encode(startedAt.map(JST.format), forKey: .startedAt)
        try c.encode(endedAt.map(JST.format), forKey: .endedAt)
        try c.encode(status, forKey: .status)
        try c.encode(fps, forKey: .fps)
        try c.encode(width, forKey: .width)
        try c.encode(height, forKey: .height)
        try c.encode(codec, forKey: .codec)
        try c.encode(display.map { Display(id: displayID, x: $0.x, y: $0.y, w: $0.w, h: $0.h) }, forKey: .display)
        try c.encode(frames, forKey: .frames)
        try c.encode(plannedMinutes, forKey: .plannedMinutes)
        try c.encode(samples, forKey: .samples)
        try c.encode(issues, forKey: .issues)
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        v = try c.decodeIfPresent(Int.self, forKey: .v) ?? 1
        id = try c.decode(String.self, forKey: .id)
        startedAt = try c.decodeIfPresent(String.self, forKey: .startedAt).flatMap(JST.parse)
        endedAt = try c.decodeIfPresent(String.self, forKey: .endedAt).flatMap(JST.parse)
        status = try c.decodeIfPresent(RecStatus.self, forKey: .status) ?? .recording
        fps = try c.decodeIfPresent(Int.self, forKey: .fps) ?? 10
        width = try c.decodeIfPresent(Int.self, forKey: .width) ?? 0
        height = try c.decodeIfPresent(Int.self, forKey: .height) ?? 0
        codec = try c.decodeIfPresent(String.self, forKey: .codec)
        if let d = try c.decodeIfPresent(Display.self, forKey: .display) {
            display = RecRect(x: d.x, y: d.y, w: d.w, h: d.h)
            displayID = d.id
        }
        frames = try c.decodeIfPresent(Int.self, forKey: .frames) ?? 0
        plannedMinutes = try c.decodeIfPresent(Int.self, forKey: .plannedMinutes)
        samples = try c.decodeIfPresent([RecSample].self, forKey: .samples) ?? []
        issues = try c.decodeIfPresent([RecIssue].self, forKey: .issues) ?? []
    }

    public func data() throws -> Data {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try enc.encode(self)
    }

    /// 書きかけを読ませないよう、一時ファイルに書いてから置き換える
    public func write(to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data().write(to: url, options: .atomic)
    }

    public static func load(_ url: URL) -> RecordingMeta? {
        guard let d = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(RecordingMeta.self, from: d)
    }

    /// 再生位置の時点のウィンドウ情報（その位置以前で最後のサンプル。先頭より前なら最初のサンプル）
    public func sample(at videoMs: Int) -> RecSample? {
        samples.last(where: { $0.tMs <= videoMs }) ?? samples.first
    }

    /// 録画の長さ（秒）。終わっていれば ended_at − started_at
    public var durationSeconds: Int? {
        guard let s = startedAt, let e = endedAt else { return nil }
        return max(Int(e.timeIntervalSince(s)), 0)
    }
}

// MARK: ID・置き場所

public enum RecordingPaths {
    /// data/paper/replay
    public static func replayFolder(_ dataFolder: URL) -> URL { dataFolder.appendingPathComponent("replay", isDirectory: true) }
    public static func recordingsFolder(_ dataFolder: URL) -> URL {
        replayFolder(dataFolder).appendingPathComponent("recordings", isDirectory: true)
    }

    private static let idFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = JST.timeZone
        f.dateFormat = "yyyyMMdd-HHmmss"
        return f
    }()

    /// 録画を始めた時刻の JST `YYYYMMDD-HHMMSS`。同じ秒に既にあれば -2, -3 … を付ける
    public static func newID(at date: Date, exists: (String) -> Bool) -> String {
        let base = idFormatter.string(from: date)
        if !exists(base) { return base }
        var n = 2
        while exists("\(base)-\(n)") { n += 1 }
        return "\(base)-\(n)"
    }

    /// (mp4, json) の URL。日付ディレクトリは開始時刻の JST
    public static func files(dataFolder: URL, id: String, day: String) -> (mp4: URL, json: URL) {
        let dir = recordingsFolder(dataFolder).appendingPathComponent(day, isDirectory: true)
        return (dir.appendingPathComponent("\(id).mp4"), dir.appendingPathComponent("\(id).json"))
    }
}

// MARK: 時刻の換算

/// 再生位置（ミリ秒）と録画上の実時刻の換算。ts = started_at + video_ms（ミリ秒の整数で足し、浮動小数の誤差で .999 にしない）
public enum ReplayClock {
    public static func ts(startedAt: Date, videoMs: Int) -> Date {
        let base = (startedAt.timeIntervalSince1970 * 1000).rounded()
        return Date(timeIntervalSince1970: (base + Double(videoMs)) / 1000)
    }

    public static func videoMs(ts: Date, startedAt: Date) -> Int {
        Int(((ts.timeIntervalSince1970 - startedAt.timeIntervalSince1970) * 1000).rounded())
    }

    /// 再生位置（CMTime）→ ミリ秒（切り捨て。押した位置より後のフレームを取らないように）
    public static func videoMs(_ time: CMTime) -> Int {
        guard time.isValid, time.isNumeric else { return 0 }
        return max(Int((CMTimeGetSeconds(time) * 1000).rounded(.down)), 0)
    }

    public static func cmTime(videoMs: Int) -> CMTime { CMTime(value: CMTimeValue(videoMs), timescale: 1000) }
}

// MARK: 全板ウィンドウの切り出し

public enum ReplayCrop {
    public struct Choice: Equatable, Sendable {
        /// 切り出すウィンドウ（nil ならフレーム全体）
        public var window: RecWindow?
        /// 発注銘柄の板と確かめられない（別の銘柄の値を拾いうる）ので、自動読み取りの現在値を使わない
        public var ambiguous: Bool
    }

    public static func isBoard(_ title: String) -> Bool { title.hasPrefix("全板") }

    /// 発注銘柄のコードをタイトルに含む全板 → 無ければ全板が 1 つだけならそれ → それも無ければフレーム全体。
    /// 現在値を使ってよい（ambiguous でない）のは、タイトルのコードが発注銘柄と一致した時だけ。
    /// 一致を確かめられない切り出し（コード無しの全板・全板が無いフレーム全体）は、OCR が別銘柄や
    /// 一番上の数字を拾っても気づけないので ambiguous にする
    public static func choose(windows: [RecWindow], symbol: String?) -> Choice {
        let boards = windows.filter { isBoard($0.title) }
        let code = symbol?.trimmingCharacters(in: .whitespaces).uppercased() ?? ""
        if !code.isEmpty, let w = boards.first(where: { BoardReader.symbol(fromTitle: $0.title) == code }) {
            return Choice(window: w, ambiguous: false)
        }
        return Choice(window: boards.count == 1 ? boards[0] : nil, ambiguous: true)
    }

    /// 動画のピクセル座標の frame を、実際の画像の大きさに合わせて画像内に収めた矩形にする
    public static func pixelRect(_ frame: RecRect, videoWidth: Int, videoHeight: Int, imageWidth: Int, imageHeight: Int) -> CGRect? {
        let sx = videoWidth > 0 ? Double(imageWidth) / Double(videoWidth) : 1
        let sy = videoHeight > 0 ? Double(imageHeight) / Double(videoHeight) : 1
        let r = CGRect(x: Double(frame.x) * sx, y: Double(frame.y) * sy, width: Double(frame.w) * sx, height: Double(frame.h) * sy)
            .integral.intersection(CGRect(x: 0, y: 0, width: imageWidth, height: imageHeight))
        return r.isNull || r.width < 8 || r.height < 8 ? nil : r
    }

    /// グローバル座標（左上原点・ポイント）のウィンドウ枠 → 録った画面に対する動画のピクセル座標
    public static func videoFrame(window: CGRect, display: CGRect, videoWidth: Int, videoHeight: Int) -> RecRect? {
        let r = window.intersection(display)
        guard !r.isNull, r.width >= 1, r.height >= 1, display.width > 0, display.height > 0 else { return nil }
        let sx = Double(videoWidth) / display.width, sy = Double(videoHeight) / display.height
        return RecRect(x: Int(((r.minX - display.minX) * sx).rounded()), y: Int(((r.minY - display.minY) * sy).rounded()),
                       w: Int((r.width * sx).rounded()), h: Int((r.height * sy).rounded()))
    }
}

// MARK: 起動の指示

/// 録画の指示（起動引数 `--record-minutes N`、または起動中のインスタンスへの `tradepanel://record?minutes=N`）
public enum RecordCommand {
    public static let scheme = "tradepanel"
    static let maxMinutes = 360

    public static func minutes(fromArguments args: [String]) -> Int? {
        guard let i = args.firstIndex(of: "--record-minutes"), i + 1 < args.count else { return nil }
        return valid(Int(args[i + 1]))
    }

    /// `tradepanel://record?minutes=37`
    public static func minutes(fromURL url: URL) -> Int? {
        guard url.scheme?.lowercased() == scheme, url.host?.lowercased() == "record",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        return valid(items.first(where: { $0.name == "minutes" })?.value.flatMap { Int($0) })
    }

    private static func valid(_ n: Int?) -> Int? {
        guard let n, n >= 1, n <= maxMinutes else { return nil }
        return n
    }
}

// MARK: 動画の書き出し

/// 画面のフレームを mp4 に書く（HEVC。使えなければ H.264）。最初のフレームが 0 秒。
/// 画面に変化が無い間はフレームが来ない（可変フレームレート）ので、終わる時に最後のフレームを終了時刻にもう 1 枚置いて長さを合わせる。
/// スレッド安全ではない（呼ぶ側が 1 つのキューから呼ぶ）
public final class RecordingWriter {
    public let url: URL
    public let width: Int
    public let height: Int
    public private(set) var codec: String
    public private(set) var frames = 0
    public private(set) var failed = false
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private let adaptor: AVAssetWriterInputPixelBufferAdaptor
    private var firstPTS: CMTime?
    private var lastPTS: CMTime?
    private var lastBuffer: CVPixelBuffer?

    public init(url: URL, width: Int, height: Int, fps: Int = 10) throws {
        self.url = url
        self.width = width
        self.height = height
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: url)
        writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        // 途中で落ちても（スリープ・強制終了）それまでの分が再生できるよう、10 秒ごとに断片を書き出す
        writer.movieFragmentInterval = CMTime(seconds: 10, preferredTimescale: 600)
        func settings(_ codec: AVVideoCodecType) -> [String: Any] {
            [
                AVVideoCodecKey: codec,
                AVVideoWidthKey: width,
                AVVideoHeightKey: height,
                AVVideoCompressionPropertiesKey: [
                    AVVideoAverageBitRateKey: Self.bitRate(width: width, height: height, fps: fps),
                    AVVideoExpectedSourceFrameRateKey: fps,
                    // シーク（許容誤差 0 のフレーム取り出し）が遅くならないよう、キーフレームは 2 秒ごと
                    AVVideoMaxKeyFrameIntervalKey: fps * 2,
                    AVVideoAllowFrameReorderingKey: false,
                ] as [String: Any],
            ]
        }
        var chosen = settings(.hevc)
        codec = "hevc"
        if !writer.canApply(outputSettings: chosen, forMediaType: .video) {
            chosen = settings(.h264)
            codec = "h264"
        }
        input = AVAssetWriterInput(mediaType: .video, outputSettings: chosen)
        input.expectsMediaDataInRealTime = true
        adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        guard writer.canAdd(input) else { throw writer.error ?? CocoaError(.fileWriteUnknown) }
        writer.add(input)
    }

    public var error: Error? { writer.error }

    /// 1 画素・1 フレームあたりのビット数。合成した全板（毎フレーム数字が全部変わる 3074x2714）では 0.02 でも現在値が読めたので、3 倍の余裕を取る
    public static let bitsPerPixel = 0.06

    /// 平均ビットレート（上限の目安）。5120x2880・10fps で約 8.8 Mbps（1 分あたり最大 約 66 MB）
    public static func bitRate(width: Int, height: Int, fps: Int) -> Int {
        Int(Double(width * height * fps) * bitsPerPixel)
    }

    /// pts は任意の時計（ScreenCaptureKit ならホストの時計）。最初のフレームを 0 秒として書く。
    /// 書けなかった（エンコーダが追いつかない等）フレームは落とすだけ。書き出しが壊れたら false
    @discardableResult
    public func append(_ buffer: CVPixelBuffer, at pts: CMTime) -> Bool {
        guard !failed else { return false }
        if firstPTS == nil {
            guard writer.startWriting() else {
                failed = true
                return false
            }
            writer.startSession(atSourceTime: .zero)
            firstPTS = pts
        }
        let t = CMTimeSubtract(pts, firstPTS!)
        if let last = lastPTS, CMTimeCompare(t, last) <= 0 { return true }
        lastBuffer = buffer
        guard input.isReadyForMoreMediaData else { return writer.status != .failed }
        guard adaptor.append(buffer, withPresentationTime: t) else {
            failed = writer.status == .failed
            return !failed
        }
        lastPTS = t
        frames += 1
        return true
    }

    /// endPTS（append と同じ時計）まで最後のフレームを伸ばして閉じる。1 枚も書いていなければファイルを消して false
    public func finish(at endPTS: CMTime?) async -> Bool {
        guard let first = firstPTS, frames > 0 else {
            if writer.status == .writing { writer.cancelWriting() }
            try? FileManager.default.removeItem(at: url)
            return false
        }
        if let endPTS, let lastBuffer, let last = lastPTS, !failed {
            let t = CMTimeSubtract(endPTS, first)
            if CMTimeCompare(t, last) > 0 {
                // エンコーダが空くのを少し待つ（実時間の入力なので通常はすぐ空く）
                for _ in 0..<50 where !input.isReadyForMoreMediaData { try? await Task.sleep(nanoseconds: 10_000_000) }
                if input.isReadyForMoreMediaData, adaptor.append(lastBuffer, withPresentationTime: t) {
                    lastPTS = t
                }
            }
        }
        input.markAsFinished()
        if let lastPTS { writer.endSession(atSourceTime: lastPTS) }
        await writer.finishWriting()
        return writer.status == .completed
    }
}

// MARK: 黒画面の判定（粗い）

public enum BlackFrame {
    /// 縦横 32 点ずつ間引いて見て、明るい点が 1% 未満なら黒（ロック中・ディスプレイのスリープの疑い）
    public static func isMostlyBlack(_ pb: CVPixelBuffer) -> Bool {
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        let format = CVPixelBufferGetPixelFormatType(pb)
        let planar = CVPixelBufferIsPlanar(pb)
        let base = planar ? CVPixelBufferGetBaseAddressOfPlane(pb, 0) : CVPixelBufferGetBaseAddress(pb)
        guard let base else { return false }
        let w = planar ? CVPixelBufferGetWidthOfPlane(pb, 0) : CVPixelBufferGetWidth(pb)
        let h = planar ? CVPixelBufferGetHeightOfPlane(pb, 0) : CVPixelBufferGetHeight(pb)
        let row = planar ? CVPixelBufferGetBytesPerRowOfPlane(pb, 0) : CVPixelBufferGetBytesPerRow(pb)
        let p = base.assumingMemoryBound(to: UInt8.self)
        let bgra = format == kCVPixelFormatType_32BGRA
        guard bgra || planar else { return false }
        var bright = 0, total = 0
        let stepX = max(w / 32, 1), stepY = max(h / 32, 1)
        for y in stride(from: 0, to: h, by: stepY) {
            for x in stride(from: 0, to: w, by: stepX) {
                let v: Int
                if bgra {
                    let o = y * row + x * 4
                    v = max(Int(p[o]), Int(p[o + 1]), Int(p[o + 2]))
                } else {
                    v = Int(p[y * row + x])  // 輝度（ビデオレンジでは黒が 16）
                }
                if v > 40 { bright += 1 }
                total += 1
            }
        }
        return total > 0 && bright * 100 < total
    }
}

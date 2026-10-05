import AVFoundation
import Foundation
import os

/// 保存済みの録画 1 本（mp4 とメタの組）
public struct RecordingEntry: Identifiable, Equatable, Sendable {
    public var id: String
    public var day: String
    public var mp4: URL
    public var json: URL
    public var meta: RecordingMeta?
    /// mp4 とメタの合計バイト数
    public var bytes: Int64
    public var hasVideo: Bool
    /// mp4 に再生できる映像トラックがあるか（nil はまだ確かめていない）。RecordingController が一覧を読んだ後に埋める
    public var playable: Bool?

    /// 練習に使える録画: 動画があり、録画が失敗扱いでなく、確かめた結果再生できないと分かっていない
    public var canReplay: Bool {
        hasVideo && meta?.startedAt != nil && (meta?.width ?? 0) > 0 && meta?.status != .failed && playable != false
    }

    /// 再生できる映像トラックを持つ mp4 か（壊れた・閉じられなかった mp4 を練習に出さない）
    public static func hasPlayableVideo(_ url: URL) async -> Bool {
        let asset = AVURLAsset(url: url)
        guard let playable = try? await asset.load(.isPlayable), playable,
              let tracks = try? await asset.loadTracks(withMediaType: .video) else { return false }
        return !tracks.isEmpty
    }

    /// data/paper/replay/recordings/YYYY-MM-DD/<id>.{mp4,json} を新しい順に並べる
    public static func scan(dataFolder: URL) -> [RecordingEntry] {
        let fm = FileManager.default
        let root = RecordingPaths.recordingsFolder(dataFolder)
        guard let days = try? fm.contentsOfDirectory(atPath: root.path) else { return [] }
        var out: [RecordingEntry] = []
        for day in days {
            let dir = root.appendingPathComponent(day, isDirectory: true)
            guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { continue }
            let ids = Set(names.compactMap { n -> String? in
                n.hasSuffix(".mp4") ? String(n.dropLast(4)) : n.hasSuffix(".json") ? String(n.dropLast(5)) : nil
            })
            for id in ids {
                let mp4 = dir.appendingPathComponent("\(id).mp4"), json = dir.appendingPathComponent("\(id).json")
                func size(_ u: URL) -> Int64 { ((try? fm.attributesOfItem(atPath: u.path))?[.size] as? NSNumber)?.int64Value ?? 0 }
                out.append(RecordingEntry(id: id, day: day, mp4: mp4, json: json, meta: RecordingMeta.load(json),
                                          bytes: size(mp4) + size(json), hasVideo: fm.fileExists(atPath: mp4.path)))
            }
        }
        return out.sorted { $0.id > $1.id }
    }
}

/// 録画の開始・停止・状態表示と、保存済みの録画の一覧（自動では消さない。消す時はゴミ箱へ移すだけ）
@MainActor
public final class RecordingController: ObservableObject {
    /// 小窓に出す 1 行（例「録画中 08:57 / 残り 33 分」）。録画していなくても、直前の録画の結果は残す
    @Published public internal(set) var statusLine: String?
    @Published public internal(set) var isRecording = false
    @Published public internal(set) var entries: [RecordingEntry] = []
    @Published public private(set) var message: String?
    /// 録画中の id（一覧で「練習する」を押せなくする）
    @Published public private(set) var activeID: String?
    /// データフォルダのある場所の空き容量（分からなければ nil）
    @Published public private(set) var freeBytes: Int64?

    /// これより空きが少なければ録画を始めない（37 分で約 540 MB。書いている途中でディスクが尽きるのを避ける）
    public static let minFreeBytes: Int64 = 5_000_000_000
    /// 空き容量の取り方（テストで差し替える）
    var freeSpace: (URL) -> Int64? = { url in
        (try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?.volumeAvailableCapacityForImportantUsage
    }
    /// 再生できるかを確かめた結果（mp4 のパスと大きさごと。一覧を読み直すたびに AVAsset を開き直さない）
    private var playableCache: [String: Bool] = [:]
    private var verifyTask: Task<Void, Never>?

    var dataFolder: () -> URL? = { nil }
    private var recorder: ScreenRecorder?
    private var progress: ScreenRecorder.Progress?
    private var ticker: Task<Void, Never>?
    private var runTask: Task<Void, Never>?
    static let logger = Logger(subsystem: "com.tomato.tradelog.panel", category: "record")

    public init() {}

    public var totalBytes: Int64 { entries.reduce(0) { $0 + $1.bytes } }

    /// 今から minutes 分録る。録画中なら締め切りを延ばすだけ
    public func start(minutes: Int) {
        let now = Date()
        if let r = recorder {
            r.extend(to: now.addingTimeInterval(TimeInterval(minutes * 60)))
            Self.logger.info("録画中に指示を受けたので締め切りを延ばす \(minutes, privacy: .public) 分")
            updateStatus()
            return
        }
        guard let folder = dataFolder() else {
            Self.logger.error("録画できない: データフォルダが未設定")
            statusLine = "録画できません: データフォルダが未設定です"
            return
        }
        if let free = freeSpace(folder), free < Self.minFreeBytes {
            let size = ByteCountFormatter.string(fromByteCount: free, countStyle: .file)
            Self.logger.error("録画しない: 空き容量 \(free, privacy: .public) バイト（\(Self.minFreeBytes, privacy: .public) 未満）")
            statusLine = "録画しません: 空き容量が \(size) しかありません（5 GB 以上必要。ゴミ箱を空にしてください）"
            return
        }
        let day = JST.day(now)
        let id = RecordingPaths.newID(at: now) { candidate in
            let f = RecordingPaths.files(dataFolder: folder, id: candidate, day: day)
            return FileManager.default.fileExists(atPath: f.json.path) || FileManager.default.fileExists(atPath: f.mp4.path)
        }
        let r = ScreenRecorder(dataFolder: folder, id: id, day: day, minutes: minutes, now: now)
        attachProgress(r)
        recorder = r
        progress = nil
        activeID = id
        isRecording = true
        updateStatus()
        ticker?.cancel()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                self?.updateStatus()
            }
        }
        runTask = Task { [weak self] in
            await r.run()
            self?.finished(r)
        }
    }

    /// 小窓を終了する時に呼ぶ。録画中なら止めて mp4 とメタを書き切るまで待つ（待たずに終わるとメタが「録画中」のまま残る）
    public func stopAndWait() async {
        guard recorder != nil, let t = runTask else { return }
        stop()
        await t.value
    }

    public func stop() {
        recorder?.stop()
        statusLine = "録画を止めています…"
    }

    /// 録画の進み具合を受け取る。r 自身を強く持つと r → onProgress → r の循環で録画が解放されないので弱参照にする
    func attachProgress(_ r: ScreenRecorder) {
        r.onProgress = { [weak self, weak r] p in
            Task { @MainActor in
                guard let self, let r, self.recorder === r else { return }
                self.progress = p
                self.updateStatus()
            }
        }
    }

    private func finished(_ r: ScreenRecorder) {
        r.onProgress = nil
        guard recorder === r else { return }
        recorder = nil
        ticker?.cancel()
        ticker = nil
        isRecording = false
        activeID = nil
        statusLine = Self.resultLine(r.finalMeta)
        reloadList()
    }

    static func resultLine(_ m: RecordingMeta) -> String {
        let end = m.endedAt.map { String(JST.clock($0).prefix(5)) } ?? "-"
        let problems = m.issues.filter { !["unlocked", "black_end", "frames_back"].contains($0.kind) }
        let note = problems.isEmpty ? "" : "・問題 \(problems.count) 件（\(problems.last!.message)）"
        switch m.status {
        case .failed: return "録画できませんでした \(end)\(note)"
        case .stopped: return "録画を止めました \(end)\(note)"
        default: return "録画終了 \(end)\(note)"
        }
    }

    func updateStatus(now: Date = Date()) {
        guard let r = recorder else { return }
        let remain = max(Int((r.currentDeadline.timeIntervalSince(now) / 60).rounded(.up)), 0)
        var line = "録画中 \(String(JST.clock(now).prefix(5))) / 残り \(remain) 分"
        if progress?.startedAt == nil { line = "録画準備中 \(String(JST.clock(now).prefix(5))) / 残り \(remain) 分" }
        if let p = progress?.problem { line += "・\(p)" }
        statusLine = line
    }

    // MARK: 一覧

    public func reloadList() {
        guard let folder = dataFolder() else {
            entries = []
            freeBytes = nil
            return
        }
        freeBytes = freeSpace(folder)
        var list = RecordingEntry.scan(dataFolder: folder)
        for i in list.indices { list[i].playable = playableCache[Self.cacheKey(list[i])] }
        entries = list
        // まだ確かめていない録画（録画中のものは除く）だけ、裏で再生できるかを確かめる
        let pending = list.filter { $0.hasVideo && $0.playable == nil && $0.id != activeID }
        guard !pending.isEmpty else { return }
        let previous = verifyTask
        verifyTask = Task { [weak self] in
            await previous?.value
            for e in pending {
                let ok = await RecordingEntry.hasPlayableVideo(e.mp4)
                guard let self else { return }
                self.playableCache[Self.cacheKey(e)] = ok
                if let i = self.entries.firstIndex(where: { $0.id == e.id && $0.bytes == e.bytes }) { self.entries[i].playable = ok }
            }
        }
    }

    /// 裏で走っている「再生できるか」の確認を待つ（テスト用）
    func waitForVerification() async { await verifyTask?.value }

    private static func cacheKey(_ e: RecordingEntry) -> String { "\(e.mp4.path)#\(e.bytes)" }

    /// mp4 とメタをゴミ箱へ移す（完全には消さない）。サンドボックスで移せなければ理由を出す
    public func trash(_ e: RecordingEntry) {
        guard e.id != activeID else {
            message = "録画中のものはゴミ箱へ移せません"
            return
        }
        do {
            for url in [e.mp4, e.json] where FileManager.default.fileExists(atPath: url.path) {
                try FileManager.default.trashItem(at: url, resultingItemURL: nil)
            }
            message = "\(e.id) をゴミ箱へ移しました"
        } catch {
            message = "ゴミ箱へ移せません（Finder で data/paper/replay/recordings から移してください）: \(error.localizedDescription)"
            Self.logger.error("ゴミ箱へ移せない \(e.id, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
        reloadList()
    }
}

import Foundation

/// data/paper/events.jsonl への追記と読み込み。既存行は書き換えない・消さない（追記専用）。
public final class EventLog {
    public let folder: URL
    public var fileURL: URL { folder.appendingPathComponent("events.jsonl") }

    public init(folder: URL) {
        self.folder = folder
    }

    public struct LoadResult {
        public var events: [PaperEvent]
        public var badLines: Int
    }

    public func load() throws -> LoadResult {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return LoadResult(events: [], badLines: 0) }
        let text = try String(contentsOf: fileURL, encoding: .utf8)
        var events: [PaperEvent] = []
        var bad = 0
        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
            if let e = try? EventCoding.decode(line: String(line)) {
                events.append(e)
            } else {
                bad += 1
            }
        }
        return LoadResult(events: events, badLines: bad)
    }

    public func append(_ event: PaperEvent) throws {
        let data = Data((try EventCoding.line(event) + "\n").utf8)
        let fm = FileManager.default
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        if !fm.fileExists(atPath: fileURL.path) {
            fm.createFile(atPath: fileURL.path, contents: nil)
        }
        let h = try FileHandle(forWritingTo: fileURL)
        defer { try? h.close() }
        try h.seekToEnd()
        try h.write(contentsOf: data)
        // 取引中に落ちても記録が残るよう、1 件ごとにディスクへ書き切る
        try h.synchronize()
    }

    /// スクショの置き場所（data/paper からの相対パスと絶対 URL）
    public func shotLocation(eventID: UUID, ts: Date) -> (relative: String, url: URL) {
        let rel = "shots/\(JST.day(ts))/\(eventID.uuidString.lowercased()).png"
        return (rel, folder.appendingPathComponent(rel))
    }
}

/// ユーザーが選んだデータフォルダを security-scoped bookmark で覚える（App Sandbox 下でのファイルアクセスはこれだけ）
public enum DataFolder {
    /// 既定の候補（サンドボックス内では home がコンテナを指すので、実際のホームを引く）
    public static var defaultCandidate: URL {
        let home: String
        if let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir {
            home = String(cString: dir)
        } else {
            home = NSHomeDirectory()
        }
        return URL(fileURLWithPath: home).appendingPathComponent("Project/tradelog/data/paper", isDirectory: true)
    }

    public static func makeBookmark(_ url: URL) throws -> Data {
        try url.bookmarkData(options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil)
    }

    /// bookmark を解いてアクセスを開始する。古くなっていたら作り直した bookmark も返す
    public static func resolve(_ bookmark: Data) -> (url: URL, refreshed: Data?)? {
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: bookmark, options: [.withSecurityScope],
                                 relativeTo: nil, bookmarkDataIsStale: &stale) else { return nil }
        guard url.startAccessingSecurityScopedResource() else { return nil }
        return (url, stale ? try? makeBookmark(url) : nil)
    }
}

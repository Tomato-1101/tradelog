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
        try append(contentsOf: [event])
    }

    /// 1 回の操作で書く行（ドテンの 2 行・先に書く取消・相方の約定など）を 1 つのバッファにまとめ、O_APPEND の 1 回の write で追記する。
    /// 行ごとに書くと、途中で落ちたり失敗したりした時に片側だけ残る（open だけ残れば両建て）ため。
    public func append(contentsOf events: [PaperEvent]) throws {
        guard !events.isEmpty else { return }
        // 先に全行をエンコードする（ここで失敗したら 1 行も書かない）
        let data = Data(try events.map { try EventCoding.line($0) + "\n" }.joined().utf8)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let fd = Darwin.open(fileURL.path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { Darwin.close(fd) }
        let before = lseek(fd, 0, SEEK_END)
        let written = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
        if written != data.count {
            let code = written < 0 ? (POSIXErrorCode(rawValue: errno) ?? .EIO) : .EIO
            // 一部だけ書けた（ディスクが一杯等）なら、書きかけの行を残さない
            if written > 0, before >= 0 { _ = ftruncate(fd, before) }
            throw POSIXError(code)
        }
        // 取引中に落ちても記録が残るよう、操作ごとにディスクへ書き切る
        guard fsync(fd) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    }

    /// スクショの置き場所（data/paper からの相対パスと絶対 URL）
    public func shotLocation(eventID: UUID, ts: Date) -> (relative: String, url: URL) {
        let rel = "shots/\(JST.day(ts))/\(eventID.uuidString.lowercased()).png"
        return (rel, folder.appendingPathComponent(rel))
    }

    /// 全画面 OCR のサイドカー（スクショと同じ場所に <event id>.ocr.json）
    public func ocrLocation(eventID: UUID, ts: Date) -> (relative: String, url: URL) {
        let rel = "shots/\(JST.day(ts))/\(eventID.uuidString.lowercased()).ocr.json"
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

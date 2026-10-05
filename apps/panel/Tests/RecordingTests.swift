import AVFoundation
import CoreGraphics
import CoreVideo
import ImageIO
import XCTest
@testable import PanelKit

/// 画面収録の代わりに、合成したフレームから録画（mp4 ＋メタ）を作る
enum SyntheticVideo {
    /// CGImage を BGRA のピクセルバッファにする（ScreenCaptureKit が渡すのと同じ IOSurface 付き）
    static func pixelBuffer(_ image: CGImage) -> CVPixelBuffer {
        var pb: CVPixelBuffer?
        let attrs: [String: Any] = [kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any]()]
        CVPixelBufferCreate(nil, image.width, image.height, kCVPixelFormatType_32BGRA, attrs as CFDictionary, &pb)
        let buffer = pb!
        CVPixelBufferLockBaseAddress(buffer, [])
        let ctx = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: image.width, height: image.height, bitsPerComponent: 8,
                            bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue)!
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        CVPixelBufferUnlockBaseAddress(buffer, [])
        return buffer
    }

    static func solid(width: Int, height: Int, r: CGFloat, g: CGFloat, b: CGFloat) -> CGImage {
        let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.setFillColor(CGColor(red: r, green: g, blue: b, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        return ctx.makeImage()!
    }

    /// frames の (再生位置ミリ秒, 画像) を順に書き、endMs まで最後のフレームを伸ばす。書けたフレーム数を返す
    @discardableResult
    static func write(url: URL, width: Int, height: Int, frames: [(ms: Int, image: CGImage)], endMs: Int) async throws -> RecordingWriter {
        let writer = try RecordingWriter(url: url, width: width, height: height, fps: 10)
        // ホストの時計のような大きな値から始めても、最初のフレームが 0 秒になる
        let origin = CMTime(value: 123_456_789, timescale: 1000)
        for f in frames {
            let pb = pixelBuffer(f.image)
            // 実時間の入力なので、エンコーダが空くまで少し待ってから渡す
            try await Task.sleep(nanoseconds: 30_000_000)
            XCTAssertTrue(writer.append(pb, at: CMTimeAdd(origin, CMTime(value: CMTimeValue(f.ms), timescale: 1000))))
        }
        let ok = await writer.finish(at: CMTimeAdd(origin, CMTime(value: CMTimeValue(endMs), timescale: 1000)))
        XCTAssertTrue(ok, "書き出しが完了する: \(String(describing: writer.error))")
        return writer
    }

    /// 取り出したフレームの中央付近の平均色（0〜255）
    static func averageColor(_ image: CGImage, in rect: CGRect? = nil) -> (r: Int, g: Int, b: Int) {
        let r = rect ?? CGRect(x: image.width / 4, y: image.height / 4, width: image.width / 2, height: image.height / 2)
        let crop = image.cropping(to: r)!
        let w = crop.width, h = crop.height
        var data = [UInt8](repeating: 0, count: w * h * 4)
        let ctx = CGContext(data: &data, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(crop, in: CGRect(x: 0, y: 0, width: w, height: h))
        var sr = 0, sg = 0, sb = 0
        for i in 0..<(w * h) {
            sr += Int(data[i * 4])
            sg += Int(data[i * 4 + 1])
            sb += Int(data[i * 4 + 2])
        }
        let n = max(w * h, 1)
        return (sr / n, sg / n, sb / n)
    }

    static func frame(_ url: URL, ms: Int) async throws -> CGImage {
        let gen = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        gen.requestedTimeToleranceBefore = .zero
        gen.requestedTimeToleranceAfter = .zero
        return try await gen.image(at: ReplayClock.cmTime(videoMs: ms)).image
    }
}

/// 録画の部品（書き出し・メタ・ID・座標の換算・黒画面の判定・起動の指示・一覧）。画面収録は使わない
final class RecordingTests: XCTestCase {
    var dir: URL!

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: dir)
    }

    /// 10fps の合成フレーム（前半 赤・後半 緑）を書き、長さが終了時刻まで伸び、許容誤差 0 で狙った位置のフレームが取れる
    func testWriterProducesSeekableMP4() async throws {
        let url = dir.appendingPathComponent("rec.mp4")
        let red = SyntheticVideo.solid(width: 320, height: 240, r: 0.9, g: 0.1, b: 0.1)
        let green = SyntheticVideo.solid(width: 320, height: 240, r: 0.1, g: 0.8, b: 0.1)
        let frames = (0..<20).map { i in (ms: i * 100, image: i < 10 ? red : green) }
        let writer = try await SyntheticVideo.write(url: url, width: 320, height: 240, frames: frames, endMs: 3000)
        XCTAssertEqual(writer.frames, 20)
        XCTAssertTrue(["hevc", "h264"].contains(writer.codec))

        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration)
        XCTAssertEqual(CMTimeGetSeconds(duration), 3.0, accuracy: 0.05, "最後のフレームを終了時刻まで伸ばす")
        let tracks = try await asset.loadTracks(withMediaType: .video)
        let track = try XCTUnwrap(tracks.first)
        let size = try await track.load(.naturalSize)
        XCTAssertEqual(size, CGSize(width: 320, height: 240))

        let f950 = try await SyntheticVideo.frame(url, ms: 950)
        let at950 = SyntheticVideo.averageColor(f950)
        XCTAssertGreaterThan(at950.r, 150, "950ms は 900ms のフレーム（赤）")
        XCTAssertLessThan(at950.g, 80)
        let f1000 = try await SyntheticVideo.frame(url, ms: 1000)
        let at1000 = SyntheticVideo.averageColor(f1000)
        XCTAssertGreaterThan(at1000.g, 150, "1000ms ちょうどは緑")
        XCTAssertLessThan(at1000.r, 80)
        let f2500 = try await SyntheticVideo.frame(url, ms: 2500)
        let at2500 = SyntheticVideo.averageColor(f2500)
        XCTAssertGreaterThan(at2500.g, 150, "最後のフレームの後も緑のまま")
    }

    /// 実ピクセルの全板ヘッダー帯（fixture）を録画と同じ設定で mp4 にしても、取り出したフレームから現在値と時刻が読める
    /// （1x の録画では緑の現在値が読めなかった。圧縮で小さい色付き数字が潰れないことの保証）
    func testHeaderBandSurvivesCompression() async throws {
        let src = try XCTUnwrap(CGImageSourceCreateWithURL(BoardReaderTests.fixtures.appendingPathComponent("hsbi-header-band.png") as CFURL, nil))
        let band = try XCTUnwrap(CGImageSourceCreateImageAtIndex(src, 0, nil))
        let url = dir.appendingPathComponent("band.mp4")
        let frames = (0..<30).map { (ms: $0 * 100, image: band) }
        try await SyntheticVideo.write(url: url, width: band.width, height: band.height, frames: frames, endMs: 3000)
        // 0ms はキーフレーム、2500ms はキーフレームの後のフレーム
        for ms in [0, 2500] {
            let frame = try await SyntheticVideo.frame(url, ms: ms)
            XCTAssertEqual(frame.width, band.width)
            let r = BoardReader.priceByLabel(image: frame, items: BoardReader.recognize(frame))
            XCTAssertEqual(r?.price, "5566", "\(ms)ms の現在値")
            XCTAssertEqual(r?.time, "15:30", "\(ms)ms の時刻")
        }
    }

    func testWriterOutOfOrderFramesAreDroppedAndEmptyWriterRemovesFile() async throws {
        let url = dir.appendingPathComponent("a.mp4")
        let img = SyntheticVideo.solid(width: 64, height: 64, r: 0.5, g: 0.5, b: 0.5)
        let w = try RecordingWriter(url: url, width: 64, height: 64)
        XCTAssertTrue(w.append(SyntheticVideo.pixelBuffer(img), at: CMTime(value: 1000, timescale: 1000)))
        try await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertTrue(w.append(SyntheticVideo.pixelBuffer(img), at: CMTime(value: 900, timescale: 1000)), "戻った時刻は落とすだけ")
        XCTAssertEqual(w.frames, 1)
        let finished = await w.finish(at: nil)
        XCTAssertTrue(finished)

        let emptyURL = dir.appendingPathComponent("empty.mp4")
        let empty = try RecordingWriter(url: emptyURL, width: 64, height: 64)
        let emptyFinished = await empty.finish(at: CMTime(value: 5, timescale: 1))
        XCTAssertFalse(emptyFinished, "1 枚も無ければ失敗扱い")
        XCTAssertFalse(FileManager.default.fileExists(atPath: emptyURL.path), "空の mp4 は残さない")
    }

    /// メタは snake_case で、無い値も null として書く（web がキーの有無で迷わないように）
    func testMetaRoundTripAndKeys() throws {
        let started = try XCTUnwrap(JST.parse("2026-10-06T08:53:12.345+09:00"))
        var m = RecordingMeta(id: "20261006-085300", width: 1920, height: 1080, plannedMinutes: 37, startedAt: started)
        m.codec = "hevc"
        m.display = RecRect(x: 0, y: 0, w: 1920, h: 1080)
        m.displayID = 2
        m.frames = 22000
        m.samples = [RecSample(tMs: 0, windows: [RecWindow(title: "全板　フジクラ(5803)", frame: RecRect(x: 10, y: 20, w: 600, h: 800))]),
                     RecSample(tMs: 1000, locked: true, windows: [])]
        m.issues = [RecIssue(at: started.addingTimeInterval(60), tMs: 60000, kind: "locked", message: "画面がロックされました"),
                    RecIssue(at: started.addingTimeInterval(-3), tMs: nil, kind: "stream_error", message: "x")]
        let data = try m.data()
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["started_at"] as? String, "2026-10-06T08:53:12.345+09:00")
        XCTAssertTrue(obj["ended_at"] is NSNull, "未終了は null で書く")
        XCTAssertEqual(obj["planned_minutes"] as? Int, 37)
        XCTAssertEqual(obj["status"] as? String, "recording")
        let display = try XCTUnwrap(obj["display"] as? [String: Any])
        XCTAssertEqual(display["id"] as? Int, 2)
        XCTAssertEqual(display["w"] as? Int, 1920)
        let samples = try XCTUnwrap(obj["samples"] as? [[String: Any]])
        XCTAssertEqual(samples[0]["t_ms"] as? Int, 0)
        XCTAssertNotNil((samples[0]["windows"] as? [[String: Any]])?.first?["frame"])
        let issues = try XCTUnwrap(obj["issues"] as? [[String: Any]])
        XCTAssertEqual(issues[0]["at"] as? String, "2026-10-06T08:54:12.345+09:00")
        XCTAssertTrue(issues[1]["t_ms"] is NSNull, "最初のフレームより前の問題は t_ms が null")

        let url = dir.appendingPathComponent("r/x.json")
        try m.write(to: url)
        XCTAssertEqual(RecordingMeta.load(url), m)

        var empty = RecordingMeta(id: "20261006-085300", status: .failed)
        empty.endedAt = started
        let e = try XCTUnwrap(JSONSerialization.jsonObject(with: empty.data()) as? [String: Any])
        XCTAssertTrue(e["started_at"] is NSNull, "1 枚も録れなければ started_at は null")
        XCTAssertTrue(e["display"] is NSNull)
        XCTAssertEqual(RecordingMeta.load(url.deletingLastPathComponent().appendingPathComponent("none.json")), nil)
    }

    func testSampleAtPositionAndDuration() {
        var m = RecordingMeta(id: "x")
        m.samples = [RecSample(tMs: 500, windows: []), RecSample(tMs: 1500, windows: []), RecSample(tMs: 2500, windows: [])]
        XCTAssertEqual(m.sample(at: 0)?.tMs, 500, "先頭より前は最初のサンプル")
        XCTAssertEqual(m.sample(at: 1500)?.tMs, 1500)
        XCTAssertEqual(m.sample(at: 2499)?.tMs, 1500)
        XCTAssertEqual(m.sample(at: 99999)?.tMs, 2500)
        XCTAssertNil(RecordingMeta(id: "y").sample(at: 0))
        XCTAssertNil(m.durationSeconds)
        m.startedAt = Date(timeIntervalSince1970: 1000)
        m.endedAt = Date(timeIntervalSince1970: 1000 + 37 * 60 + 0.9)
        XCTAssertEqual(m.durationSeconds, 2220)
    }

    func testNewIDAndPaths() throws {
        let t = try XCTUnwrap(JST.parse("2026-10-06T08:53:00.900+09:00"))
        XCTAssertEqual(RecordingPaths.newID(at: t) { _ in false }, "20261006-085300")
        let taken: Set = ["20261006-085300", "20261006-085300-2"]
        XCTAssertEqual(RecordingPaths.newID(at: t) { taken.contains($0) }, "20261006-085300-3")
        let f = RecordingPaths.files(dataFolder: dir, id: "20261006-085300", day: "2026-10-06")
        XCTAssertEqual(f.mp4.path, dir.appendingPathComponent("replay/recordings/2026-10-06/20261006-085300.mp4").path)
        XCTAssertEqual(f.json.lastPathComponent, "20261006-085300.json")
    }

    /// グローバル座標（ポイント）のウィンドウ → 録った画面の動画ピクセル。2 枚目のディスプレイ・半分の解像度・はみ出しも
    func testVideoFrameConversion() {
        let display = CGRect(x: 1512, y: 0, width: 1920, height: 1080)
        XCTAssertEqual(ReplayCrop.videoFrame(window: CGRect(x: 1612, y: 100, width: 800, height: 600), display: display,
                                             videoWidth: 1920, videoHeight: 1080), RecRect(x: 100, y: 100, w: 800, h: 600))
        XCTAssertEqual(ReplayCrop.videoFrame(window: CGRect(x: 1612, y: 100, width: 800, height: 600), display: display,
                                             videoWidth: 960, videoHeight: 540), RecRect(x: 50, y: 50, w: 400, h: 300))
        XCTAssertEqual(ReplayCrop.videoFrame(window: CGRect(x: 1312, y: -50, width: 400, height: 300), display: display,
                                             videoWidth: 1920, videoHeight: 1080), RecRect(x: 0, y: 0, w: 200, h: 250),
                       "画面の外にはみ出た分は切る")
        XCTAssertNil(ReplayCrop.videoFrame(window: CGRect(x: 0, y: 0, width: 400, height: 300), display: display,
                                           videoWidth: 1920, videoHeight: 1080), "別の画面のウィンドウ")
    }

    func testPixelRectScalesAndClamps() {
        let f = RecRect(x: 100, y: 50, w: 400, h: 300)
        XCTAssertEqual(ReplayCrop.pixelRect(f, videoWidth: 1000, videoHeight: 600, imageWidth: 1000, imageHeight: 600),
                       CGRect(x: 100, y: 50, width: 400, height: 300))
        XCTAssertEqual(ReplayCrop.pixelRect(f, videoWidth: 1000, videoHeight: 600, imageWidth: 500, imageHeight: 300),
                       CGRect(x: 50, y: 25, width: 200, height: 150))
        XCTAssertEqual(ReplayCrop.pixelRect(RecRect(x: 900, y: 500, w: 400, h: 300), videoWidth: 1000, videoHeight: 600,
                                            imageWidth: 1000, imageHeight: 600), CGRect(x: 900, y: 500, width: 100, height: 100))
        XCTAssertNil(ReplayCrop.pixelRect(RecRect(x: 0, y: 0, w: 5, h: 5), videoWidth: 1000, videoHeight: 600,
                                          imageWidth: 1000, imageHeight: 600), "小さすぎる枠は使わない")
    }

    /// ロック中・ディスプレイのスリープを疑う黒画面（BGRA と 420v）
    func testBlackFrame() {
        XCTAssertTrue(BlackFrame.isMostlyBlack(SyntheticVideo.pixelBuffer(SyntheticVideo.solid(width: 320, height: 200, r: 0, g: 0, b: 0))))
        XCTAssertFalse(BlackFrame.isMostlyBlack(SyntheticVideo.pixelBuffer(SyntheticVideo.solid(width: 320, height: 200, r: 0.9, g: 0.9, b: 0.9))))
        // 黒地に白い文字の行（暗いテーマの板）は黒画面ではない
        let darkBoard = TestImages.render(width: 640, height: 400, labels: (0..<8).map {
            .init(text: "3,021.5   1,200   3,020", origin: CGPoint(x: 10, y: 10 + $0 * 48), fontSize: 36)
        }, background: CGColor(gray: 0, alpha: 1), foreground: CGColor(gray: 1, alpha: 1))
        XCTAssertFalse(BlackFrame.isMostlyBlack(SyntheticVideo.pixelBuffer(darkBoard)))

        func yuv(_ luma: UInt8) -> CVPixelBuffer {
            var pb: CVPixelBuffer?
            CVPixelBufferCreate(nil, 320, 200, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, nil, &pb)
            let b = pb!
            CVPixelBufferLockBaseAddress(b, [])
            let y = CVPixelBufferGetBaseAddressOfPlane(b, 0)!
            memset(y, Int32(luma), CVPixelBufferGetBytesPerRowOfPlane(b, 0) * CVPixelBufferGetHeightOfPlane(b, 0))
            let uv = CVPixelBufferGetBaseAddressOfPlane(b, 1)!
            memset(uv, 128, CVPixelBufferGetBytesPerRowOfPlane(b, 1) * CVPixelBufferGetHeightOfPlane(b, 1))
            CVPixelBufferUnlockBaseAddress(b, [])
            return b
        }
        XCTAssertTrue(BlackFrame.isMostlyBlack(yuv(16)), "ビデオレンジの黒")
        XCTAssertFalse(BlackFrame.isMostlyBlack(yuv(180)))
    }

    func testRecordCommandParsing() throws {
        XCTAssertEqual(RecordCommand.minutes(fromArguments: ["TradePanel", "--record-minutes", "37"]), 37)
        XCTAssertNil(RecordCommand.minutes(fromArguments: ["TradePanel"]))
        XCTAssertNil(RecordCommand.minutes(fromArguments: ["TradePanel", "--record-minutes"]))
        XCTAssertNil(RecordCommand.minutes(fromArguments: ["TradePanel", "--record-minutes", "0"]))
        XCTAssertNil(RecordCommand.minutes(fromArguments: ["TradePanel", "--record-minutes", "abc"]))
        XCTAssertNil(RecordCommand.minutes(fromArguments: ["TradePanel", "--record-minutes", "361"]))

        func url(scheme: String = "tradepanel", host: String = "record", minutes: String?) throws -> URL {
            var c = URLComponents()
            c.scheme = scheme
            c.host = host
            if let minutes { c.queryItems = [URLQueryItem(name: "minutes", value: minutes)] }
            return try XCTUnwrap(c.url)
        }
        XCTAssertEqual(RecordCommand.minutes(fromURL: try url(minutes: "37")), 37)
        XCTAssertEqual(RecordCommand.minutes(fromURL: try url(scheme: "TradePanel", minutes: "5")), 5)
        XCTAssertNil(RecordCommand.minutes(fromURL: try url(minutes: nil)))
        XCTAssertNil(RecordCommand.minutes(fromURL: try url(minutes: "999")))
        XCTAssertNil(RecordCommand.minutes(fromURL: try url(host: "replay", minutes: "37")))
        XCTAssertNil(RecordCommand.minutes(fromURL: try url(scheme: "other", minutes: "37")))
    }

    /// 一覧は新しい順。mp4 の無い（録れなかった）ものも出すが、練習には使えない
    @MainActor
    func testScanEntriesAndResultLine() throws {
        let started = try XCTUnwrap(JST.parse("2026-10-06T08:53:12.345+09:00"))
        var ok = RecordingMeta(id: "20261006-085300", status: .done, width: 1920, height: 1080, startedAt: started)
        ok.endedAt = started.addingTimeInterval(37 * 60)
        let okFiles = RecordingPaths.files(dataFolder: dir, id: ok.id, day: "2026-10-06")
        try ok.write(to: okFiles.json)
        try Data(repeating: 1, count: 1000).write(to: okFiles.mp4)
        var failed = RecordingMeta(id: "20261007-085300", status: .failed)
        failed.endedAt = started.addingTimeInterval(86400)
        failed.issues = [RecIssue(at: started.addingTimeInterval(86400), tMs: nil, kind: "no_permission", message: "画面収録の許可がありません")]
        try failed.write(to: RecordingPaths.files(dataFolder: dir, id: failed.id, day: "2026-10-07").json)

        let entries = RecordingEntry.scan(dataFolder: dir)
        XCTAssertEqual(entries.map(\.id), ["20261007-085300", "20261006-085300"])
        XCTAssertFalse(entries[0].canReplay)
        XCTAssertFalse(entries[0].hasVideo)
        XCTAssertTrue(entries[1].canReplay)
        XCTAssertGreaterThan(entries[1].bytes, 1000)
        XCTAssertTrue(RecordingEntry.scan(dataFolder: dir.appendingPathComponent("none")).isEmpty)

        XCTAssertEqual(RecordingController.resultLine(ok), "録画終了 09:30")
        XCTAssertEqual(RecordingController.resultLine(failed), "録画できませんでした 08:53・問題 1 件（画面収録の許可がありません）")
        var stopped = ok
        stopped.status = .stopped
        stopped.issues = [RecIssue(at: started, tMs: 1000, kind: "locked", message: "画面がロックされました"),
                          RecIssue(at: started, tMs: 2000, kind: "unlocked", message: "ロックが解除されました")]
        XCTAssertEqual(RecordingController.resultLine(stopped), "録画を止めました 09:30・問題 1 件（画面がロックされました）",
                       "解除などの回復の記録は問題に数えない")
    }

    /// 動画を閉じられなかった録画は、止めた・満了に関係なく failed（done/stopped にして練習に出さない）
    func testFinalStatusIsFailedWhenWriterCannotClose() {
        XCTAssertEqual(ScreenRecorder.finalStatus(hasWriter: true, closed: true, stopRequested: false), .done)
        XCTAssertEqual(ScreenRecorder.finalStatus(hasWriter: true, closed: true, stopRequested: true), .stopped)
        XCTAssertEqual(ScreenRecorder.finalStatus(hasWriter: true, closed: false, stopRequested: false), .failed)
        XCTAssertEqual(ScreenRecorder.finalStatus(hasWriter: true, closed: false, stopRequested: true), .failed)
        XCTAssertEqual(ScreenRecorder.finalStatus(hasWriter: false, closed: false, stopRequested: false), .failed)
    }

    /// 練習に出すのは、failed でなく、mp4 に再生できる映像トラックがある録画だけ（一覧を読んだ後に裏で確かめる）
    @MainActor
    func testCanReplayExcludesFailedAndUnplayableVideo() async throws {
        let started = try XCTUnwrap(JST.parse("2026-10-06T08:53:12.345+09:00"))
        func make(_ id: String, status: RecStatus) throws -> (json: URL, mp4: URL) {
            let f = RecordingPaths.files(dataFolder: dir, id: id, day: "2026-10-06")
            try RecordingMeta(id: id, status: status, width: 64, height: 64, startedAt: started).write(to: f.json)
            return (f.json, f.mp4)
        }
        let good = try make("20261006-085300", status: .done)
        _ = try await SyntheticVideo.write(url: good.mp4, width: 64, height: 64,
                                           frames: [(ms: 0, image: SyntheticVideo.solid(width: 64, height: 64, r: 1, g: 0, b: 0))], endMs: 1000)
        let broken = try make("20261006-090000", status: .done)
        try Data(repeating: 1, count: 1000).write(to: broken.mp4)
        let failed = try make("20261006-091000", status: .failed)
        try FileManager.default.copyItem(at: good.mp4, to: failed.mp4)

        let c = RecordingController()
        c.dataFolder = { [dir] in dir }
        c.reloadList()
        XCTAssertFalse(try XCTUnwrap(c.entries.first { $0.id == failed.json.deletingPathExtension().lastPathComponent }).canReplay,
                       "failed は動画があっても練習に出さない")
        await c.waitForVerification()
        func entry(_ u: URL) throws -> RecordingEntry { try XCTUnwrap(c.entries.first { $0.mp4 == u }) }
        XCTAssertEqual(try entry(good.mp4).playable, true)
        XCTAssertTrue(try entry(good.mp4).canReplay)
        XCTAssertEqual(try entry(broken.mp4).playable, false)
        XCTAssertFalse(try entry(broken.mp4).canReplay, "再生できない mp4 は練習に出さない")
        XCTAssertNil(ReplaySession(entry: try entry(broken.mp4)))
        let playableBroken = await RecordingEntry.hasPlayableVideo(broken.mp4)
        XCTAssertFalse(playableBroken)

        // 読み直しても確かめた結果は使い回す
        c.reloadList()
        XCTAssertEqual(try entry(broken.mp4).playable, false)
    }

    /// 空きが 5 GB 未満なら録画を始めず、理由を出す。設定には空き容量を出す
    @MainActor
    func testRecordingRefusesWhenDiskIsNearlyFull() {
        let c = RecordingController()
        c.dataFolder = { [dir] in dir }
        c.freeSpace = { _ in 1_000_000_000 }
        c.start(minutes: 37)
        XCTAssertFalse(c.isRecording)
        XCTAssertNil(c.activeID)
        let line = c.statusLine ?? ""
        XCTAssertTrue(line.hasPrefix("録画しません: 空き容量が"), line)
        XCTAssertTrue(line.contains("ゴミ箱を空に"), line)
        c.reloadList()
        XCTAssertEqual(c.freeBytes, 1_000_000_000)
        XCTAssertFalse(FileManager.default.fileExists(atPath: RecordingPaths.recordingsFolder(dir).path), "何も作らない")
    }

    /// 進み具合のクロージャが録画を強く持たない（録画が終わったら解放される）
    @MainActor
    func testProgressHandlerDoesNotRetainRecorder() {
        let c = RecordingController()
        weak var weakRecorder: ScreenRecorder?
        do {
            let r = ScreenRecorder(dataFolder: dir, id: "20261006-085300", day: "2026-10-06", minutes: 1)
            c.attachProgress(r)
            XCTAssertNotNil(r.onProgress)
            weakRecorder = r
        }
        XCTAssertNil(weakRecorder, "onProgress が r を強く持つと r → onProgress → r の循環で解放されない")
    }
}

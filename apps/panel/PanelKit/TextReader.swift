import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

/// ウィンドウの大きさに対する相対座標の矩形（左上原点、0〜1）
public struct RelRect: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var w: Double
    public var h: Double

    public init(x: Double, y: Double, w: Double, h: Double) {
        self.x = x
        self.y = y
        self.w = w
        self.h = h
    }

    /// 画像のピクセル座標に直す（はみ出しは切り詰める）
    public func pixelRect(width: Int, height: Int) -> CGRect? {
        let r = CGRect(x: x * Double(width), y: y * Double(height), width: w * Double(width), height: h * Double(height))
            .integral
            .intersection(CGRect(x: 0, y: 0, width: width, height: height))
        return r.width >= 2 && r.height >= 2 ? r : nil
    }
}

public struct ReadResult: Equatable, Sendable {
    public var text: String?
    public var confidence: Double?
}

/// Vision で画面の文字を読む（端末内で完結。ネットワークは使わない）
public enum TextReader {
    public static func read(_ image: CGImage, region: RelRect?, languages: [String] = ["en-US"]) -> ReadResult {
        let target: CGImage
        if let region {
            guard let rect = region.pixelRect(width: image.width, height: image.height),
                  let cropped = image.cropping(to: rect) else { return ReadResult() }
            target = cropped
        } else {
            target = image
        }
        guard let prepared = upscaledIfSmall(target).flatMap(padded) else { return ReadResult() }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        request.recognitionLanguages = languages
        let handler = VNImageRequestHandler(cgImage: prepared, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return ReadResult()
        }
        let candidates = (request.results ?? [])
            .sorted { $0.boundingBox.minX < $1.boundingBox.minX }
            .compactMap { $0.topCandidates(1).first }
        guard !candidates.isEmpty else { return ReadResult() }
        let text = candidates.map(\.string).joined(separator: " ")
        let conf = candidates.map { Double($0.confidence) }.min()
        return ReadResult(text: text, confidence: conf.map { ($0 * 1000).rounded() / 1000 })
    }

    /// 小さい文字は Vision が取りこぼすので、高さ 64px 程度まで拡大してから読む
    static func upscaledIfSmall(_ image: CGImage) -> CGImage? {
        let minHeight = 64
        guard image.height < minHeight else { return image }
        let scale = Double(minHeight) / Double(max(image.height, 1))
        let w = Int((Double(image.width) * scale).rounded())
        let h = minHeight
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        return ctx.makeImage()
    }

    /// 文字が切り出しの端に接していると Vision が読み違える（実測: "3,021.5" → "3,021.Ęł"）ので、
    /// 左上の画素の色で周囲に余白を足す（HYPER SBI 2 の暗い背景でも背景色のまま広がる）
    static func padded(_ image: CGImage) -> CGImage? {
        let m = max(image.height / 2, 8)
        let w = image.width + 2 * m, h = image.height + 2 * m
        let space = CGColorSpaceCreateDeviceRGB()
        let info = CGImageAlphaInfo.premultipliedLast.rawValue
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: info),
              let corner = image.cropping(to: CGRect(x: 0, y: 0, width: 1, height: 1)) else { return nil }
        var px = [UInt8](repeating: 255, count: 4)
        px.withUnsafeMutableBytes { buf in
            if let one = CGContext(data: buf.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: space, bitmapInfo: info) {
                one.draw(corner, in: CGRect(x: 0, y: 0, width: 1, height: 1))
            }
        }
        ctx.setFillColor(CGColor(red: CGFloat(px[0]) / 255, green: CGFloat(px[1]) / 255, blue: CGFloat(px[2]) / 255, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.draw(image, in: CGRect(x: m, y: m, width: image.width, height: image.height))
        return ctx.makeImage()
    }

    public static func writePNG(_ image: CGImage, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            throw CocoaError(.fileWriteUnknown)
        }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else { throw CocoaError(.fileWriteUnknown) }
    }
}

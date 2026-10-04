import CoreGraphics
import CoreText
import Foundation

/// 画面の代わりに、文字を描いた画像をオフスクリーンで作る（画面収録の権限は不要）
enum TestImages {
    struct Label {
        var text: String
        /// 左上原点のピクセル座標
        var origin: CGPoint
        var fontSize: CGFloat
    }

    static func render(width: Int, height: Int, labels: [Label], background: CGColor = CGColor(gray: 1, alpha: 1),
                       foreground: CGColor = CGColor(gray: 0, alpha: 1)) -> CGImage {
        let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.setFillColor(background)
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        for l in labels {
            let font = CTFontCreateWithName("Helvetica" as CFString, l.fontSize, nil)
            let attr = NSAttributedString(string: l.text, attributes: [
                NSAttributedString.Key(kCTFontAttributeName as String): font,
                NSAttributedString.Key(kCTForegroundColorAttributeName as String): foreground,
            ])
            let line = CTLineCreateWithAttributedString(attr)
            // CG は左下原点なので、左上原点の指定を変換する（文字のベースラインを枠の下寄りに置く）
            ctx.textPosition = CGPoint(x: l.origin.x, y: CGFloat(height) - l.origin.y - l.fontSize)
            CTLineDraw(line, ctx)
        }
        return ctx.makeImage()!
    }
}

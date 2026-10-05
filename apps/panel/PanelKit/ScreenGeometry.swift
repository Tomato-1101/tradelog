import CoreGraphics
import Foundation

/// 画面上で囲んだ矩形を、対象ウィンドウに対する比率（RelRect）へ直すための座標変換（純粋関数のみ）。
///
/// 座標系は 2 つある（どちらも単位はポイント。Retina の倍率は掛けない）:
/// - AppKit（NSScreen.frame / NSWindow.frame）: 主ディスプレイ（メニューバーのある画面）の左下が原点、y は上向き。
/// - CG（SCWindow.frame / CGWindowList の bounds）: 主ディスプレイの左上が原点、y は下向き。
/// どちらも全ディスプレイ共通のグローバル座標なので、主ディスプレイより左や上の画面では原点が負になる。
/// RelRect は比率なので、撮影画像のピクセル数（ポイント × 倍率）とは無関係に、読み取り側の pixelRect でそのまま使える。
public enum ScreenGeometry {
    /// AppKit のグローバル座標 → CG のグローバル座標（primaryHeight は主ディスプレイ NSScreen.screens[0] の高さ）
    public static func cgRect(fromAppKit r: CGRect, primaryHeight: CGFloat) -> CGRect {
        let r = r.standardized
        return CGRect(x: r.minX, y: primaryHeight - r.maxY, width: r.width, height: r.height)
    }

    /// CG のグローバル座標 → AppKit のグローバル座標（上の逆。式は対称）
    public static func appKitRect(fromCG r: CGRect, primaryHeight: CGFloat) -> CGRect {
        let r = r.standardized
        return CGRect(x: r.minX, y: primaryHeight - r.maxY, width: r.width, height: r.height)
    }

    /// 囲んだ矩形（CG）を、対象ウィンドウの SCWindow.frame（CG）に対する比率にする。
    /// ウィンドウの外にはみ出した分は切り詰める。重なりが無い・小さすぎる（minSize ポイント未満）なら nil
    public static func relRect(selection: CGRect, windowFrame: CGRect, minSize: CGFloat = 3) -> RelRect? {
        let wf = windowFrame.standardized
        guard wf.width > 0, wf.height > 0 else { return nil }
        let s = selection.standardized.intersection(wf)
        guard !s.isNull, s.width >= minSize, s.height >= minSize else { return nil }
        return RelRect(x: Double((s.minX - wf.minX) / wf.width), y: Double((s.minY - wf.minY) / wf.height),
                       w: Double(s.width / wf.width), h: Double(s.height / wf.height))
    }

    /// 比率 → 対象ウィンドウ上の CG 矩形（relRect の逆）
    public static func cgRect(rel: RelRect, windowFrame: CGRect) -> CGRect {
        let wf = windowFrame.standardized
        return CGRect(x: wf.minX + CGFloat(rel.x) * wf.width, y: wf.minY + CGFloat(rel.y) * wf.height,
                      width: CGFloat(rel.w) * wf.width, height: CGFloat(rel.h) * wf.height)
    }

    /// 対象ウィンドウ（CG）と重なりが最も大きい画面の添字。screenFrames は NSScreen.screens の frame（AppKit）。
    /// どの画面とも重ならなければ nil
    public static func screenIndex(forWindow windowFrame: CGRect, screenFrames: [CGRect], primaryHeight: CGFloat) -> Int? {
        let w = appKitRect(fromCG: windowFrame, primaryHeight: primaryHeight)
        var best: (index: Int, area: CGFloat)?
        for (i, f) in screenFrames.enumerated() {
            let r = f.intersection(w)
            guard !r.isNull else { continue }
            let area = r.width * r.height
            if area > 0, area > (best?.area ?? 0) { best = (i, area) }
        }
        return best?.index
    }
}

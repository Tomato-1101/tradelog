import XCTest
@testable import PanelKit

final class ParserTests: XCTestCase {
    func testPriceParser() {
        XCTAssertEqual(PriceParser.parse("1,234.5"), "1234.5")
        XCTAssertEqual(PriceParser.parse("1,234"), "1234")
        XCTAssertEqual(PriceParser.parse("12,345,678"), "12345678")
        XCTAssertEqual(PriceParser.parse("987"), "987")
        XCTAssertEqual(PriceParser.parse("2345.5"), "2345.5")
        XCTAssertEqual(PriceParser.parse("  2,345.5 \n"), "2345.5", "前後の空白は許す")

        // ノイズ混じり・曖昧なものは null（誤った値を入れるより null）
        for bad in ["1,234円", "▲1,234", "1,234.5 +12", "12,34", "1,2345", "1.234.5", "1234.", ".5", "l,234", "1 234",
                    "", " ", "+1,234", "-12", "1,234.5%", "O", "2,345.5 (前日比)", "1,,234"] {
            XCTAssertNil(PriceParser.parse(bad), "「\(bad)」は null であるべき")
        }
        XCTAssertNil(PriceParser.parse(nil))
    }

    func testSymbolParser() {
        XCTAssertTrue(SymbolParser.isValid("7203"))
        XCTAssertTrue(SymbolParser.isValid("285A"))
        XCTAssertTrue(SymbolParser.isValid("130A"))
        XCTAssertFalse(SymbolParser.isValid("720"))
        XCTAssertFalse(SymbolParser.isValid("72030"))
        XCTAssertFalse(SymbolParser.isValid("A203"))
        XCTAssertFalse(SymbolParser.isValid("285a"), "入力欄は大文字で")

        XCTAssertEqual(SymbolParser.extract("7203 トヨタ自動車"), "7203")
        XCTAssertEqual(SymbolParser.extract("[285a] ABC"), "285A")
        XCTAssertEqual(SymbolParser.extract("東証 9984"), "9984")
        XCTAssertNil(SymbolParser.extract("12345"))
        XCTAssertNil(SymbolParser.extract("トヨタ"))
        XCTAssertNil(SymbolParser.extract(nil))
    }

    func testQtyParser() {
        XCTAssertEqual(QtyParser.parse("100"), "100")
        XCTAssertEqual(QtyParser.parse("1,000"), "1000")
        XCTAssertNil(QtyParser.parse("0"))
        XCTAssertNil(QtyParser.parse("-100"))
        XCTAssertNil(QtyParser.parse("10.5"))
        XCTAssertNil(QtyParser.parse("100株"))
        XCTAssertNil(QtyParser.parse(""))
    }

    func testRelRectToPixels() {
        let r = RelRect(x: 0.5, y: 0.25, w: 0.25, h: 0.5)
        XCTAssertEqual(r.pixelRect(width: 800, height: 400), CGRect(x: 400, y: 100, width: 200, height: 200))
        // はみ出しは切り詰める
        XCTAssertEqual(RelRect(x: 0.9, y: 0.9, w: 0.5, h: 0.5).pixelRect(width: 100, height: 100), CGRect(x: 90, y: 90, width: 10, height: 10))
        XCTAssertNil(RelRect(x: 2, y: 2, w: 0.1, h: 0.1).pixelRect(width: 100, height: 100))
    }
}

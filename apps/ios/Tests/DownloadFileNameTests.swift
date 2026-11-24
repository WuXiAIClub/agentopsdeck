import XCTest
@testable import AgentOpsDeck

final class DownloadFileNameTests: XCTestCase {
    func testRecoversVideoExtensionFromMimeType() {
        XCTAssertEqual(DownloadFileName.make(suggested: "download.bin", mimeType: "video/mp4"), "download.mp4")
        XCTAssertEqual(DownloadFileName.make(suggested: "video", mimeType: "video/mp4; charset=binary"), "video.mp4")
    }

    func testPreservesUsefulNames() {
        XCTAssertEqual(DownloadFileName.make(suggested: "聊天记录.zip", mimeType: "application/zip"), "聊天记录.zip")
        XCTAssertEqual(DownloadFileName.make(suggested: "clip.mov", mimeType: "application/octet-stream"), "clip.mov")
    }

    func testUnknownMimeHasSafeFallback() {
        XCTAssertEqual(DownloadFileName.make(suggested: "", mimeType: nil), "download.bin")
        XCTAssertEqual(DownloadFileName.make(suggested: "download.bin", mimeType: "application/octet-stream"), "download.bin")
    }

    func testSanitizesPathCharacters() {
        let filename = DownloadFileName.make(suggested: "../../folder\\name\n.mp4", mimeType: "video/mp4")
        XCTAssertFalse(filename.contains("/"))
        XCTAssertFalse(filename.contains("\\"))
        XCTAssertFalse(filename.contains("\n"))
        XCTAssertFalse(filename.hasPrefix("."))
        XCTAssertTrue(filename.hasSuffix(".mp4"))
    }

    func testBoundsLengthAndHiddenNames() {
        let filename = DownloadFileName.make(suggested: String(repeating: "文", count: 300), mimeType: "video/mp4")
        XCTAssertLessThanOrEqual(filename.utf8.count, 224)
        XCTAssertTrue(filename.hasSuffix(".mp4"))
        XCTAssertEqual(DownloadFileName.make(suggested: "...", mimeType: nil), "download.bin")
    }

    func testLongNamesPreserveUsefulExtension() {
        let filename = DownloadFileName.make(suggested: String(repeating: "文", count: 300) + ".zip", mimeType: "application/zip")
        XCTAssertLessThanOrEqual(filename.utf8.count, 224)
        XCTAssertTrue(filename.hasSuffix(".zip"))
    }
}

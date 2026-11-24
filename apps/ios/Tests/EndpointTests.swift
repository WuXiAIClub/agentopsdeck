import XCTest
@testable import AgentOpsDeck

final class EndpointTests: XCTestCase {
    func testCanonicalization() throws {
        let endpoint = try XCTUnwrap(Endpoint("  https://EXAMPLE.com:443/\n"))
        XCTAssertEqual(endpoint.url.absoluteString, "https://example.com/")
        XCTAssertEqual(Endpoint("https://example.com:8443")?.url.absoluteString, "https://example.com:8443/")
    }

    func testInvalidEndpoints() {
        let invalid = ["", "example.com", "http://example.com", "file:///tmp/test", "javascript:alert(1)",
                       "https://user:secret@example.com", "https://example.com/app", "https://example.com?key=secret",
                       "https://example.com/#test", "https://example.com:0", "https://example.com:65536"]
        for value in invalid { XCTAssertNil(Endpoint(value), value) }
    }

    func testOriginBoundary() throws {
        let endpoint = try XCTUnwrap(Endpoint("https://example.com"))
        XCTAssertTrue(endpoint.contains(try XCTUnwrap(URL(string: "https://EXAMPLE.com:443/api/sessions?q=1"))))
        let rejected = ["http://example.com", "https://example.com:8443", "https://example.com.evil.test",
                        "https://other.example.com", "https://user:pass@example.com"]
        for value in rejected {
            XCTAssertFalse(endpoint.contains(try XCTUnwrap(URL(string: value))), value)
        }
    }

    func testBlobDownloadsRemainSameOrigin() throws {
        let endpoint = try XCTUnwrap(Endpoint("https://example.com"))
        XCTAssertTrue(endpoint.permitsDownload(try XCTUnwrap(URL(string: "blob:https://example.com/a-uuid"))))
        XCTAssertFalse(endpoint.permitsDownload(try XCTUnwrap(URL(string: "blob:https://evil.test/a-uuid"))))
        XCTAssertFalse(endpoint.permitsDownload(try XCTUnwrap(URL(string: "blob:null/a-uuid"))))
        XCTAssertFalse(endpoint.permitsDownload(try XCTUnwrap(URL(string: "data:text/plain,example"))))
    }

    func testConfiguredPortIsNotAnAlias() throws {
        let endpoint = try XCTUnwrap(Endpoint("https://example.com:8443"))
        XCTAssertTrue(endpoint.contains(try XCTUnwrap(URL(string: "https://example.com:8443/api/media/test"))))
        XCTAssertFalse(endpoint.contains(try XCTUnwrap(URL(string: "https://example.com/api/media/test"))))
    }
}

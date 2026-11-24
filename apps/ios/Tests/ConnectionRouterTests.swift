import XCTest
@testable import AgentOpsDeck

final class ConnectionRouterTests: XCTestCase {
    private let publicEndpoint = Endpoint("https://agentopsdeck.example")!
    private let first = Endpoint("http://10.0.0.8:8790", allowLocalHTTP: true)!
    private let second = Endpoint("http://computer.local:8790", allowLocalHTTP: true)!

    private func settings() -> ConnectionSettings {
        var settings = ConnectionSettings(publicEndpoint: publicEndpoint)
        settings.localEndpoints = [first, second]
        return settings
    }

    func testLocalHTTPIsExplicitAndPrivateOnly() throws {
        XCTAssertNil(Endpoint("http://10.0.0.8:8790"))
        for host in ["10.0.0.8", "172.16.0.1", "172.31.255.254", "192.168.1.8", "computer.local"] {
            XCTAssertNotNil(Endpoint("http://\(host):8790", allowLocalHTTP: true), host)
        }
        for host in ["example.com", "8.8.8.8", "127.0.0.1", "169.254.1.8", "172.32.0.1", "10.0.0.999", "localhost"] {
            XCTAssertNil(Endpoint("http://\(host):8790", allowLocalHTTP: true), host)
        }
        XCTAssertTrue(first.contains(try XCTUnwrap(URL(string: "http://10.0.0.8:8790/api/auth/status"))))
        XCTAssertFalse(first.contains(try XCTUnwrap(URL(string: "https://10.0.0.8:8790/api/auth/status"))))
        XCTAssertFalse(first.contains(try XCTUnwrap(URL(string: "http://10.0.0.8/api/auth/status"))))
        let defaultPort = try XCTUnwrap(Endpoint("http://computer.local:80", allowLocalHTTP: true))
        XCTAssertEqual(defaultPort.origin, "http://computer.local")
        XCTAssertTrue(defaultPort.contains(try XCTUnwrap(URL(string: "http://computer.local:80/api/auth/status"))))
    }

    func testLocalConfigurationParsing() throws {
        let parsed = try XCTUnwrap(ConnectionSettings.parseLocalEndpoints(first.origin + ", " + second.origin))
        XCTAssertEqual(parsed, [first, second])
        XCTAssertEqual(ConnectionSettings.parseLocalEndpoints(first.origin + "," + first.origin), [first])
        XCTAssertEqual(ConnectionSettings.parseLocalEndpoints(""), [])
        XCTAssertNil(ConnectionSettings.parseLocalEndpoints("https://public.example"))
        XCTAssertNil(ConnectionSettings.parseLocalEndpoints(first.origin + "/app"))
        XCTAssertNil(ConnectionSettings.parseLocalEndpoints("http://key@computer.local"))
        XCTAssertNil(ConnectionSettings.parseLocalEndpoints("http://computer.local?key=test"))
        XCTAssertNil(ConnectionSettings.parseLocalEndpoints(Array(repeating: first.origin, count: 4).joined(separator: ",")))
    }

    func testConfigurationIsScopedToPublicEndpoint() throws {
        let suite = "AgentOpsDeckTests." + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let configured = settings()
        configured.save(defaults: defaults)
        XCTAssertEqual(ConnectionSettings(publicEndpoint: publicEndpoint, defaults: defaults).localEndpoints, [first, second])
        XCTAssertTrue(ConnectionSettings(publicEndpoint: Endpoint("https://other.example")!, defaults: defaults).localEndpoints.isEmpty)
    }

    func testBothReachableKeepCurrentLocalWithoutProbingOtherAddress() async {
        var probed: [Endpoint] = []
        let selected = await RoutePolicy.select(current: second, settings: settings(), wifi: true) { endpoint in
            probed.append(endpoint)
            return true
        }
        XCTAssertEqual(selected, second)
        XCTAssertEqual(probed, [second])
    }

    func testInitialConnectionPrefersFirstReachableLocal() async {
        var probed: [Endpoint] = []
        let selected = await RoutePolicy.select(current: nil, settings: settings(), wifi: true) { endpoint in
            probed.append(endpoint)
            return endpoint == self.second
        }
        XCTAssertEqual(selected, second)
        XCTAssertEqual(probed, [first, second])
    }

    func testUnreachableLocalFallsBackToConfiguredPublic() async {
        let selected = await RoutePolicy.select(current: first, settings: settings(), wifi: true) { _ in false }
        XCTAssertEqual(selected, publicEndpoint)
    }

    func testWithoutWifiDoesNotProbe() async {
        var calls = 0
        let selected = await RoutePolicy.select(current: first, settings: settings(), wifi: false) { _ in
            calls += 1
            return true
        }
        XCTAssertEqual(selected, publicEndpoint)
        XCTAssertEqual(calls, 0)
    }

    func testRepeatedSuggestionsDoNotNag() {
        var policy = RoutePolicy()
        XCTAssertTrue(policy.shouldOffer(current: publicEndpoint, selected: first))
        XCTAssertFalse(policy.shouldOffer(current: publicEndpoint, selected: first))
        XCTAssertFalse(policy.shouldOffer(current: first, selected: first))
        XCTAssertTrue(policy.shouldOffer(current: publicEndpoint, selected: first))
    }

    func testProbeRequiresExistingAgentOpsDeckAuthShape() throws {
        let response = try XCTUnwrap(HTTPURLResponse(url: publicEndpoint.url, statusCode: 200,
            httpVersion: nil, headerFields: ["Content-Type": "application/json"]))
        XCTAssertTrue(ServerProbe.validResponse(Data(#"{"authenticated":false,"passkeys":{}}"#.utf8), response: response))
        for body in [#"{"authenticated":1,"passkeys":{}}"#, #"{"authenticated":true}"#,
                     #"{"authenticated":false,"passkeys":[]}"#, "<html>login</html>"] {
            XCTAssertFalse(ServerProbe.validResponse(Data(body.utf8), response: response))
        }
        let redirect = try XCTUnwrap(HTTPURLResponse(url: publicEndpoint.url, statusCode: 302,
            httpVersion: nil, headerFields: ["Content-Type": "application/json"]))
        XCTAssertFalse(ServerProbe.validResponse(Data(#"{"authenticated":true,"passkeys":{}}"#.utf8), response: redirect))
        XCTAssertFalse(ServerProbe.validResponse(Data(repeating: 32, count: 8193), response: response))
    }

    func testResourcesFollowActiveRouteInBothDirections() throws {
        let paths = ["/api/media/inbound/clip.mp4", "/api/artifacts/a0B1", "/api/files/gateway/download",
                     "/api/files/agents/agent-1/download",
                     "/api/hub/v1/sessions/session-1/messages/message-1/media/" + String(repeating: "a", count: 64)]
        for path in paths {
            let remote = try XCTUnwrap(URL(string: publicEndpoint.origin + path + "?name=clip.mp4#t=3"))
            let local = ResourceAddress.route(remote, current: first, settings: settings())
            XCTAssertEqual(local.absoluteString, first.origin + path + "?name=clip.mp4#t=3")
            XCTAssertEqual(ResourceAddress.route(local, current: publicEndpoint, settings: settings()), remote)
        }
    }

    func testResourceMappingDoesNotRewriteOtherOriginsOrAPIPaths() throws {
        for value in ["https://cdn.example/api/media/inbound/clip.mp4", publicEndpoint.origin + "/api/sessions",
                      publicEndpoint.origin + "/api/media/inbound/a%2fb",
                      publicEndpoint.origin + "/api/media/inbound/%2e%2e",
                      "https://user:password@agentopsdeck.example/api/media/inbound/clip.mp4",
                      "http://10.0.0.99:8790/api/media/inbound/clip.mp4"] {
            let url = try XCTUnwrap(URL(string: value))
            XCTAssertEqual(ResourceAddress.route(url, current: first, settings: settings()), url)
        }
    }

    func testHTTPContentRulesOnlyAllowActiveLocalOrigin() throws {
        let publicRules = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(
            ResourceAddress.httpRules(for: publicEndpoint).utf8)) as? [[String: Any]])
        XCTAssertEqual(publicRules.count, 1)
        let localRules = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(
            ResourceAddress.httpRules(for: first).utf8)) as? [[String: Any]])
        XCTAssertEqual(localRules.count, 2)
        let trigger = try XCTUnwrap(localRules[1]["trigger"] as? [String: String])
        let pattern = try XCTUnwrap(trigger["url-filter"])
        XCTAssertNotNil((first.origin + "/api/auth/status").range(of: pattern, options: .regularExpression))
        XCTAssertNil("http://10.0.0.8:87900/api/auth/status".range(of: pattern, options: .regularExpression))
    }
}

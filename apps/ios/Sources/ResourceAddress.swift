import Foundation

struct ResourceAddress {
    static func route(_ url: URL, current: Endpoint, settings: ConnectionSettings) -> URL {
        guard current == settings.publicEndpoint || settings.localEndpoints.contains(current),
              ([settings.publicEndpoint] + settings.localEndpoints).contains(where: { $0.contains(url) }),
              var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        let path = parts.percentEncodedPath
        guard !path.contains("\\"),
              path.range(of: "%2e|%2f|%5c", options: [.regularExpression, .caseInsensitive]) == nil,
              !path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }),
              isResourcePath(path) else { return url }
        parts.scheme = current.url.scheme
        parts.host = current.url.host
        parts.port = current.url.port
        return parts.url ?? url
    }

    private static func isResourcePath(_ path: String) -> Bool {
        let patterns = [
            "^/api/media/inbound/[A-Za-z0-9_.-]+$",
            "^/api/artifacts/[a-fA-F0-9]+$",
            "^/api/files/(?:gateway|agents/[^/?#]+)/download$",
            "^/api/hub/v1/(?:sessions/[^/?#]+|shared/[^/?#]+/sessions/[^/?#]+)/messages/[^/?#]+/media/[a-f0-9]{64}$"
        ]
        return patterns.contains { path.range(of: $0, options: .regularExpression) != nil }
    }

    static func httpRules(for endpoint: Endpoint) -> String {
        var rules: [[String: Any]] = [["trigger": ["url-filter": "^http://"], "action": ["type": "block"]]]
        if endpoint.isLocal && endpoint.url.scheme == "http" {
            let origin = NSRegularExpression.escapedPattern(for: endpoint.origin) + (endpoint.url.port == nil ? "(:80)?" : "")
            rules.append(["trigger": ["url-filter": "^" + origin + "/"],
                          "action": ["type": "ignore-previous-rules"]])
        }
        let data = try! JSONSerialization.data(withJSONObject: rules)
        return String(decoding: data, as: UTF8.self)
    }
}

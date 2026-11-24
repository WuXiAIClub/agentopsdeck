import Foundation

struct Endpoint: Equatable {
    let url: URL

    init?(_ value: String, allowLocalHTTP: Bool = false) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              scheme == "https" || (allowLocalHTTP && scheme == "http"),
              let host = components.host, !host.isEmpty,
              !host.contains("%"),
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/",
              components.port.map({ (1...65535).contains($0) }) ?? true else { return nil }
        guard scheme != "http" || Self.isLocalHost(host) else { return nil }
        components.scheme = scheme
        components.host = host.lowercased()
        components.path = "/"
        if components.port == (scheme == "https" ? 443 : 80) { components.port = nil }
        guard let url = components.url else { return nil }
        self.url = url
    }

    var isLocal: Bool { Self.isLocalHost(url.host ?? "") }

    var origin: String { String(url.absoluteString.dropLast()) }

    private static func isLocalHost(_ value: String) -> Bool {
        let host = value.lowercased()
        if host.hasSuffix(".local") {
            let labels = host.split(separator: ".", omittingEmptySubsequences: false)
            return labels.count >= 2 && labels.allSatisfy { label in
                !label.isEmpty && label.count <= 63 && label.first != "-" && label.last != "-" &&
                    label.utf8.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }
            }
        }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        let octets = parts.compactMap { part -> Int? in
            guard !part.isEmpty, part.utf8.allSatisfy({ (48...57).contains($0) }),
                  let number = Int(part), (0...255).contains(number), String(number) == part else { return nil }
            return number
        }
        guard octets.count == 4 else { return false }
        return octets[0] == 10 || (octets[0] == 172 && (16...31).contains(octets[1])) ||
            (octets[0] == 192 && octets[1] == 168)
    }

    func contains(_ candidate: URL) -> Bool {
        guard let components = URLComponents(url: candidate, resolvingAgainstBaseURL: false),
              components.user == nil, components.password == nil else { return false }
        return candidate.scheme?.lowercased() == url.scheme &&
            candidate.host?.lowercased() == url.host?.lowercased() &&
            (candidate.port ?? (candidate.scheme?.lowercased() == "http" ? 80 : 443)) ==
            (url.port ?? (url.scheme == "http" ? 80 : 443))
    }

    func permitsDownload(_ candidate: URL) -> Bool {
        if candidate.scheme?.lowercased() == "blob" {
            guard let source = URL(string: String(candidate.absoluteString.dropFirst(5))) else { return false }
            return contains(source)
        }
        return contains(candidate)
    }
}

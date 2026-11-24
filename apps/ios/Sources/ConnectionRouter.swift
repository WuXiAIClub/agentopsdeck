import Foundation
import CoreFoundation

struct ConnectionSettings {
    let publicEndpoint: Endpoint
    var localEndpoints: [Endpoint]

    private var storageKey: String { "agentopsdeck.localEndpoints." + publicEndpoint.origin }

    init(publicEndpoint: Endpoint, defaults: UserDefaults = .standard) {
        self.publicEndpoint = publicEndpoint
        let values = defaults.stringArray(forKey: "agentopsdeck.localEndpoints." + publicEndpoint.origin) ?? []
        localEndpoints = Array(values.compactMap { Endpoint($0, allowLocalHTTP: true) }.filter(\.isLocal).prefix(3))
    }

    func save(defaults: UserDefaults = .standard) {
        defaults.set(localEndpoints.map { $0.url.absoluteString }, forKey: storageKey)
    }

    static func parseLocalEndpoints(_ input: String) -> [Endpoint]? {
        let values = input.components(separatedBy: CharacterSet(charactersIn: ",，;； \n\t"))
            .filter { !$0.isEmpty }
        guard values.count <= 3 else { return nil }
        var result: [Endpoint] = []
        for value in values {
            guard let endpoint = Endpoint(value, allowLocalHTTP: true), endpoint.isLocal else { return nil }
            if !result.contains(endpoint) { result.append(endpoint) }
        }
        return result
    }
}

struct RoutePolicy {
    static func select(current: Endpoint?, settings: ConnectionSettings, wifi: Bool,
                       probe: (Endpoint) async -> Bool) async -> Endpoint {
        for candidate in candidates(current: current, configured: settings.localEndpoints, wifi: wifi) {
            if Task.isCancelled { break }
            if await probe(candidate) { return candidate }
        }
        return settings.publicEndpoint
    }

    static func candidates(current: Endpoint?, configured: [Endpoint], wifi: Bool) -> [Endpoint] {
        guard wifi else { return [] }
        if let current, configured.contains(current) {
            return [current] + configured.filter { $0 != current }
        }
        return configured
    }

    private var lastSuggestion: String?

    mutating func shouldOffer(current: Endpoint, selected: Endpoint) -> Bool {
        guard current != selected else { lastSuggestion = nil; return false }
        let pair = current.origin + " -> " + selected.origin
        guard pair != lastSuggestion else { return false }
        lastSuggestion = pair
        return true
    }
}

final class ServerProbe: NSObject, URLSessionTaskDelegate {
    static func validResponse(_ data: Data, response: HTTPURLResponse) -> Bool {
        guard response.statusCode == 200, response.mimeType?.lowercased() == "application/json",
              data.count <= 8192,
              let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let authenticated = body["authenticated"] as? NSNumber,
              CFGetTypeID(authenticated) == CFBooleanGetTypeID(),
              body["passkeys"] is [String: Any] else { return false }
        return true
    }

    func reachable(_ endpoint: Endpoint) async -> Bool {
        guard endpoint.isLocal, !Task.isCancelled else { return false }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 2
        configuration.timeoutIntervalForResource = 3
        configuration.allowsCellularAccess = false
        configuration.allowsExpensiveNetworkAccess = false
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: endpoint.url.appendingPathComponent("api/auth/status"))
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (bytes, response) = try await session.bytes(for: request)
            guard let response = response as? HTTPURLResponse, response.url.map(endpoint.contains) == true,
                  response.statusCode == 200, response.mimeType?.lowercased() == "application/json" else { return false }
            var data = Data()
            for try await byte in bytes {
                guard data.count < 8192, !Task.isCancelled else { return false }
                data.append(byte)
            }
            return Self.validResponse(data, response: response)
        } catch { return false }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

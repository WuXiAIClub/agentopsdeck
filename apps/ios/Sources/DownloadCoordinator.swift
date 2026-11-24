import UIKit
import WebKit

final class DownloadCoordinator: NSObject, URLSessionDataDelegate, WKHTTPCookieStoreObserver {
    private final class Transfer {
        let identifier = UUID()
        var task: URLSessionDataTask?
        var handle: FileHandle?
        var directory: URL?
        var file: URL?
        var expectedBytes: Int64?
        var bytes: Int64 = 0
        var redirects = 0
        var cookies: [HTTPCookie] = []
        let started = Date()
    }

    private struct Share {
        let file: URL
        let directory: URL
        let bytes: Int64
    }

    static let maxFileBytes: Int64 = 64 * 1024 * 1024
    static let maxTotalBytes: Int64 = 128 * 1024 * 1024
    static let maxTransfers = 2
    static let maxPendingShares = 2
    private static var cleanedStartup = false

    private let endpoint: Endpoint
    private weak var presenter: UIViewController?
    private var transfers: [UUID: Transfer] = [:]
    private var pendingShares: [Share] = []
    private var activeShare: Share?
    private var failedCleanupBytes: [URL: Int64] = [:]
    private var retainedFailedCleanupBytes: Int64 { failedCleanupBytes.values.reduce(0, +) }
    private weak var shareController: UIActivityViewController?
    private var cancelled = false
    private var monitor: Timer?
    private var session: URLSession?
    private var cookieStore: WKHTTPCookieStore?
    private let root: URL

    init(endpoint: Endpoint, presenter: UIViewController) {
        self.endpoint = endpoint
        self.presenter = presenter
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("AgentOpsDeckDownloads", isDirectory: true)
        root = base.appendingPathComponent(UUID().uuidString, isDirectory: true)
        super.init()
        if !Self.cleanedStartup {
            try? FileManager.default.removeItem(at: base)
            Self.cleanedStartup = true
        }
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        monitor = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.checkTransfers() }
    }

    deinit {
        monitor?.invalidate()
        cookieStore?.remove(self)
    }

    private var reservedBytes: Int64 {
        Int64(transfers.count) * Self.maxFileBytes + pendingShares.reduce(0) { $0 + $1.bytes } + (activeShare?.bytes ?? 0) + retainedFailedCleanupBytes
    }

    private func directoryBytes(_ directory: URL) -> Int64 {
        guard let enumerator = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: [.fileSizeKey]) else { return 0 }
        var total: Int64 = 0
        for case let file as URL in enumerator {
            if let size = (try? file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize {
                total += Int64(size)
            }
        }
        return total
    }

    private func removeDirectory(_ directory: URL, fallbackBytes: Int64 = 0) {
        let measured = max(fallbackBytes, directoryBytes(directory))
        do {
            try FileManager.default.removeItem(at: directory)
            failedCleanupBytes.removeValue(forKey: directory)
        } catch {
            if FileManager.default.fileExists(atPath: directory.path) {
                failedCleanupBytes[directory] = max(measured, directoryBytes(directory), 1)
            } else {
                failedCleanupBytes.removeValue(forKey: directory)
            }
        }
    }

    private func retryFailedCleanups() {
        for (directory, bytes) in Array(failedCleanupBytes) {
            removeDirectory(directory, fallbackBytes: bytes)
        }
    }

    func attach(_ download: WKDownload, cookieStore: WKHTTPCookieStore) {
        download.cancel { _ in }
        retryFailedCleanups()
        guard !cancelled, transfers.count < Self.maxTransfers,
              pendingShares.count + transfers.count + (activeShare == nil ? 0 : 1) < Self.maxPendingShares,
              reservedBytes <= Self.maxTotalBytes - Self.maxFileBytes,
              let original = download.originalRequest, let url = original.url, endpoint.contains(url),
              (original.httpMethod ?? "GET") == "GET", original.httpBody == nil, original.httpBodyStream == nil,
              self.cookieStore == nil || self.cookieStore === cookieStore else {
            if !cancelled { showFailure() }
            return
        }
        if self.cookieStore == nil {
            self.cookieStore = cookieStore
            cookieStore.add(self)
        }
        let transfer = Transfer()
        transfers[transfer.identifier] = transfer
        cookieStore.getAllCookies { [weak self, weak transfer] cookies in
            guard let self, let transfer, !self.cancelled,
                  self.transfers[transfer.identifier] === transfer else { return }
            transfer.cookies = cookies
            guard let request = self.request(for: url, original: original, transfer: transfer) else {
                self.fail(transfer)
                return
            }
            if self.session == nil {
                let configuration = URLSessionConfiguration.ephemeral
                configuration.urlCache = nil
                configuration.httpCookieStorage = nil
                configuration.httpShouldSetCookies = false
                configuration.urlCredentialStorage = nil
                configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
                configuration.timeoutIntervalForRequest = 15
                configuration.timeoutIntervalForResource = 300
                self.session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
            }
            guard let task = self.session?.dataTask(with: request) else { self.fail(transfer); return }
            task.taskDescription = transfer.identifier.uuidString
            transfer.task = task
            task.resume()
        }
    }

    private func request(for url: URL, original: URLRequest, transfer: Transfer) -> URLRequest? {
        guard !cancelled, endpoint.contains(url) else { return nil }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        request.httpMethod = "GET"
        request.httpShouldHandleCookies = false
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        for name in ["Accept", "Authorization"] {
            request.setValue(original.value(forHTTPHeaderField: name), forHTTPHeaderField: name)
        }
        let cookies = transfer.cookies.filter { cookie in
            let host = url.host?.lowercased() ?? ""
            let domain = cookie.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
            let path = url.path.isEmpty ? "/" : url.path
            return (host == domain || (cookie.domain.hasPrefix(".") && host.hasSuffix("." + domain))) &&
                (path == cookie.path || path.hasPrefix(cookie.path.hasSuffix("/") ? cookie.path : cookie.path + "/")) &&
                (!cookie.isSecure || url.scheme == "https") && (cookie.expiresDate.map { $0 > Date() } ?? true) &&
                (cookie.portList.map { $0.contains(NSNumber(value: url.port ?? (url.scheme == "https" ? 443 : 80))) } ?? true)
        }.sorted { $0.path.count > $1.path.count }
        request.setValue(HTTPCookie.requestHeaderFields(with: cookies)["Cookie"], forHTTPHeaderField: "Cookie")
        return request
    }

    func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
        guard self.cookieStore === cookieStore else { return }
        cancelWork()
    }

    func cancelAll() {
        cancelled = true
        monitor?.invalidate()
        monitor = nil
        cookieStore?.remove(self)
        cookieStore = nil
        cancelWork()
    }

    private func cancelWork() {
        let active = Array(transfers.values)
        transfers.removeAll()
        for transfer in active {
            discard(transfer)
        }
        for share in pendingShares { removeDirectory(share.directory, fallbackBytes: share.bytes) }
        pendingShares.removeAll()
        if let share = activeShare { try? FileManager.default.removeItem(at: share.directory); removeDirectory(share.directory, fallbackBytes: share.bytes) }
        activeShare = nil
        shareController?.dismiss(animated: false)
        shareController = nil
        session?.invalidateAndCancel()
        session = nil
        removeDirectory(root, fallbackBytes: retainedFailedCleanupBytes)
        if !FileManager.default.fileExists(atPath: root.path) {
            failedCleanupBytes.removeAll()
        }
    }

    private func discard(_ transfer: Transfer) {
        transfer.task?.cancel()
        try? transfer.handle?.close()
        transfer.handle = nil
        if let directory = transfer.directory { removeDirectory(directory, fallbackBytes: transfer.bytes) }
    }

    private func fail(_ transfer: Transfer) {
        guard transfers.removeValue(forKey: transfer.identifier) != nil else { return }
        discard(transfer)
        invalidateIdleSession()
        if !cancelled { showFailure() }
    }

    private func invalidateIdleSession() {
        if transfers.isEmpty {
            session?.invalidateAndCancel()
            session = nil
        }
    }

    private func transfer(for task: URLSessionTask) -> Transfer? {
        guard !cancelled, let description = task.taskDescription, let identifier = UUID(uuidString: description),
              let transfer = transfers[identifier], transfer.task === task else { return nil }
        return transfer
    }

    private func fileBytes(_ file: URL) -> Int64? {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: file.path),
              let size = attributes[.size] as? NSNumber else { return nil }
        return size.int64Value
    }

    private func checkTransfers() {
        for transfer in Array(transfers.values) {
            if Date().timeIntervalSince(transfer.started) > 300 { fail(transfer) }
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let transfer = transfer(for: dataTask) else { completionHandler(.cancel); return }
        guard let responseURL = response.url, endpoint.contains(responseURL),
              let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode),
              response.expectedContentLength <= Self.maxFileBytes,
              (http.value(forHTTPHeaderField: "Content-Encoding") ?? "identity").lowercased() == "identity",
              transfer.handle == nil else {
            completionHandler(.cancel)
            fail(transfer)
            return
        }
        let directory = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
            let file = directory.appendingPathComponent(DownloadFileName.make(
                suggested: response.suggestedFilename ?? "download", mimeType: response.mimeType))
            transfer.directory = directory
            transfer.file = file
            guard FileManager.default.createFile(atPath: file.path, contents: nil,
                attributes: [.posixPermissions: 0o600, .protectionKey: FileProtectionType.complete]) else {
                throw CocoaError(.fileWriteUnknown)
            }
            transfer.handle = try FileHandle(forWritingTo: file)
            transfer.expectedBytes = response.expectedContentLength >= 0 ? response.expectedContentLength : nil
            completionHandler(.allow)
        } catch {
            completionHandler(.cancel)
            removeDirectory(directory, fallbackBytes: transfer.bytes)
            fail(transfer)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let transfer = transfer(for: dataTask) else { dataTask.cancel(); return }
        let count = Int64(data.count)
        guard count <= Self.maxFileBytes - transfer.bytes,
              count <= (transfer.expectedBytes ?? Self.maxFileBytes) - transfer.bytes,
              reservedBytes <= Self.maxTotalBytes, let handle = transfer.handle else {
            fail(transfer)
            return
        }
        do {
            try handle.write(contentsOf: data)
            transfer.bytes += count
        } catch { fail(transfer) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest proposed: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard let transfer = transfer(for: task) else { completionHandler(nil); task.cancel(); return }
        guard transfer.redirects < 3, [301, 302, 303, 307, 308].contains(response.statusCode),
              let url = proposed.url, endpoint.contains(url), let original = task.originalRequest,
              let request = request(for: url, original: original, transfer: transfer) else {
            completionHandler(nil)
            fail(transfer)
            return
        }
        transfer.redirects += 1
        completionHandler(request)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard transfer(for: task) != nil,
              challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        completionHandler(.performDefaultHandling, nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, willCacheResponse proposedResponse: CachedURLResponse,
                    completionHandler: @escaping (CachedURLResponse?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let transfer = transfer(for: task) else { return }
        guard error == nil, let file = transfer.file, let directory = transfer.directory, let handle = transfer.handle else {
            fail(transfer)
            return
        }
        do { try handle.close(); transfer.handle = nil }
        catch { fail(transfer); return }
        transfers.removeValue(forKey: transfer.identifier)
        invalidateIdleSession()
        retryFailedCleanups()
        guard !cancelled, let bytes = fileBytes(file), bytes == transfer.bytes, bytes <= Self.maxFileBytes,
              (transfer.expectedBytes.map { bytes == $0 } ?? true),
              pendingShares.count + (activeShare == nil ? 0 : 1) < Self.maxPendingShares,
              reservedBytes <= Self.maxTotalBytes - bytes else {
            removeDirectory(directory, fallbackBytes: transfer.bytes)
            if !cancelled { showFailure() }
            return
        }
        pendingShares.append(Share(file: file, directory: directory, bytes: bytes))
        shareNext()
    }

    func shareNext() {
        retryFailedCleanups()
        guard !cancelled, activeShare == nil, !pendingShares.isEmpty, let presenter,
              presenter.presentedViewController == nil, presenter.viewIfLoaded?.window != nil else { return }
        let share = pendingShares.removeFirst()
        let controller = UIActivityViewController(activityItems: [share.file], applicationActivities: nil)
        controller.popoverPresentationController?.sourceView = presenter.view
        controller.popoverPresentationController?.sourceRect = CGRect(
            x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 1, height: 1)
        controller.completionWithItemsHandler = { [weak self] _, _, _, _ in
            self?.removeDirectory(share.directory, fallbackBytes: share.bytes)
            if self == nil { try? FileManager.default.removeItem(at: share.directory) }
            guard let self, self.activeShare?.directory == share.directory else { return }
            self.activeShare = nil
            self.shareController = nil
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.shareNext() }
        }
        activeShare = share
        shareController = controller
        presenter.present(controller, animated: true)
    }

    private func showFailure() {
        guard let presenter, presenter.presentedViewController == nil else { return }
        let alert = UIAlertController(title: NSLocalizedString("download_failed_title", comment: ""),
            message: NSLocalizedString("download_failed_message", comment: ""), preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: NSLocalizedString("ok", comment: ""), style: .default))
        presenter.present(alert, animated: true)
    }
}

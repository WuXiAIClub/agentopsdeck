import UIKit
import WebKit
import Network

final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private let endpointKey = "agentopsdeck.endpoint"
    private var endpoint: Endpoint?
    private var settings: ConnectionSettings?
    private let networkMonitor = NWPathMonitor()
    private var wifi = false
    private var networkReady = false
    private var routeTask: Task<Void, Never>?
    private var routeGeneration = UUID()
    private var routePolicy = RoutePolicy()
    private var reconnectRequested = false
    private var pageLoaded = false
    private var clearingData = false
    private var webView: WKWebView?
    private var downloads: DownloadCoordinator?
    private var observations: [NSKeyValueObservation] = []
    private let progress = UIProgressView(progressViewStyle: .bar)
    private let statusLabel = UILabel()
    private let retryButton = UIButton(type: .system)
    private let statusStack = UIStackView()
    private lazy var backButton = UIBarButtonItem(
        image: UIImage(systemName: "chevron.left"), style: .plain, target: self, action: #selector(goBack))

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "AgentOpsDeck"
        view.backgroundColor = .systemBackground
        navigationItem.leftBarButtonItem = backButton
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            image: UIImage(systemName: "ellipsis.circle"), menu: UIMenu(children: [
                UIAction(title: "服务地址", image: UIImage(systemName: "network")) { [weak self] _ in self?.editEndpoint() },
                UIAction(title: "局域网优先", image: UIImage(systemName: "wifi")) { [weak self] _ in self?.editLocalEndpoints() },
                UIAction(title: "重新加载", image: UIImage(systemName: "arrow.clockwise")) { [weak self] _ in
                    self?.confirmReload()
                },
                UIAction(title: "在浏览器打开", image: UIImage(systemName: "safari")) { [weak self] _ in
                    guard let self, let url = self.endpoint?.url else { return }
                    UIApplication.shared.open(url)
                },
                UIAction(title: "清除登录与缓存", image: UIImage(systemName: "trash"), attributes: .destructive) { [weak self] _ in
                    self?.clearWebsiteData()
                },
                UIAction(title: NSLocalizedString("cancel_downloads", comment: ""), image: UIImage(systemName: "xmark.circle")) { [weak self] _ in
                    guard let self, let endpoint = self.endpoint else { return }
                    self.downloads?.cancelAll()
                    self.downloads = DownloadCoordinator(endpoint: endpoint, presenter: self)
                },
                UIAction(title: "关于", image: UIImage(systemName: "info.circle")) { [weak self] _ in self?.showAbout() }
            ]))
        backButton.isEnabled = false
        progress.translatesAutoresizingMaskIntoConstraints = false
        progress.isHidden = true
        view.addSubview(progress)
        statusLabel.numberOfLines = 0
        statusLabel.textAlignment = .center
        statusLabel.textColor = .secondaryLabel
        retryButton.setTitle("重试", for: .normal)
        retryButton.addTarget(self, action: #selector(retry), for: .touchUpInside)
        statusStack.axis = .vertical
        statusStack.spacing = 16
        statusStack.addArrangedSubview(statusLabel)
        statusStack.addArrangedSubview(retryButton)
        statusStack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(statusStack)
        NSLayoutConstraint.activate([
            progress.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            progress.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            progress.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            statusStack.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor),
            statusStack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 28),
            statusStack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -28)
        ])
        if let saved = UserDefaults.standard.string(forKey: endpointKey), let configured = Endpoint(saved) {
            settings = ConnectionSettings(publicEndpoint: configured)
            showStatus("正在选择连接…", retry: false)
        } else {
            showStatus("请先配置你自己的 AgentOpsDeck HTTPS 服务地址。", retry: false)
        }
        networkMonitor.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async {
                guard let self else { return }
                self.wifi = path.status == .satisfied && path.usesInterfaceType(.wifi)
                self.networkReady = true
                self.selectConnection(automatic: self.endpoint == nil)
            }
        }
        networkMonitor.start(queue: DispatchQueue(label: "AgentOpsDeck.NetworkPath"))
        NotificationCenter.default.addObserver(self, selector: #selector(becameActive),
                                               name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if settings == nil && presentedViewController == nil { editEndpoint() }
        downloads?.shareNext()
    }

    deinit {
        downloads?.cancelAll()
        routeTask?.cancel()
        networkMonitor.cancel()
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func becameActive() { selectConnection(automatic: endpoint == nil) }

    private func selectConnection(automatic: Bool) {
        guard let settings, networkReady, !clearingData else { return }
        if automatic { reconnectRequested = true }
        let reconnect = reconnectRequested
        if reconnect { showStatus("正在检测连接，优先使用可达的局域网服务…", retry: false) }
        routeTask?.cancel()
        let generation = UUID()
        routeGeneration = generation
        let current = endpoint
        let wifi = self.wifi
        routeTask = Task { [weak self] in
            let probe = ServerProbe()
            let selected = await RoutePolicy.select(current: current, settings: settings, wifi: wifi,
                                                    probe: { await probe.reachable($0) })
            guard !Task.isCancelled, let self, self.routeGeneration == generation else { return }
            if reconnect || self.endpoint == nil {
                self.reconnectRequested = false
                self.configure(selected)
            } else if let current = self.endpoint {
                if current == selected {
                    _ = self.routePolicy.shouldOffer(current: current, selected: selected)
                    return
                }
                guard UIApplication.shared.applicationState == .active, self.presentedViewController == nil,
                      self.routePolicy.shouldOffer(current: current, selected: selected) else { return }
                let alert = UIAlertController(title: "连接方式已变化", message:
                    "可切换到 \(selected.origin)。切换会关闭当前页面，未发送的输入可能丢失；不会自动重发消息或操作。", preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "暂不切换", style: .cancel))
                alert.addAction(UIAlertAction(title: "切换", style: .default) { [weak self] _ in
                    self?.selectConnection(automatic: true)
                })
                self.present(alert, animated: true)
            }
        }
    }

    private func configure(_ configured: Endpoint) {
        guard let settings else { return }
        routeTask?.cancel()
        routeGeneration = UUID()
        observations.removeAll()
        downloads?.cancelAll()
        webView?.stopLoading()
        webView?.navigationDelegate = nil
        webView?.uiDelegate = nil
        webView?.removeFromSuperview()
        endpoint = configured
        pageLoaded = false
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        guard let scriptURL = Bundle.main.url(forResource: "ResourceRouting", withExtension: "js"),
              let script = try? String(contentsOf: scriptURL, encoding: .utf8),
              let data = try? JSONSerialization.data(withJSONObject: [
                "currentOrigin": configured.origin,
                "publicOrigin": settings.publicEndpoint.origin,
                "localOrigins": settings.localEndpoints.map(\.origin)
              ]), let arguments = String(data: data, encoding: .utf8) else {
            showStatus("客户端媒体路由资源缺失，请重新安装。", retry: false)
            return
        }
        configuration.userContentController.addUserScript(WKUserScript(
            source: script + "\nAgentOpsDeckResources.install(" + arguments + ");",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let browser = WKWebView(frame: .zero, configuration: configuration)
        browser.navigationDelegate = self
        browser.uiDelegate = self
        browser.allowsBackForwardNavigationGestures = true
        browser.translatesAutoresizingMaskIntoConstraints = false
        view.insertSubview(browser, at: 0)
        NSLayoutConstraint.activate([
            browser.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            browser.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            browser.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            browser.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor)
        ])
        webView = browser
        downloads = DownloadCoordinator(endpoint: configured, presenter: self)
        observations = [
            browser.observe(\.estimatedProgress, options: [.new]) { [weak self] browser, _ in
                self?.progress.setProgress(Float(browser.estimatedProgress), animated: true)
                self?.progress.isHidden = !browser.isLoading
            },
            browser.observe(\.canGoBack, options: [.new]) { [weak self] browser, _ in
                self?.backButton.isEnabled = browser.canGoBack
            }
        ]
        backButton.isEnabled = false
        showStatus("正在连接 \(configured.origin)…", retry: false)
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "AgentOpsDeck.HTTPPolicy",
            encodedContentRuleList: ResourceAddress.httpRules(for: configured)) { [weak self, weak browser] rules, _ in
            DispatchQueue.main.async {
                guard let self, let browser, self.webView === browser else { return }
                guard let rules else {
                    self.showStatus("无法初始化网络安全规则，请重试。", retry: true)
                    return
                }
                browser.configuration.userContentController.add(rules)
                self.loadHome()
            }
        }
    }

    private func loadHome() {
        guard let endpoint else { return }
        statusStack.isHidden = true
        webView?.isHidden = false
        progress.progress = 0
        webView?.load(URLRequest(url: endpoint.url, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 30))
    }

    @objc private func goBack() { webView?.goBack() }

    @objc private func retry() { selectConnection(automatic: true) }

    private func showStatus(_ message: String, retry: Bool) {
        statusLabel.text = message
        retryButton.isHidden = !retry
        statusStack.isHidden = false
        webView?.isHidden = true
        progress.isHidden = true
    }

    private func editEndpoint() {
        let alert = UIAlertController(title: "服务地址", message:
            "填写你自己的 HTTPS 根地址，可包含端口。不包含 key、路径或登录信息。更改地址会关闭当前页面，未发送的内容不会保留。", preferredStyle: .alert)
        alert.addTextField { [weak self] field in
            field.placeholder = "https://your-agentopsdeck.example"
            field.text = self?.settings?.publicEndpoint.url.absoluteString
            field.keyboardType = .URL
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
            field.textContentType = .URL
        }
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { [weak self] _ in self?.resumeShares() })
        alert.addAction(UIAlertAction(title: "连接", style: .default) { [weak self, weak alert] _ in
            guard let self else { return }
            guard let configured = Endpoint(alert?.textFields?.first?.text ?? "") else {
                self.showMessage("地址无效", "请使用 https://域名 或 https://域名:端口，不要填写路径、key 或账号密码。")
                return
            }
            self.settings = ConnectionSettings(publicEndpoint: configured)
            UserDefaults.standard.set(configured.url.absoluteString, forKey: self.endpointKey)
            self.routePolicy = RoutePolicy()
            self.selectConnection(automatic: true)
        })
        present(alert, animated: true)
    }

    private func editLocalEndpoints() {
        guard let settings else { editEndpoint(); return }
        let alert = UIAlertController(title: "局域网优先", message:
            "当前：\(endpoint?.origin ?? "未连接")\n填写最多 3 个可信电脑的完整内网根地址，以逗号分隔；支持私有 IPv4 或 .local 主机名。只在 Wi-Fi 下探测，不扫描网络。HTTP 不加密，请确认地址属于同一台 AgentOpsDeck 服务；首次内网连接需单独登录，不复制公网凭据。保存后关闭当前页面重新连接。", preferredStyle: .alert)
        alert.addTextField { field in
            field.placeholder = "http://your-computer.local:8790"
            field.text = settings.localEndpoints.map(\.origin).joined(separator: ", ")
            field.keyboardType = .URL
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
        }
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { [weak self] _ in self?.resumeShares() })
        alert.addAction(UIAlertAction(title: "关闭局域网优先", style: .destructive) { [weak self] _ in
            self?.saveLocalEndpoints([])
        })
        alert.addAction(UIAlertAction(title: "信任并连接", style: .default) { [weak self, weak alert] _ in
            guard let self else { return }
            guard let endpoints = ConnectionSettings.parseLocalEndpoints(alert?.textFields?.first?.text ?? "") else {
                self.showMessage("内网地址无效", "最多 3 个私有 IPv4 或 .local 根地址；需包含 http:// 或 https://，可带端口，不能包含路径、账号或 key。")
                return
            }
            self.saveLocalEndpoints(endpoints)
        })
        present(alert, animated: true)
    }

    private func saveLocalEndpoints(_ endpoints: [Endpoint]) {
        settings?.localEndpoints = endpoints
        settings?.save()
        routePolicy = RoutePolicy()
        selectConnection(automatic: true)
    }

    private func confirmReload() {
        let alert = UIAlertController(title: "重新加载？", message: "未发送的输入可能丢失。后台正在进行的任务不受影响。", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { [weak self] _ in self?.resumeShares() })
        alert.addAction(UIAlertAction(title: "重新加载", style: .default) { [weak self] _ in
            self?.selectConnection(automatic: true)
            self?.resumeShares()
        })
        present(alert, animated: true)
    }

    private func clearWebsiteData() {
        let alert = UIAlertController(title: "清除登录与缓存？", message:
            "清除本 App 所有服务地址的 Cookie、网页缓存和本地聊天缓存。不会删除服务端聊天记录，也不会注销其他设备。", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { [weak self] _ in self?.resumeShares() })
        alert.addAction(UIAlertAction(title: "清除", style: .destructive) { [weak self] _ in
            guard let self else { return }
            self.clearingData = true
            self.routeTask?.cancel()
            self.routeGeneration = UUID()
            self.downloads?.cancelAll()
            self.webView?.stopLoading()
            self.webView?.navigationDelegate = nil
            self.webView?.uiDelegate = nil
            self.webView?.removeFromSuperview()
            self.webView = nil
            self.observations.removeAll()
            self.showStatus("正在清除本地数据…", retry: false)
            self.navigationItem.rightBarButtonItem?.isEnabled = false
            WKWebsiteDataStore.default().removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {
                DispatchQueue.main.async {
                    self.navigationItem.rightBarButtonItem?.isEnabled = true
                    self.clearingData = false
                    self.selectConnection(automatic: true)
                }
            }
        })
        present(alert, animated: true)
    }

    private func showAbout() {
        let version = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? ""
        showMessage("AgentOpsDeck iOS \(version)", "复用你配置的网页与后端。登录信息、网页聊天缓存保存在本机；不包含内置服务地址或登录 key。")
    }

    private func showMessage(_ title: String, _ message: String) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default) { [weak self] _ in self?.resumeShares() })
        present(alert, animated: true)
    }

    private func resumeShares() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.downloads?.shareNext() }
    }

    private func openExternal(_ url: URL) {
        guard ["https", "http", "mailto", "tel"].contains(url.scheme?.lowercased() ?? ""),
              url.user == nil, url.password == nil else { return }
        UIApplication.shared.open(url)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard webView === self.webView else { decisionHandler(.cancel); return }
        guard let url = navigationAction.request.url, let endpoint else { decisionHandler(.cancel); return }
        if let settings, navigationAction.targetFrame?.isMainFrame != false,
           (navigationAction.request.httpMethod ?? "GET") == "GET" {
            let routed = ResourceAddress.route(url, current: endpoint, settings: settings)
            if routed != url {
                decisionHandler(.cancel)
                let request = URLRequest(url: routed)
                if navigationAction.shouldPerformDownload {
                    let coordinator = downloads
                    let cookieStore = webView.configuration.websiteDataStore.httpCookieStore
                    webView.startDownload(using: request) { download in
                        if let coordinator { coordinator.attach(download, cookieStore: cookieStore) }
                        else { download.cancel { _ in } }
                    }
                } else { webView.load(request) }
                return
            }
        }
        if navigationAction.shouldPerformDownload {
            decisionHandler(endpoint.permitsDownload(url) ? .download : .cancel)
            return
        }
        if navigationAction.targetFrame?.isMainFrame == false {
            decisionHandler(endpoint.contains(url) || url.scheme?.lowercased() == "about" || url.scheme?.lowercased() == "blob" ? .allow : .cancel)
            return
        }
        if endpoint.contains(url) { decisionHandler(.allow); return }
        decisionHandler(.cancel)
        if navigationAction.navigationType == .linkActivated { openExternal(url) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard webView === self.webView else { decisionHandler(.cancel); return }
        guard let url = navigationResponse.response.url, let endpoint else { decisionHandler(.cancel); return }
        let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        if disposition.lowercased().hasPrefix("attachment") || !navigationResponse.canShowMIMEType {
            decisionHandler(endpoint.permitsDownload(url) ? .download : .cancel)
            return
        }
        decisionHandler(endpoint.contains(url) ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        guard webView === self.webView else { download.cancel { _ in }; return }
        guard let downloads else { download.cancel { _ in }; return }
        downloads.attach(download, cookieStore: webView.configuration.websiteDataStore.httpCookieStore)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        guard webView === self.webView else { download.cancel { _ in }; return }
        guard let downloads else { download.cancel { _ in }; return }
        downloads.attach(download, cookieStore: webView.configuration.websiteDataStore.httpCookieStore)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        guard webView === self.webView else { return }
        progress.isHidden = false
        statusStack.isHidden = true
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === self.webView else { return }
        pageLoaded = true
        progress.isHidden = true
        statusStack.isHidden = true
        webView.isHidden = false
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard webView === self.webView else { return }
        handleNavigationError(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard webView === self.webView else { return }
        handleNavigationError(error)
    }

    private func handleNavigationError(_ error: Error) {
        let failure = error as NSError
        if failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled { return }
        if failure.domain == "WebKitErrorDomain" && failure.code == 102 { return }
        if !pageLoaded, let settings, let endpoint, settings.localEndpoints.contains(endpoint) {
            configure(settings.publicEndpoint)
            return
        }
        showStatus("无法连接服务。请检查地址、网络、HTTPS 证书及系统设置中的本地网络权限，然后重试。", retry: true)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard webView === self.webView else { return }
        showStatus("页面进程已被系统回收，点击重试恢复。", retry: true)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard webView === self.webView else { return nil }
        guard let url = navigationAction.request.url else { return nil }
        if endpoint?.contains(url) == true { webView.load(navigationAction.request) }
        else if navigationAction.navigationType == .linkActivated { openExternal(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard webView === self.webView else { completionHandler(); return }
        guard frame.request.url.map({ endpoint?.contains($0) == true }) == true,
              presentedViewController == nil else { completionHandler(); return }
        let alert = UIAlertController(title: "AgentOpsDeck", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default) { [weak self] _ in
            completionHandler()
            self?.resumeShares()
        })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard webView === self.webView else { completionHandler(false); return }
        guard frame.request.url.map({ endpoint?.contains($0) == true }) == true,
              presentedViewController == nil else { completionHandler(false); return }
        let alert = UIAlertController(title: "AgentOpsDeck", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { [weak self] _ in completionHandler(false); self?.resumeShares() })
        alert.addAction(UIAlertAction(title: "确定", style: .default) { [weak self] _ in completionHandler(true); self?.resumeShares() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        guard webView === self.webView else { completionHandler(nil); return }
        guard frame.request.url.map({ endpoint?.contains($0) == true }) == true,
              presentedViewController == nil else { completionHandler(nil); return }
        let alert = UIAlertController(title: "AgentOpsDeck", message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { [weak self] _ in completionHandler(nil); self?.resumeShares() })
        alert.addAction(UIAlertAction(title: "确定", style: .default) { [weak self, weak alert] _ in
            completionHandler(alert?.textFields?.first?.text)
            self?.resumeShares()
        })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        guard webView === self.webView else { decisionHandler(.deny); return }
        let trusted = origin.protocol == endpoint?.url.scheme &&
            origin.host.lowercased() == endpoint?.url.host?.lowercased() &&
            (origin.port == 0 ? (origin.protocol == "http" ? 80 : 443) : origin.port) ==
            (endpoint?.url.port ?? (endpoint?.url.scheme == "http" ? 80 : 443))
        decisionHandler(trusted && frame.isMainFrame ? .prompt : .deny)
    }
}

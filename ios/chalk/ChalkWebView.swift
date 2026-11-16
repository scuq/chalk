import SwiftUI
import UIKit
import WebKit

struct ChalkWebView: UIViewRepresentable {
    let server: URL
    let onFailure: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(server: server, onFailure: onFailure)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        let view = WKWebView(frame: .zero, configuration: config)
        context.coordinator.configure(view)
        view.load(URLRequest(url: server))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
        let serverOrigin: String?
        let onFailure: (String) -> Void
        private let isChild: Bool
        private weak var main: WKWebView?
        private var children: [Coordinator] = []
        private var downloads: [ObjectIdentifier: URL] = [:]

        init(server: URL, onFailure: @escaping (String) -> Void, isChild: Bool = false) {
            serverOrigin = ServerAddress.origin(of: server)
            self.onFailure = onFailure
            self.isChild = isChild
        }

        func configure(_ view: WKWebView) {
            view.isInspectable = true
            view.navigationDelegate = self
            view.uiDelegate = self
            view.allowsBackForwardNavigationGestures = false
            view.scrollView.contentInsetAdjustmentBehavior = .never
            if !isChild { main = view }
        }

        // MARK: navigation

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction
        ) async -> WKNavigationActionPolicy {
            if navigationAction.shouldPerformDownload { return .download }
            let target = navigationAction.request.url?.absoluteString ?? ""
            if let frame = navigationAction.targetFrame, !frame.isMainFrame { return .allow }
            let action = LinkRule.classify(target, serverOrigin: serverOrigin)
            let opensWindow = navigationAction.targetFrame == nil
            switch action {
            case .inApp:
                if opensWindow || isChild {
                    if let url = navigationAction.request.url { main?.load(URLRequest(url: url)) }
                    return .cancel
                }
                return .allow
            case .child:
                return opensWindow || isChild ? .allow : .cancel
            case .external:
                if let url = navigationAction.request.url { await UIApplication.shared.open(url) }
                return .cancel
            case .deny:
                return .cancel
            }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationResponse: WKNavigationResponse
        ) async -> WKNavigationResponsePolicy {
            if let http = navigationResponse.response as? HTTPURLResponse,
               let disposition = http.value(forHTTPHeaderField: "Content-Disposition"),
               disposition.lowercased().hasPrefix("attachment") {
                return .download
            }
            return navigationResponse.canShowMIMEType ? .allow : .download
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            guard !isChild else { return }
            let ns = error as NSError
            if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
            if ns.domain == "WebKitErrorDomain" && ns.code == 102 { return }
            onFailure(ns.localizedDescription)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.reload()
        }

        // MARK: downloads

        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
            download.delegate = self
        }

        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
            download.delegate = self
        }

        func download(
            _ download: WKDownload,
            decideDestinationUsing response: URLResponse,
            suggestedFilename: String
        ) async -> URL? {
            let folder = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString, isDirectory: true)
            do {
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            } catch {
                return nil
            }
            let name = suggestedFilename.isEmpty ? "download" : suggestedFilename
            let file = folder.appendingPathComponent(name)
            downloads[ObjectIdentifier(download)] = file
            return file
        }

        func downloadDidFinish(_ download: WKDownload) {
            guard let file = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
            let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
            if let anchor = Self.topController()?.view {
                sheet.popoverPresentationController?.sourceView = anchor
                sheet.popoverPresentationController?.sourceRect = CGRect(
                    x: anchor.bounds.midX, y: anchor.bounds.midY, width: 0, height: 0)
            }
            Self.topController()?.present(sheet, animated: true)
        }

        func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
            downloads.removeValue(forKey: ObjectIdentifier(download))
        }

        // MARK: permissions

        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping (WKPermissionDecision) -> Void
        ) {
            let port = origin.port == 0 ? "" : ":\(origin.port)"
            let requester = "\(origin.protocol)://\(origin.host.lowercased())\(port)"
            let same = origin.protocol == "https" && requester == serverOrigin
            decisionHandler(same ? .grant : .deny)
        }

        // MARK: child windows

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            let target = navigationAction.request.url?.absoluteString ?? ""
            switch LinkRule.classify(target, serverOrigin: serverOrigin) {
            case .child:
                break
            case .inApp:
                if let url = navigationAction.request.url { main?.load(URLRequest(url: url)) }
                return nil
            case .external:
                if let url = navigationAction.request.url { UIApplication.shared.open(url) }
                return nil
            case .deny:
                return nil
            }
            guard let presenter = Self.topController() else { return nil }
            let child = WKWebView(frame: .zero, configuration: configuration)
            let coordinator = Coordinator(server: URL(string: serverOrigin ?? "about:blank")!,
                                          onFailure: { _ in }, isChild: true)
            coordinator.main = main
            coordinator.configure(child)
            children.append(coordinator)
            let page = ChildWindowController(webView: child) { [weak self, weak coordinator] in
                self?.children.removeAll { $0 === coordinator }
            }
            presenter.present(UINavigationController(rootViewController: page), animated: true)
            return child
        }

        func webViewDidClose(_ webView: WKWebView) {
            guard isChild else { return }
            var node = webView.next
            while let responder = node, !(responder is ChildWindowController) { node = responder.next }
            (node as? UIViewController)?.dismiss(animated: true)
        }

        static func topController() -> UIViewController? {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            var top = scenes.flatMap(\.windows).first(where: \.isKeyWindow)?.rootViewController
            while let next = top?.presentedViewController { top = next }
            return top
        }
    }
}

final class ChildWindowController: UIViewController {
    private let webView: WKWebView
    private let onClose: () -> Void

    init(webView: WKWebView, onClose: @escaping () -> Void) {
        self.webView = webView
        self.onClose = onClose
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { nil }

    override func loadView() { view = webView }

    override func viewDidLoad() {
        super.viewDidLoad()
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            systemItem: .close,
            primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed || navigationController?.isBeingDismissed == true { onClose() }
    }
}

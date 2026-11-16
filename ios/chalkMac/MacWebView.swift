import AppKit
import SwiftUI
import WebKit

/// The web view that shows the page of the home server.
///
/// The rules match `ChalkWebView` of the iOS app: the page stays on the server origin,
/// other links open in the default browser, and only the server origin gets the camera and the microphone.
struct MacWebView: NSViewRepresentable {
    let server: URL
    let onFailure: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(server: server, onFailure: onFailure)
    }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.isElementFullscreenEnabled = true
        let view = WKWebView(frame: .zero, configuration: config)
        context.coordinator.configure(view)
        view.load(URLRequest(url: server))
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, NSWindowDelegate {
        let serverOrigin: String?
        let onFailure: (String) -> Void
        private let isChild: Bool
        private weak var main: WKWebView?
        // A window and the delegate of its web view stay alive here until the window closes.
        private var children: [ObjectIdentifier: (window: NSWindow, coordinator: Coordinator)] = [:]
        private var downloads: [ObjectIdentifier: URL] = [:]

        init(server: URL, onFailure: @escaping (String) -> Void, isChild: Bool = false) {
            serverOrigin = ServerAddress.origin(of: server)
            self.onFailure = onFailure
            self.isChild = isChild
        }

        func configure(_ view: WKWebView) {
            // Web Inspector works only in Debug builds. A release build must not be inspectable.
            #if DEBUG
            view.isInspectable = true
            #endif
            view.navigationDelegate = self
            view.uiDelegate = self
            view.allowsBackForwardNavigationGestures = false
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
                if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
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
            guard let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first else {
                return nil
            }
            let file = Self.freeName(in: folder, for: suggestedFilename)
            downloads[ObjectIdentifier(download)] = file
            return file
        }

        func downloadDidFinish(_ download: WKDownload) {
            guard let file = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
            NSWorkspace.shared.activateFileViewerSelecting([file])
        }

        func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
            downloads.removeValue(forKey: ObjectIdentifier(download))
        }

        // freeName returns a path in folder that no file has. WebKit fails a download to a path that exists.
        // The function uses only the last path component of suggested, so the file stays in folder.
        static func freeName(in folder: URL, for suggested: String) -> URL {
            let last = (suggested as NSString).lastPathComponent
            let name = last.isEmpty || last == "/" ? "download" : last
            let first = folder.appendingPathComponent(name)
            if !FileManager.default.fileExists(atPath: first.path) { return first }
            let ext = first.pathExtension
            let stem = first.deletingPathExtension().lastPathComponent
            for n in 2...999 {
                let next = ext.isEmpty ? "\(stem) \(n)" : "\(stem) \(n).\(ext)"
                let file = folder.appendingPathComponent(next)
                if !FileManager.default.fileExists(atPath: file.path) { return file }
            }
            return folder.appendingPathComponent(UUID().uuidString + "-" + name)
        }

        // MARK: permissions

        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping (WKPermissionDecision) -> Void
        ) {
            let same = origin.protocol == "https" && originString(origin) == serverOrigin
            decisionHandler(same ? .grant : .deny)
        }

        // MARK: file selection

        // On macOS, a file input of the page does nothing without this method.
        func webView(
            _ webView: WKWebView,
            runOpenPanelWith parameters: WKOpenPanelParameters,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping ([URL]?) -> Void
        ) {
            let panel = NSOpenPanel()
            panel.allowsMultipleSelection = parameters.allowsMultipleSelection
            panel.canChooseDirectories = parameters.allowsDirectories
            panel.canChooseFiles = true
            let done: (NSApplication.ModalResponse) -> Void = { response in
                completionHandler(response == .OK ? panel.urls : nil)
            }
            if let window = webView.window {
                panel.beginSheetModal(for: window, completionHandler: done)
            } else {
                panel.begin(completionHandler: done)
            }
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
                if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
                return nil
            case .deny:
                return nil
            }
            // The size limits match parseWindowFeatures in desktop/src/links.ts.
            let width = Self.clamp(windowFeatures.width?.doubleValue, fallback: 480)
            let height = Self.clamp(windowFeatures.height?.doubleValue, fallback: 360)
            let child = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: configuration)
            let coordinator = Coordinator(server: URL(string: serverOrigin ?? "about:blank")!,
                                          onFailure: { _ in }, isChild: true)
            coordinator.main = main
            coordinator.configure(child)
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                styleMask: [.titled, .closable, .miniaturizable, .resizable],
                backing: .buffered, defer: false)
            window.title = "chalk"
            window.isReleasedWhenClosed = false
            window.contentView = child
            window.delegate = self
            window.center()
            children[ObjectIdentifier(window)] = (window, coordinator)
            window.makeKeyAndOrderFront(nil)
            return child
        }

        static func clamp(_ value: Double?, fallback: Double) -> Double {
            guard let value, value.isFinite else { return fallback }
            return min(max(value, 100), 8192)
        }

        // The page called window.close() in a child window.
        func webViewDidClose(_ webView: WKWebView) {
            guard isChild else { return }
            webView.window?.close()
        }

        func windowWillClose(_ notification: Notification) {
            guard let window = notification.object as? NSWindow else { return }
            children.removeValue(forKey: ObjectIdentifier(window))
        }
    }
}

import SwiftUI
import WebKit

let serverURL = URL(string: "https://tinsmith-shown-ramble.ngrok-free.dev")!

struct ChalkWebView: UIViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator {
        Coordinator(server: url)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        let view = WKWebView(frame: .zero, configuration: config)
        view.isInspectable = true
        view.uiDelegate = context.coordinator
        view.load(URLRequest(url: url))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKUIDelegate {
        let host: String
        let port: Int

        init(server: URL) {
            host = server.host ?? ""
            port = server.port ?? 0
        }

        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping (WKPermissionDecision) -> Void
        ) {
            let same = origin.protocol == "https" && origin.host == host && origin.port == port
            decisionHandler(same ? .grant : .deny)
        }
    }
}

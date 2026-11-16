import UIKit
import UserNotifications
import WebKit

/// Registers the device for remote notifications and answers the page.
///
/// Without the Push capability, which needs the paid account, iOS refuses the registration and the reply is "unavailable".
@MainActor
final class PushRegistrar {
    static let shared = PushRegistrar()

    private var waiting: [CheckedContinuation<Data?, Never>] = []
    private let timeout: Duration = .seconds(15)

    /// Returns the reply for the page (see `PushReply`).
    ///
    /// It asks for the notification permission only if `prompt` is true and the user has not decided.
    /// If the permission is not granted, the reply is "denied".
    /// It waits up to 15 seconds for the device token.
    /// If there is no token, or the keys fail, the reply is "unavailable".
    func register(prompt: Bool) async -> [String: Any] {
        let center = UNUserNotificationCenter.current()
        var status = await center.notificationSettings().authorizationStatus
        if status == .notDetermined && prompt {
            _ = try? await center.requestAuthorization(options: [.alert, .badge, .sound])
            status = await center.notificationSettings().authorizationStatus
        }
        guard status == .authorized || status == .provisional || status == .ephemeral else {
            return PushReply.failure("denied")
        }
        guard let token = await deviceToken(), let keys = try? PushKeys.loadOrCreate(KeychainStore.push) else {
            return PushReply.failure("unavailable")
        }
        return PushReply.success(token: token, keys: keys,
                                 topic: Bundle.main.bundleIdentifier ?? "", environment: PushReply.environment)
    }

    // deviceToken starts the registration and waits for the token. Calls that overlap share one registration.
    private func deviceToken() async -> Data? {
        await withCheckedContinuation { c in
            waiting.append(c)
            guard waiting.count == 1 else { return }
            UIApplication.shared.registerForRemoteNotifications()
            Task { [timeout] in
                try? await Task.sleep(for: timeout)
                self.finish(nil)
            }
        }
    }

    /// Gives the token to all waiting calls. nil means that the registration failed or timed out.
    func finish(_ token: Data?) {
        let ready = waiting
        waiting = []
        for c in ready { c.resume(returning: token) }
    }
}

/// Sends the target of a notification tap to the page.
///
/// A tap can start the app, so the router keeps the target until the page has loaded.
@MainActor
final class PushOpenRouter {
    static let shared = PushOpenRouter()

    private weak var webView: WKWebView?
    private var loaded = false
    private var pending: [String: String]?

    /// Sets the web view that gets the targets. The page is not loaded yet.
    func attach(_ view: WKWebView) {
        webView = view
        loaded = false
    }

    /// Records that the page loaded, and delivers a kept target.
    func pageLoaded() {
        loaded = true
        if let t = pending {
            pending = nil
            deliver(t)
        }
    }

    /// Delivers target now, or keeps it until the page has loaded.
    func open(_ target: [String: String]) {
        if loaded, webView != nil { deliver(target) } else { pending = target }
    }

    // deliver dispatches the event in the page content world. The target goes in as an argument, so it is never part of the script text.
    private func deliver(_ target: [String: String]) {
        webView?.callAsyncJavaScript(
            "window.dispatchEvent(new CustomEvent(name, { detail: detail }));",
            arguments: ["name": PushOpen.event, "detail": target],
            in: nil, in: .page, completionHandler: nil)
    }
}

/// The `chalkPush` message handler of the page.
///
/// It answers only the main frame of the server origin and refuses every other frame.
/// The only request is `{op: "register", prompt}`.
final class PushBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "chalkPush"
    let serverOrigin: String?

    init(serverOrigin: String?) {
        self.serverOrigin = serverOrigin
    }

    @MainActor
    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) async -> (Any?, String?) {
        guard message.frameInfo.isMainFrame,
              originString(message.frameInfo.securityOrigin) == serverOrigin
        else { return (nil, "refused") }
        guard let body = message.body as? [String: Any], body["op"] as? String == "register" else {
            return (nil, "unknown request")
        }
        return (await PushRegistrar.shared.register(prompt: body["prompt"] as? Bool ?? false), nil)
    }
}

/// Returns the origin of a frame as scheme, lowercase host, and port. The port is left out if it is 0.
func originString(_ origin: WKSecurityOrigin) -> String {
    let port = origin.port == 0 ? "" : ":\(origin.port)"
    return "\(origin.protocol)://\(origin.host.lowercased())\(port)"
}

/// The application delegate. It receives the device token and handles notification taps.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Set at launch, so that a tap that starts the app reaches didReceive.
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushRegistrar.shared.finish(deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushRegistrar.shared.finish(nil)
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        // No banner while the app is in front: the page shows its own banners.
        []
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        if let target = PushOpen.target(from: response.notification.request.content.userInfo) {
            PushOpenRouter.shared.open(target)
        }
    }
}

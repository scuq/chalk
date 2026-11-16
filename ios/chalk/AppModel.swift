import Foundation
import Observation

@Observable
final class AppModel {
    private static let serverKey = "server"
    private static let chooseKey = "choose_server"

    var server: URL?
    var lastServer: URL?
    var message: String?

    init() {
        lastServer = UserDefaults.standard.url(forKey: Self.serverKey)
        server = lastServer
        applySettingsToggle()
    }

    func applySettingsToggle() {
        let defaults = UserDefaults.standard
        guard defaults.bool(forKey: Self.chooseKey) else { return }
        defaults.set(false, forKey: Self.chooseKey)
        server = nil
        message = nil
    }

    func connect(_ input: String) {
        guard let url = ServerAddress.normalize(input) else {
            message = "That is not a server address chalk can open. Use https://host."
            return
        }
        UserDefaults.standard.set(url, forKey: Self.serverKey)
        lastServer = url
        message = nil
        server = url
    }

    func loadFailed(_ reason: String) {
        let host = server?.host() ?? "the server"
        message = "Could not reach \(host) (\(reason))."
        server = nil
    }
}

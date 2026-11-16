import Foundation

/// Tells the page once for each phone call that connects.
/// A ringing call and a declined call tell nothing. A call that ends is forgotten.
struct PhoneCallTracker {
    private var told: Set<UUID> = []

    /// Returns true once per call, when the call with this id has connected.
    /// Returns false for a call that rings, a call already told, and a call that ended.
    mutating func update(id: UUID, connected: Bool, ended: Bool) -> Bool {
        if ended {
            told.remove(id)
            return false
        }
        guard connected, !told.contains(id) else { return false }
        told.insert(id)
        return true
    }
}

/// The script and the event name that the page reads. The page side is `web/src/ios-shell.ts`.
enum ShellMark {
    /// The window event for a connected phone call. It must match `IOS_PHONE_CALL_EVENT` in the page.
    static let phoneCallEvent = "chalk-ios-phone-call"

    /// Returns the script that defines `window.chalkIOS`. The property is frozen and not configurable.
    /// The script keeps only letters, digits, and dots of version, so version cannot end the string.
    static func script(version: String) -> String {
        let shell = "chalk-ios/" + version.filter { $0.isLetter || $0.isNumber || $0 == "." }
        return """
        Object.defineProperty(window, "chalkIOS", {
          value: Object.freeze({ shell: "\(shell)", platform: "ios" }),
          writable: false,
          configurable: false
        });
        """
    }

    /// The script that dispatches the phone-call event on the window.
    static let phoneCallScript = "window.dispatchEvent(new Event(\"\(phoneCallEvent)\"));"
}

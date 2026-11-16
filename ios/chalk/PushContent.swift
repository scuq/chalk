import Foundation

/// What the notification shows and where a tap leads, taken from a decrypted push payload.
///
/// The wording is the same as `notificationFor` in `web/src/sw-logic.ts`.
struct PushContent: Equatable {
    /// The first line of the notification.
    var title: String
    /// The second line of the notification.
    var body: String
    /// The grouping key. Notifications with the same value stack, like the tag of a web notification.
    var threadID: String
    /// The unread count for the app icon, or nil to leave the badge alone.
    var badge: Int?
    /// The channel that a tap opens, or nil.
    var channelID: String?
    /// The thread that a tap opens, or nil.
    var threadMessageID: String?
    /// The reminder that a tap opens, or nil.
    var reminderID: String?

    /// The content for an unknown or malformed payload.
    /// It is the same constant text that chalkd puts in the APNs alert (`internal/apns`).
    static let fallback = PushContent(title: "chalk", body: "New notification", threadID: "chalk", badge: nil)

    init(title: String, body: String, threadID: String, badge: Int?,
         channelID: String? = nil, threadMessageID: String? = nil, reminderID: String? = nil) {
        self.title = title
        self.body = body
        self.threadID = threadID
        self.badge = badge
        self.channelID = channelID
        self.threadMessageID = threadMessageID
        self.reminderID = reminderID
    }

    /// Returns the content for a decrypted JSON payload, or `fallback` if the payload is not a known one.
    ///
    /// The ids must be UUIDs, which is stricter than the web.
    /// The extension builds the address that a tap opens from them.
    static func from(payload: Data) -> PushContent {
        guard let object = try? JSONSerialization.jsonObject(with: payload),
              let p = object as? [String: Any],
              (p["v"] as? Int) == 1
        else { return fallback }

        switch p["kind"] as? String {
        case "reminder":
            guard let id = p["reminder_id"] as? String, isID(id) else { return fallback }
            return PushContent(title: "chalk", body: "Reminder: a message is due",
                               threadID: "chalk-rem-" + id, badge: nil, reminderID: id)
        case "message":
            guard let channel = p["channel_id"] as? String, isID(channel),
                  let message = p["message_id"] as? String, isID(message)
            else { return fallback }
            let handle = (p["sender_handle"] as? String) ?? ""
            let sender = handle.isEmpty ? "someone" : "@" + handle
            let isDM = (p["is_dm"] as? Bool) == true
            let channelName = (p["channel_name"] as? String) ?? ""
            var title = sender
            if !isDM && !channelName.isEmpty { title = sender + " in #" + channelName }
            var thread = p["thread_id"] as? String
            if let t = thread, !isID(t) { thread = nil }
            let unread = max(0, (p["unread"] as? Int) ?? 0)
            return PushContent(
                title: title,
                body: thread == nil ? "New message" : "New reply in a thread",
                threadID: thread.map { "chalk-th-" + $0 } ?? "chalk-ch-" + channel,
                badge: unread,
                channelID: channel,
                threadMessageID: thread)
        default:
            return fallback
        }
    }

    /// Reports whether `s` is a UUID.
    private static func isID(_ s: String) -> Bool {
        UUID(uuidString: s) != nil
    }
}

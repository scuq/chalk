import UserNotifications

/// The notification service extension of chalk (136-4d).
///
/// iOS runs it for each push with `mutable-content`, before iOS shows the notification.
/// It replaces the constant alert text of chalkd with the text of the decrypted payload.
/// If it cannot decrypt, or if its time runs out, the notification shows `PushContent.fallback`.
final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var fallbackContent: UNMutableNotificationContent?

    /// Makes the content of the notification and gives it to iOS.
    ///
    /// It first prepares the fallback content, with no badge change.
    /// Then it reads the keys from the shared Keychain group and decrypts the `chalk` field of the push (RFC 8291).
    /// If the field, the keys, or the decryption are not available, it gives the fallback content.
    /// Otherwise it gives the title, the body, the thread, the badge, and the tap target of the payload.
    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        let content = UNMutableNotificationContent()
        content.sound = .default
        apply(.fallback, to: content)
        fallbackContent = content

        guard let sealed = (request.content.userInfo["chalk"] as? String).flatMap({ Data(base64Encoded: $0) }),
              let keys = PushKeys.load(KeychainStore.push),
              let plain = try? PushCrypto.decrypt(sealed, privateKey: keys.privateKey, auth: keys.auth)
        else {
            finish(content)
            return
        }
        let full = UNMutableNotificationContent()
        full.sound = .default
        apply(PushContent.from(payload: plain), to: full)
        finish(full)
    }

    /// Gives the fallback content to iOS when the time of the extension is nearly over.
    override func serviceExtensionTimeWillExpire() {
        if let fallbackContent { finish(fallbackContent) }
    }

    // finish gives content to iOS once. A second call does nothing.
    private func finish(_ content: UNNotificationContent) {
        guard let handler = contentHandler else { return }
        contentHandler = nil
        handler(content)
    }

    // apply copies the text, the thread, the badge, and the tap target of p into content.
    // A badge of nil leaves the badge of the app as it is.
    private func apply(_ p: PushContent, to content: UNMutableNotificationContent) {
        content.title = p.title
        content.body = p.body
        content.threadIdentifier = p.threadID
        if let badge = p.badge { content.badge = NSNumber(value: badge) }
        content.userInfo = PushOpen.userInfo(for: p)
    }
}

import CryptoKit
import Foundation
import Security

/// A place that keeps one secret, which is a block of bytes.
protocol SecretStore {
    /// Removes the saved bytes.
    func delete()
    /// Returns the saved bytes, or nil if there are none.
    func load() -> Data?
    /// Replaces the saved bytes, and reports whether the store kept them.
    func save(_ data: Data) -> Bool
}

/// A `SecretStore` in the Keychain, as one generic password item of a service and an account.
///
/// The item is readable after the first unlock of the device, and it never leaves the device.
/// The notification extension must read it while the phone is locked.
/// `accessGroup` names the Keychain access group of the item.
/// If it is nil, a query matches the items of every group that the process can reach.
/// The app and the notification extension share the item through the group in the `ChalkKeychainGroup` key of their `Info.plist` files.
struct KeychainStore: SecretStore {
    let service: String
    let account: String
    var accessGroup: String?

    /// The item that holds the push keys of this device.
    static let push = KeychainStore(service: "at.73c.chalk.push", account: "device-key",
                                    accessGroup: Bundle.main.object(forInfoDictionaryKey: "ChalkKeychainGroup") as? String)

    /// The item in the own default group of the app, where older builds saved the keys.
    ///
    /// It names its group, the `ChalkLegacyKeychainGroup` key of the app `Info.plist`.
    /// Without a group, a query also matches the shared item, and a delete would remove it.
    static let legacyPush = KeychainStore(service: "at.73c.chalk.push", account: "device-key",
                                          accessGroup: Bundle.main.object(forInfoDictionaryKey: "ChalkLegacyKeychainGroup") as? String)

    private var query: [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
        return q
    }

    func load() -> Data? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    func save(_ data: Data) -> Bool {
        SecItemDelete(query as CFDictionary)
        var q = query
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }

    /// Removes the item.
    func delete() {
        SecItemDelete(query as CFDictionary)
    }
}

/// The device keys for push: a P-256 key pair and a 16-byte authentication secret.
///
/// chalkd encrypts each push to the public key and the secret (RFC 8291).
/// The private key stays in the Keychain, and the page gets only the public key.
struct PushKeys {
    let privateKey: P256.KeyAgreement.PrivateKey
    let auth: Data

    /// Length of the authentication secret in bytes.
    static let authLength = 16
    private static let keyLength = 32

    /// The keys could not be made or saved.
    enum Failure: Error { case save }

    /// Returns the keys in store, or nil if the store has none or its item is not valid.
    ///
    /// It never makes or saves a key. The notification extension uses it.
    static func load(_ store: SecretStore) -> PushKeys? {
        guard let saved = store.load() else { return nil }
        return decode(saved)
    }

    /// Returns the keys in store, and makes and saves new keys if the store has none.
    ///
    /// If the store has no keys and `legacy` holds valid keys, it saves them in the store and deletes the item in `legacy`.
    /// If the saved item has the wrong length or holds an invalid key, it makes new keys and replaces the item.
    /// It throws `Failure.save` if the random bytes or the save fail.
    static func loadOrCreate(_ store: SecretStore, legacy: SecretStore? = nil) throws -> PushKeys {
        if let keys = load(store) { return keys }
        if let legacy, let old = legacy.load(), let keys = decode(old), store.save(old) {
            legacy.delete()
            return keys
        }
        let key = P256.KeyAgreement.PrivateKey()
        var auth = Data(count: authLength)
        let status = auth.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, authLength, $0.baseAddress!) }
        guard status == errSecSuccess else { throw Failure.save }
        guard store.save(key.rawRepresentation + auth) else { throw Failure.save }
        return PushKeys(privateKey: key, auth: auth)
    }

    private static func decode(_ saved: Data) -> PushKeys? {
        guard saved.count == keyLength + authLength,
              let key = try? P256.KeyAgreement.PrivateKey(rawRepresentation: saved.prefix(keyLength))
        else { return nil }
        return PushKeys(privateKey: key, auth: Data(saved.suffix(authLength)))
    }
}

/// The reply dictionaries that the app gives to the page through the `chalkPush` handler.
///
/// `web/src/notify/ios-push.ts` checks them, and its header describes the format.
enum PushReply {
    /// The APNs environment of this build: "sandbox" in a Debug build, "production" in a Release build.
    ///
    /// Builds that run from Xcode use the APNs sandbox. TestFlight and App Store builds use production.
    static var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    /// Returns the reply for a registration: the token as lowercase hex and the keys as unpadded base64url.
    static func success(token: Data, keys: PushKeys, topic: String, environment: String) -> [String: Any] {
        [
            "ok": true,
            "token": token.map { String(format: "%02x", $0) }.joined(),
            "p256dh": base64url(keys.privateKey.publicKey.x963Representation),
            "auth": base64url(keys.auth),
            "topic": topic,
            "environment": environment,
        ]
    }

    /// Returns the reply for a refusal. `error` is "denied" or "unavailable".
    static func failure(_ error: String) -> [String: Any] {
        ["ok": false, "error": error]
    }

    /// Returns d as base64url without padding.
    static func base64url(_ d: Data) -> String {
        d.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

/// The link between a notification and the target that the page opens.
enum PushOpen {
    /// The name of the event that the app dispatches in the page.
    static let event = "chalk-ios-open"

    /// Returns the target of a tap, or nil.
    ///
    /// The keys `chalk_channel`, `chalk_thread`, and `chalk_reminder` map to `channelID`, `threadID`, and `reminderID`.
    /// Only UUIDs pass. A target needs a channel or a reminder.
    static func target(from userInfo: [AnyHashable: Any]) -> [String: String]? {
        var t: [String: String] = [:]
        for (key, name) in [("chalk_channel", "channelID"), ("chalk_thread", "threadID"), ("chalk_reminder", "reminderID")] {
            if let v = userInfo[key] as? String, UUID(uuidString: v) != nil { t[name] = v }
        }
        return t["channelID"] != nil || t["reminderID"] != nil ? t : nil
    }

    /// Returns the `userInfo` entries that the notification extension writes, so that a tap can open the target.
    static func userInfo(for content: PushContent) -> [String: String] {
        var u: [String: String] = [:]
        if let c = content.channelID { u["chalk_channel"] = c }
        if let t = content.threadMessageID { u["chalk_thread"] = t }
        if let r = content.reminderID { u["chalk_reminder"] = r }
        return u
    }
}

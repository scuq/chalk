// Tests for PushCrypto and PushContent.
// The crypto tests use the RFC 8291 Appendix A vector and a test-only sender.
// The content tests cover each payload kind and the fallback.
import CryptoKit
import Foundation
import Testing
@testable import chalk

// Decodes base64url without padding.
private func b64url(_ s: String) -> Data {
    var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while t.count % 4 != 0 { t += "=" }
    return Data(base64Encoded: t)!
}

// The HKDF info string: the text and a zero byte.
private func label(_ s: String) -> Data {
    var d = Data(s.utf8)
    d.append(0)
    return d
}

// A test-only RFC 8291 sender.
// It pads the plaintext with zeros to padTo bytes, as chalkd does, and writes rs = 4096.
private func seal(_ payload: Data, to receiver: P256.KeyAgreement.PublicKey, auth: Data,
                  padTo: Int = 1024, delimiter: UInt8 = 2) throws -> Data {
    let sender = P256.KeyAgreement.PrivateKey()
    var salt = Data(count: 16)
    for i in 0..<16 { salt[i] = UInt8.random(in: 0...255) }
    let secret = try sender.sharedSecretFromKeyAgreement(with: receiver)
    var info = label("WebPush: info")
    info.append(receiver.x963Representation)
    info.append(sender.publicKey.x963Representation)
    let ikm = secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: auth, sharedInfo: info, outputByteCount: 32)
    let prk = HKDF<SHA256>.extract(inputKeyMaterial: ikm, salt: salt)
    let cek = HKDF<SHA256>.expand(pseudoRandomKey: prk, info: label("Content-Encoding: aes128gcm"), outputByteCount: 16)
    let nonce = HKDF<SHA256>.expand(pseudoRandomKey: prk, info: label("Content-Encoding: nonce"), outputByteCount: 12)
    var plain = payload
    plain.append(delimiter)
    while plain.count < padTo { plain.append(0) }
    let box = try AES.GCM.seal(plain, using: cek, nonce: AES.GCM.Nonce(data: nonce.withUnsafeBytes { Data($0) }))
    var out = salt
    out.append(contentsOf: [0, 0, 0x10, 0])
    out.append(65)
    out.append(sender.publicKey.x963Representation)
    out.append(box.ciphertext)
    out.append(box.tag)
    return out
}

@MainActor
struct PushCryptoTests {
    // The vector of RFC 8291 Appendix A. The receiver key must derive the public key of the RFC first.
    @Test func decryptsTheRFC8291Vector() throws {
        let receiver = try P256.KeyAgreement.PrivateKey(rawRepresentation: b64url("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"))
        #expect(receiver.publicKey.x963Representation == b64url("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"))
        let body = b64url("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN")
        let plain = try PushCrypto.decrypt(body, privateKey: receiver, auth: b64url("BTBZMqHH6r4Tts7J_aSIgg"))
        #expect(String(decoding: plain, as: UTF8.self) == "When I grow up, I want to be a watermelon")
    }

    // A body of the size that chalkd sends: 21 + 65 + 1024 + 16 bytes.
    @Test func decryptsAPaddedPushLikeChalkdSendsIt() throws {
        let receiver = P256.KeyAgreement.PrivateKey()
        let auth = Data((0..<16).map { _ in UInt8.random(in: 0...255) })
        let payload = Data(#"{"v":1,"kind":"message"}"#.utf8)
        let body = try seal(payload, to: receiver.publicKey, auth: auth)
        #expect(body.count == 21 + 65 + 1024 + 16)
        #expect(try PushCrypto.decrypt(body, privateKey: receiver, auth: auth) == payload)
    }

    // Each case must give its own error: changed byte, wrong key, wrong auth, short body, bad key id length, bad sender point, no delimiter.
    @Test func refusesWhatItCannotTrust() throws {
        let receiver = P256.KeyAgreement.PrivateKey()
        let auth = Data(repeating: 7, count: 16)
        let body = try seal(Data("hi".utf8), to: receiver.publicKey, auth: auth)

        var tampered = body
        tampered[tampered.count - 20] ^= 1
        #expect(throws: PushCryptoError.open) { try PushCrypto.decrypt(tampered, privateKey: receiver, auth: auth) }
        #expect(throws: PushCryptoError.open) {
            try PushCrypto.decrypt(body, privateKey: P256.KeyAgreement.PrivateKey(), auth: auth)
        }
        #expect(throws: PushCryptoError.open) {
            try PushCrypto.decrypt(body, privateKey: receiver, auth: Data(repeating: 8, count: 16))
        }
        #expect(throws: PushCryptoError.tooShort) { try PushCrypto.decrypt(body.prefix(50), privateKey: receiver, auth: auth) }
        var badLength = body
        badLength[20] = 64
        #expect(throws: PushCryptoError.header) { try PushCrypto.decrypt(badLength, privateKey: receiver, auth: auth) }
        var badPoint = body
        badPoint[21] = 9
        #expect(throws: PushCryptoError.key) { try PushCrypto.decrypt(badPoint, privateKey: receiver, auth: auth) }
        let noDelimiter = try seal(Data("hi".utf8), to: receiver.publicKey, auth: auth, delimiter: 1)
        #expect(throws: PushCryptoError.delimiter) { try PushCrypto.decrypt(noDelimiter, privateKey: receiver, auth: auth) }
    }
}

@MainActor
struct PushContentTests {
    private let ch = "11111111-1111-1111-1111-111111111111"
    private let msg = "22222222-2222-2222-2222-222222222222"
    private let th = "33333333-3333-3333-3333-333333333333"

    private func content(_ json: String) -> PushContent {
        PushContent.from(payload: Data(json.utf8))
    }

    // A channel message: the title names the sender and the channel, and the badge is the unread count.
    @Test func messageInAChannel() {
        let c = content(#"{"v":1,"kind":"message","channel_id":"\#(ch)","message_id":"\#(msg)","sender_handle":"alice","channel_name":"general","is_dm":false,"unread":3}"#)
        #expect(c.title == "@alice in #general")
        #expect(c.body == "New message")
        #expect(c.threadID == "chalk-ch-" + ch)
        #expect(c.badge == 3)
        #expect(c.channelID == ch)
    }

    // A direct message has no channel name in the title. An empty handle gives "someone", and a negative unread count gives 0.
    @Test func directMessageAndThreadReply() {
        let dm = content(#"{"v":1,"kind":"message","channel_id":"\#(ch)","message_id":"\#(msg)","sender_handle":"bob","channel_name":"ignored","is_dm":true,"unread":1}"#)
        #expect(dm.title == "@bob")
        let reply = content(#"{"v":1,"kind":"message","channel_id":"\#(ch)","message_id":"\#(msg)","thread_id":"\#(th)","sender_handle":"","is_dm":false,"unread":-4}"#)
        #expect(reply.title == "someone")
        #expect(reply.body == "New reply in a thread")
        #expect(reply.threadID == "chalk-th-" + th)
        #expect(reply.threadMessageID == th)
        #expect(reply.badge == 0)
    }

    // A reminder has a fixed body and no badge.
    @Test func reminder() {
        let r = content(#"{"v":1,"kind":"reminder","reminder_id":"\#(th)"}"#)
        #expect(r.body == "Reminder: a message is due")
        #expect(r.reminderID == th)
        #expect(r.badge == nil)
    }

    // A payload that is empty, not JSON, of another version or kind, or has an id that is not a UUID gives the fallback.
    @Test func anythingElseIsTheFallback() {
        for bad in ["", "not json", "[]", #"{"v":2,"kind":"message"}"#,
                    #"{"v":1,"kind":"other"}"#,
                    #"{"v":1,"kind":"reminder","reminder_id":"../x"}"#,
                    #"{"v":1,"kind":"message","channel_id":"x","message_id":"\#(msg)"}"#] {
            #expect(content(bad) == .fallback, "payload \(bad)")
        }
        #expect(PushContent.fallback.title == "chalk")
        #expect(PushContent.fallback.body == "New notification")
    }
}

// A SecretStore in memory. refuse makes save fail, and saves counts the saved items.
private final class MemoryStore: SecretStore {
    var data: Data?
    var saves = 0
    var refuse = false
    func load() -> Data? { data }
    func save(_ d: Data) -> Bool {
        if refuse { return false }
        data = d
        saves += 1
        return true
    }
}

// 136-4d: tests of the keys, the reply format, and the tap targets of the push bridge.
@MainActor
struct PushBridgeTests {
    // The keys are made once, kept, made again if the item is damaged, and an error shows if the save fails.
    @Test func keysAreMadeOnceAndKept() throws {
        let store = MemoryStore()
        let a = try PushKeys.loadOrCreate(store)
        let b = try PushKeys.loadOrCreate(store)
        #expect(store.saves == 1)
        #expect(a.privateKey.rawRepresentation == b.privateKey.rawRepresentation)
        #expect(a.auth == b.auth && a.auth.count == 16)
        store.data = Data([1, 2, 3])
        let c = try PushKeys.loadOrCreate(store)
        #expect(store.saves == 2)
        #expect(c.privateKey.rawRepresentation != a.privateKey.rawRepresentation)
        let refusing = MemoryStore()
        refusing.refuse = true
        #expect(throws: PushKeys.Failure.self) { try PushKeys.loadOrCreate(refusing) }
    }

    // Runs on the simulator Keychain, with a service name that is unique for each run.
    @Test func keychainRoundTrip() throws {
        let store = KeychainStore(service: "at.73c.chalk.test." + UUID().uuidString, account: "k")
        defer { store.delete() }
        #expect(store.load() == nil)
        let keys = try PushKeys.loadOrCreate(store)
        let again = try PushKeys.loadOrCreate(store)
        #expect(keys.privateKey.rawRepresentation == again.privateKey.rawRepresentation)
    }

    // The format is the one that parseNativeReply in web/src/notify/ios-push.ts accepts.
    @Test func replyHasThePageFormat() throws {
        let keys = try PushKeys.loadOrCreate(MemoryStore())
        let r = PushReply.success(token: Data([0x00, 0xfc, 0x13]), keys: keys, topic: "at.73c.chalk", environment: "sandbox")
        #expect(r["ok"] as? Bool == true)
        #expect(r["token"] as? String == "00fc13")
        let p256dh = try #require(r["p256dh"] as? String)
        let auth = try #require(r["auth"] as? String)
        #expect(p256dh.count == 87 && auth.count == 22)
        #expect(!p256dh.contains("=") && !p256dh.contains("+") && !p256dh.contains("/"))
        #expect(r["topic"] as? String == "at.73c.chalk" && r["environment"] as? String == "sandbox")
        let f = PushReply.failure("denied")
        #expect(f["ok"] as? Bool == false && f["error"] as? String == "denied")
        #expect(PushReply.environment == "sandbox")
    }

    // A target from userInfo is the target of the page, and junk that is not a UUID is refused.
    @Test func tapTargetsRoundTripAndRefuseJunk() {
        let ch = "11111111-1111-1111-1111-111111111111"
        let th = "33333333-3333-3333-3333-333333333333"
        let content = PushContent(title: "t", body: "b", threadID: "x", badge: nil, channelID: ch, threadMessageID: th)
        #expect(PushOpen.target(from: PushOpen.userInfo(for: content)) == ["channelID": ch, "threadID": th])
        #expect(PushOpen.target(from: ["chalk_reminder": th]) == ["reminderID": th])
        #expect(PushOpen.target(from: ["chalk_channel": "javascript:x"]) == nil)
        #expect(PushOpen.target(from: ["chalk_thread": th]) == nil)
        #expect(PushOpen.target(from: [:]) == nil)
        #expect(PushOpen.userInfo(for: .fallback).isEmpty)
    }
}

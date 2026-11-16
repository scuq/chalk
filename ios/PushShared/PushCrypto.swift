import CryptoKit
import Foundation

/// The reasons `PushCrypto.decrypt` refuses a push body.
enum PushCryptoError: Error, Equatable {
    /// The body is shorter than the header, the sender key, and the 16-byte tag.
    case tooShort
    /// The key id length is not 65, the record is longer than `rs`, or `rs` is less than 18.
    case header
    /// The sender key is not a valid P-256 point.
    case key
    /// AES-GCM refused the record: the key, the auth secret, or a byte is wrong.
    case open
    /// The last byte after the zero padding is not 0x02, the last-record delimiter.
    case delimiter
}

/// The receiver side of RFC 8291 (Web Push encryption, `aes128gcm`) with CryptoKit only.
///
/// It is the counterpart of `internal/webpush/encrypt.go`, which chalkd uses for web push and for APNs.
/// It handles one record, which is what chalkd sends.
enum PushCrypto {
    /// Length of the sender key in the header: an uncompressed P-256 point.
    static let keyIDLength = 65
    /// Length of the fixed header: salt (16), `rs` (4), and the key id length (1).
    static let headerLength = 16 + 4 + 1

    /// Returns the plaintext of a push body, without the padding and the delimiter.
    ///
    /// The body is salt (16 bytes), `rs` (4 bytes), the key id length (1 byte), the sender key (65 bytes), and one record.
    /// `privateKey` is the key pair of this device, and `auth` is its 16-byte authentication secret.
    /// It throws a `PushCryptoError` if the body is not a valid push for this key pair.
    static func decrypt(_ body: Data, privateKey: P256.KeyAgreement.PrivateKey, auth: Data) throws -> Data {
        let b = [UInt8](body)
        guard b.count >= headerLength + keyIDLength + 16 else { throw PushCryptoError.tooShort }
        let salt = Data(b[0..<16])
        let rs = Int(b[16]) << 24 | Int(b[17]) << 16 | Int(b[18]) << 8 | Int(b[19])
        let idLen = Int(b[20])
        guard idLen == keyIDLength else { throw PushCryptoError.header }
        let senderRaw = Data(b[headerLength..<(headerLength + idLen)])
        let record = Data(b[(headerLength + idLen)...])
        guard rs >= 18, record.count <= rs else { throw PushCryptoError.header }

        let sender: P256.KeyAgreement.PublicKey
        let secret: SharedSecret
        do {
            sender = try P256.KeyAgreement.PublicKey(x963Representation: senderRaw)
            secret = try privateKey.sharedSecretFromKeyAgreement(with: sender)
        } catch {
            throw PushCryptoError.key
        }

        // RFC 8291 section 3.4: the key material mixes in both public keys.
        var info = Data("WebPush: info".utf8)
        info.append(0)
        info.append(privateKey.publicKey.x963Representation)
        info.append(senderRaw)
        let ikm = secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: auth, sharedInfo: info, outputByteCount: 32)
        let prk = HKDF<SHA256>.extract(inputKeyMaterial: ikm, salt: salt)
        let cek = HKDF<SHA256>.expand(pseudoRandomKey: prk, info: label("Content-Encoding: aes128gcm"), outputByteCount: 16)
        let nonce = HKDF<SHA256>.expand(pseudoRandomKey: prk, info: label("Content-Encoding: nonce"), outputByteCount: 12)

        var plain: [UInt8]
        do {
            let box = try AES.GCM.SealedBox(
                nonce: AES.GCM.Nonce(data: nonce.withUnsafeBytes { Data($0) }),
                ciphertext: record.dropLast(16),
                tag: record.suffix(16))
            plain = [UInt8](try AES.GCM.open(box, using: cek))
        } catch {
            throw PushCryptoError.open
        }
        // Strip the zero padding, then the delimiter byte. A body with no delimiter is refused.
        while plain.last == 0 { plain.removeLast() }
        guard plain.last == 2 else { throw PushCryptoError.delimiter }
        plain.removeLast()
        return Data(plain)
    }

    /// Returns the HKDF info string: the text and a zero byte.
    private static func label(_ s: String) -> Data {
        var d = Data(s.utf8)
        d.append(0)
        return d
    }
}

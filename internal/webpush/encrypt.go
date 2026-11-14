// Package webpush sends Web Push messages to push services.
// It implements RFC 8291 message encryption (aes128gcm), RFC 8292 VAPID
// authorization, and an HTTPS sender that connects only to public addresses.
// It uses only the Go standard library.
package webpush

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
)

// PaddedLen is the plaintext length of every message in bytes. It includes
// the delimiter byte and the padding. A fixed length makes every body the
// same size, so the size tells the push service nothing about the content.
const PaddedLen = 1024

// recordSize is the rs field of the aes128gcm header. A message is one
// record, and one record of PaddedLen plus the 16-byte tag fits in it.
const recordSize = 4096

const (
	saltLen   = 16
	authLen   = 16
	pubKeyLen = 65
)

// ErrPayloadTooLarge is returned for a payload that is longer than
// PaddedLen minus one byte, because the delimiter needs that byte.
var ErrPayloadTooLarge = errors.New("webpush: payload too large")

// Encrypt returns the aes128gcm body for payload, encrypted to the
// subscription keys p256dh (65 bytes) and auth (16 bytes). The body has the
// same length for every payload.
// If payload is longer than PaddedLen minus one byte, Encrypt returns
// ErrPayloadTooLarge.
func Encrypt(payload, p256dh, auth []byte) ([]byte, error) {
	asPriv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("webpush: ephemeral key: %w", err)
	}
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return nil, fmt.Errorf("webpush: salt: %w", err)
	}
	if len(payload) > PaddedLen-1 {
		return nil, ErrPayloadTooLarge
	}
	return encrypt(payload, p256dh, auth, asPriv, salt, PaddedLen)
}

// encrypt is Encrypt with the ephemeral key and the salt supplied, so a
// test can reproduce the RFC 8291 vector. plainLen is the length of the
// plaintext with the delimiter and the padding; 0 means no padding.
func encrypt(payload, p256dh, auth []byte, asPriv *ecdh.PrivateKey, salt []byte, plainLen int) ([]byte, error) {
	if len(p256dh) != pubKeyLen {
		return nil, fmt.Errorf("webpush: p256dh is %d bytes, want %d", len(p256dh), pubKeyLen)
	}
	if len(auth) != authLen {
		return nil, fmt.Errorf("webpush: auth is %d bytes, want %d", len(auth), authLen)
	}
	if len(salt) != saltLen {
		return nil, fmt.Errorf("webpush: salt is %d bytes, want %d", len(salt), saltLen)
	}
	if plainLen == 0 {
		plainLen = len(payload) + 1
	}
	if len(payload)+1 > plainLen || plainLen+16 > recordSize {
		return nil, ErrPayloadTooLarge
	}
	uaPub, err := ecdh.P256().NewPublicKey(p256dh)
	if err != nil {
		return nil, fmt.Errorf("webpush: p256dh: %w", err)
	}
	secret, err := asPriv.ECDH(uaPub)
	if err != nil {
		return nil, fmt.Errorf("webpush: ecdh: %w", err)
	}
	asPub := asPriv.PublicKey().Bytes()

	// RFC 8291 section 3.4.
	prkKey, err := hkdf.Extract(sha256.New, secret, auth)
	if err != nil {
		return nil, err
	}
	keyInfo := "WebPush: info\x00" + string(p256dh) + string(asPub)
	ikm, err := hkdf.Expand(sha256.New, prkKey, keyInfo, 32)
	if err != nil {
		return nil, err
	}
	prk, err := hkdf.Extract(sha256.New, ikm, salt)
	if err != nil {
		return nil, err
	}
	cek, err := hkdf.Expand(sha256.New, prk, "Content-Encoding: aes128gcm\x00", 16)
	if err != nil {
		return nil, err
	}
	nonce, err := hkdf.Expand(sha256.New, prk, "Content-Encoding: nonce\x00", 12)
	if err != nil {
		return nil, err
	}

	// One record: the payload, the last-record delimiter 0x02, then zeros.
	plain := make([]byte, plainLen)
	copy(plain, payload)
	plain[len(payload)] = 0x02

	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	// RFC 8188 header: salt, record size, key id length, key id.
	out := make([]byte, 0, saltLen+4+1+pubKeyLen+plainLen+gcm.Overhead())
	out = append(out, salt...)
	out = binary.BigEndian.AppendUint32(out, recordSize)
	out = append(out, byte(len(asPub)))
	out = append(out, asPub...)
	return gcm.Seal(out, nonce, plain, nil), nil
}

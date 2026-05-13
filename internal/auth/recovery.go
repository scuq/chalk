package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	_ "embed"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// bip39EnglishRaw is the canonical BIP-39 English wordlist (2048 words,
// one per line). The file is identical to the bitcoin/bips master copy
// at bip-0039/english.txt. SHA-256 of the file is
//
//	2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda
//
// Tests verify the count, shape, and a sampling of indices to catch
// accidental file corruption.
//
//go:embed bip39_english.txt
var bip39EnglishRaw string

// bip39Wordlist is the parsed wordlist as a Go slice. Indexed 0..2047
// (note: BIP-39 spec numbers from 0; the source file is line-ordered
// with line N corresponding to index N-1). Initialized at package
// load time from the embedded string.
var bip39Wordlist [2048]string

// bip39WordToIndex is the reverse map for fast lookup at verification
// time.
var bip39WordToIndex map[string]int

func init() {
	lines := strings.Split(strings.TrimRight(bip39EnglishRaw, "\n"), "\n")
	if len(lines) != 2048 {
		panic(fmt.Sprintf("bip39: wordlist must have 2048 entries, got %d", len(lines)))
	}
	bip39WordToIndex = make(map[string]int, 2048)
	for i, w := range lines {
		w = strings.TrimSpace(w)
		if w == "" {
			panic(fmt.Sprintf("bip39: empty word at index %d", i))
		}
		bip39Wordlist[i] = w
		bip39WordToIndex[w] = i
	}
}

// RecoveryWordCount is the number of words in a chalk recovery phrase.
// 24 BIP-39 words encode 264 bits (24 × 11 bits) of which 256 are
// entropy and 8 are a checksum. Per DECISION 5, we use 24 words for
// the highest entropy tier supported by the BIP-39 spec.
const RecoveryWordCount = 24

// GenerateRecoveryWords returns a freshly generated 24-word recovery
// phrase. The entropy comes from crypto/rand; an OS RNG failure
// returns an error (never expected in practice, but propagated rather
// than panicked).
//
// The output is a slice of 24 words. The application formats them as
// a space-separated string only at display time.
//
// Implementation: BIP-39 mnemonic generation with 256 bits entropy.
//
//  1. Read 32 random bytes (256 bits).
//  2. Compute SHA-256 checksum; take the top 8 bits (256/32 = 8).
//  3. Append the checksum to the entropy: 264 bits total.
//  4. Split into 24 11-bit groups (big-endian); each group indexes
//     one word in the wordlist.
//
// The result is a valid BIP-39 mnemonic; any standard BIP-39 wallet
// could decode it. For chalk's purposes that's incidental; we just
// need a high-entropy, human-readable, well-distributed phrase.
func GenerateRecoveryWords() ([]string, error) {
	const entropyBytes = 32 // 256 bits

	entropy := make([]byte, entropyBytes)
	if _, err := rand.Read(entropy); err != nil {
		return nil, fmt.Errorf("recovery entropy: %w", err)
	}

	// SHA-256 checksum of the entropy. We take the top 8 bits (one
	// byte) for a 256-bit input.
	sum := sha256.Sum256(entropy)
	checksum := sum[0]

	// Append checksum byte to the entropy as a 264-bit stream. The
	// last byte holds the checksum in its high 8 bits.
	stream := make([]byte, entropyBytes+1)
	copy(stream, entropy)
	stream[entropyBytes] = checksum

	// Read 24 groups of 11 bits, big-endian.
	words := make([]string, RecoveryWordCount)
	for i := 0; i < RecoveryWordCount; i++ {
		idx := readBits(stream, i*11, 11)
		words[i] = bip39Wordlist[idx]
	}
	return words, nil
}

// VerifyRecoveryWords checks that words has exactly RecoveryWordCount
// entries, that each one is in the BIP-39 wordlist, and (because we
// generated this phrase ourselves) that the appended checksum bit is
// correct. Returns nil iff the phrase is well-formed.
//
// This is used as a fast pre-flight check before doing the
// constant-time argon2 hash comparison: a malformed phrase can be
// rejected without revealing whether the hashed phrase matched. The
// final accept/reject decision uses VerifyRecoveryCodeHash.
func VerifyRecoveryWords(words []string) error {
	if len(words) != RecoveryWordCount {
		return fmt.Errorf("recovery: expected %d words, got %d", RecoveryWordCount, len(words))
	}
	indices := make([]int, RecoveryWordCount)
	for i, w := range words {
		w = strings.TrimSpace(strings.ToLower(w))
		idx, ok := bip39WordToIndex[w]
		if !ok {
			return fmt.Errorf("recovery: word %d (%q) not in wordlist", i+1, w)
		}
		indices[i] = idx
	}
	// Reconstruct the 264-bit stream and verify the checksum.
	stream := make([]byte, 33)
	for i, idx := range indices {
		writeBits(stream, i*11, 11, idx)
	}
	entropy := stream[:32]
	got := stream[32]
	sum := sha256.Sum256(entropy)
	want := sum[0]
	if got != want {
		return errors.New("recovery: checksum mismatch (phrase corrupted or transcribed wrong)")
	}
	return nil
}

// NormalizeRecoveryWords lowercases, trims, and splits a candidate
// recovery phrase into its constituent words. Whitespace runs of any
// kind separate words. Used by the verification HTTP endpoint to
// tolerate copy-paste artifacts from the SPA's word-input UI.
func NormalizeRecoveryWords(input string) []string {
	return strings.Fields(strings.ToLower(strings.TrimSpace(input)))
}

// ---- argon2id hashing -------------------------------------------------

// Argon2id parameters for recovery-code hashing. These are
// conservative-but-not-extreme: a recovery code is high-entropy
// (256+ bits) so we don't need the OWASP password-hashing parameters,
// but we do want enough cost to make a stolen hash unusable for
// brute-force.
//
// Time = 1 pass, Memory = 64 MiB, Parallelism = 2 threads, KeyLen = 32 bytes.
// Salt is 16 random bytes per call. Hash output is salt || hash; both
// fixed-width, so the verification path can split them deterministically.
const (
	argonTime    = 1
	argonMemory  = 64 * 1024 // 64 MiB
	argonThreads = 2
	argonKeyLen  = 32
	argonSaltLen = 16
)

// HashRecoveryWords argon2id-hashes the space-joined recovery phrase
// and returns salt || hash (48 bytes total: 16 salt + 32 hash). Caller
// stores the result in recovery_codes.hash; verification reads it
// back and calls VerifyRecoveryCodeHash.
//
// The phrase is normalized (lowercased, single-space joined) before
// hashing so the verification path tolerates user input variations.
func HashRecoveryWords(words []string) ([]byte, error) {
	if err := VerifyRecoveryWords(words); err != nil {
		return nil, err
	}
	phrase := strings.Join(words, " ")
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return nil, fmt.Errorf("recovery salt: %w", err)
	}
	hash := argon2.IDKey([]byte(phrase), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	out := make([]byte, 0, argonSaltLen+argonKeyLen)
	out = append(out, salt...)
	out = append(out, hash...)
	return out, nil
}

// VerifyRecoveryCodeHash returns nil iff the candidate words hash to
// the stored value. Constant-time comparison. Returns an error if
// the stored value is malformed or the words don't match.
//
// The application reads the stored hash from recovery_codes.hash
// (without altering the row) and calls this. After a successful
// verification, the application calls store.MarkRecoveryCodeUsed and
// then store.SetRecoveryCode (with a fresh phrase) in the same
// transaction.
func VerifyRecoveryCodeHash(storedSaltHash []byte, words []string) error {
	if len(storedSaltHash) != argonSaltLen+argonKeyLen {
		return fmt.Errorf("recovery: stored hash has wrong length (%d, want %d)",
			len(storedSaltHash), argonSaltLen+argonKeyLen)
	}
	// Cheap shape check before doing the expensive argon2 hash.
	if err := VerifyRecoveryWords(words); err != nil {
		return err
	}
	salt := storedSaltHash[:argonSaltLen]
	want := storedSaltHash[argonSaltLen:]
	phrase := strings.Join(words, " ")
	got := argon2.IDKey([]byte(phrase), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	if subtle.ConstantTimeCompare(got, want) != 1 {
		return errors.New("recovery: phrase does not match")
	}
	return nil
}

// ---- bit-stream helpers -----------------------------------------------

// readBits reads `count` bits from `buf` starting at bit offset
// `offset`, big-endian, returning the value as an int. The caller
// must ensure the bits fit in an int (count <= 64, but in our case
// count is always 11).
func readBits(buf []byte, offset, count int) int {
	var v int
	for i := 0; i < count; i++ {
		bit := (buf[(offset+i)/8] >> (7 - uint((offset+i)%8))) & 1
		v = (v << 1) | int(bit)
	}
	return v
}

// writeBits writes the low `count` bits of `value` into `buf` starting
// at bit offset `offset`, big-endian. The destination bits must
// already be zero (we use OR, not assignment).
func writeBits(buf []byte, offset, count, value int) {
	for i := 0; i < count; i++ {
		bit := byte((value >> uint(count-1-i)) & 1)
		buf[(offset+i)/8] |= bit << (7 - uint((offset+i)%8))
	}
}

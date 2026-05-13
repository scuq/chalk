package auth

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

// expectedWordlistSha256 is the canonical SHA-256 of the BIP-39 English
// wordlist (2048 words, one per line, trailing newline). Verifies that
// the embedded file is uncorrupted.
const expectedWordlistSha256 = "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda"

func TestBIP39WordlistShape(t *testing.T) {
	// Hash check.
	h := sha256.Sum256([]byte(bip39EnglishRaw))
	got := hex.EncodeToString(h[:])
	if got != expectedWordlistSha256 {
		t.Errorf("wordlist sha256 mismatch:\ngot  %s\nwant %s", got, expectedWordlistSha256)
	}
	if len(bip39Wordlist) != 2048 {
		t.Errorf("bip39Wordlist length = %d, want 2048", len(bip39Wordlist))
	}
	if len(bip39WordToIndex) != 2048 {
		t.Errorf("bip39WordToIndex length = %d, want 2048", len(bip39WordToIndex))
	}
	// Spot-check a few well-known entries (BIP-39 spec, 0-indexed).
	for _, c := range []struct {
		idx  int
		word string
	}{
		{0, "abandon"},
		{1, "ability"},
		{2047, "zoo"},
		{627, "example"},
		{1978, "warrior"},
	} {
		if bip39Wordlist[c.idx] != c.word {
			t.Errorf("bip39Wordlist[%d] = %q, want %q", c.idx, bip39Wordlist[c.idx], c.word)
		}
		if bip39WordToIndex[c.word] != c.idx {
			t.Errorf("bip39WordToIndex[%q] = %d, want %d", c.word, bip39WordToIndex[c.word], c.idx)
		}
	}
}

func TestGenerateRecoveryWords(t *testing.T) {
	words, err := GenerateRecoveryWords()
	if err != nil {
		t.Fatalf("GenerateRecoveryWords: %v", err)
	}
	if len(words) != RecoveryWordCount {
		t.Errorf("len = %d, want %d", len(words), RecoveryWordCount)
	}
	for i, w := range words {
		if _, ok := bip39WordToIndex[w]; !ok {
			t.Errorf("word %d (%q) not in BIP-39 wordlist", i, w)
		}
	}
	// Generated phrases pass VerifyRecoveryWords (round-trip).
	if err := VerifyRecoveryWords(words); err != nil {
		t.Errorf("generated phrase failed VerifyRecoveryWords: %v", err)
	}
}

func TestGenerateRecoveryWordsAreDistinct(t *testing.T) {
	// Two separate calls should produce different phrases (probability
	// of a real collision is ~ 2^-256). If this ever flakes, the RNG
	// is broken.
	a, err := GenerateRecoveryWords()
	if err != nil {
		t.Fatal(err)
	}
	b, err := GenerateRecoveryWords()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(a, " ") == strings.Join(b, " ") {
		t.Fatal("two GenerateRecoveryWords calls produced identical phrases (RNG broken)")
	}
}

func TestVerifyRecoveryWordsRejectsWrongCount(t *testing.T) {
	for _, n := range []int{0, 1, 12, 23, 25} {
		words := make([]string, n)
		for i := range words {
			words[i] = "abandon"
		}
		if err := VerifyRecoveryWords(words); err == nil {
			t.Errorf("expected error for %d-word phrase", n)
		}
	}
}

func TestVerifyRecoveryWordsRejectsUnknownWord(t *testing.T) {
	words, err := GenerateRecoveryWords()
	if err != nil {
		t.Fatal(err)
	}
	words[5] = "definitelynotabip39word"
	if err := VerifyRecoveryWords(words); err == nil {
		t.Error("expected error for phrase with unknown word")
	}
}

func TestVerifyRecoveryWordsRejectsBadChecksum(t *testing.T) {
	// Swap two adjacent words in a generated phrase. The phrase still
	// consists of valid wordlist entries but the checksum byte will
	// no longer match.
	words, err := GenerateRecoveryWords()
	if err != nil {
		t.Fatal(err)
	}
	// Replace word 0 with a different valid wordlist word. With high
	// probability the checksum will no longer match.
	other := bip39Wordlist[(bip39WordToIndex[words[0]]+1)%2048]
	if other == words[0] {
		other = bip39Wordlist[(bip39WordToIndex[words[0]]+2)%2048]
	}
	words[0] = other
	if err := VerifyRecoveryWords(words); err == nil {
		t.Error("expected checksum error for tampered phrase")
	}
}

func TestNormalizeRecoveryWords(t *testing.T) {
	tests := []struct {
		in   string
		want []string
	}{
		{"abandon ability", []string{"abandon", "ability"}},
		{"  ABANDON\tability\nable ", []string{"abandon", "ability", "able"}},
		{"", []string{}},
		{"abandon  ability   able", []string{"abandon", "ability", "able"}},
	}
	for _, tt := range tests {
		got := NormalizeRecoveryWords(tt.in)
		if len(got) != len(tt.want) {
			t.Errorf("Normalize(%q): len = %d, want %d", tt.in, len(got), len(tt.want))
			continue
		}
		for i := range got {
			if got[i] != tt.want[i] {
				t.Errorf("Normalize(%q)[%d] = %q, want %q", tt.in, i, got[i], tt.want[i])
			}
		}
	}
}

func TestHashRecoveryWordsAndVerify(t *testing.T) {
	words, err := GenerateRecoveryWords()
	if err != nil {
		t.Fatal(err)
	}
	hash, err := HashRecoveryWords(words)
	if err != nil {
		t.Fatalf("HashRecoveryWords: %v", err)
	}
	if len(hash) != argonSaltLen+argonKeyLen {
		t.Errorf("hash length = %d, want %d", len(hash), argonSaltLen+argonKeyLen)
	}

	// Verifying with the same words: OK.
	if err := VerifyRecoveryCodeHash(hash, words); err != nil {
		t.Errorf("verify with correct words: %v", err)
	}

	// Verifying with wrong words: fails.
	wrong := make([]string, len(words))
	copy(wrong, words)
	// Swap two valid words to invalidate the phrase (likely also
	// breaks the checksum, but VerifyRecoveryWords runs first).
	wrong[0], wrong[1] = wrong[1], wrong[0]
	if err := VerifyRecoveryCodeHash(hash, wrong); err == nil {
		t.Error("expected verify with wrong words to fail")
	}
}

func TestHashRecoveryWordsRejectsBadInput(t *testing.T) {
	bad := make([]string, RecoveryWordCount)
	for i := range bad {
		bad[i] = "abandon"
	}
	// 24 "abandon"s do NOT have a valid checksum.
	if _, err := HashRecoveryWords(bad); err == nil {
		t.Error("expected HashRecoveryWords to refuse a phrase with bad checksum")
	}
}

func TestVerifyRecoveryCodeHashRejectsMalformedStored(t *testing.T) {
	words, _ := GenerateRecoveryWords()
	// Wrong-length stored hash.
	if err := VerifyRecoveryCodeHash([]byte{1, 2, 3}, words); err == nil {
		t.Error("expected error for short stored hash")
	}
}

func TestBitStreamRoundTrip(t *testing.T) {
	// Pure unit test for the bit helpers: write known values, read
	// them back.
	buf := make([]byte, 33)
	values := []int{0, 1, 1023, 2047, 1024, 512}
	offset := 0
	for _, v := range values {
		writeBits(buf, offset, 11, v)
		offset += 11
	}
	offset = 0
	for i, v := range values {
		got := readBits(buf, offset, 11)
		if got != v {
			t.Errorf("group %d: wrote %d, read %d", i, v, got)
		}
		offset += 11
	}
}

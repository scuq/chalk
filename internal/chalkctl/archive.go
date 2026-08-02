package chalkctl

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"io"

	"golang.org/x/crypto/argon2"
)

// 72-1: the password-encrypted container `chalkctl backup` writes and
// `chalkctl restore` reads.
//
// Layout -- a 32-byte header followed by a sequence of frames:
//
//	header:  magic[8] "CHALKBAK" | version[1] | salt[16] | noncePrefix[7]
//	frame:   final[1] | ctLen[4, big-endian] | ciphertext[ctLen]
//
// Each frame is one AES-256-GCM seal of at most archiveChunk plaintext bytes.
// The 12-byte nonce is noncePrefix || frameCounter (uint32 BE) || final, and
// the header is the additional data, so a frame that is reordered, duplicated,
// re-labelled, or paired with a substituted salt fails to open. Truncation --
// the one attack a per-frame tag cannot see -- is caught by reaching EOF
// before the frame marked final.
//
// It is framed rather than a single seal because the dump carries every
// attachment's ciphertext inline; a one-shot Seal would need the whole
// database in memory on both the backup and the restore host.
const (
	archiveMagic     = "CHALKBAK"
	archiveVersion   = 1
	archiveHeaderLen = 8 + 1 + 16 + 7
	archiveChunk     = 1 << 20 // plaintext bytes per frame

	// Argon2id parameters for version 1. Lower than the server's auth floor
	// (256 MiB) on purpose: this derivation also has to succeed on whatever
	// host the archive is being restored ONTO, next to a running Postgres,
	// and a 256 MiB allocation on a small VPS is a restore that fails on the
	// day it is needed. 64 MiB / 3 passes still costs an offline guesser
	// ~0.1s per attempt. The version byte is what a re-tuning would bump.
	archiveArgonTime    = 3
	archiveArgonMemory  = 64 * 1024
	archiveArgonThreads = 1
)

// ErrArchivePassword is returned when a frame fails to authenticate, which in
// practice means the password is wrong (a damaged file reads the same way).
var ErrArchivePassword = fmt.Errorf("cannot decrypt backup: wrong password, or the archive is corrupt")

func archiveAEAD(password string, salt []byte) (cipher.AEAD, error) {
	key := argon2.IDKey([]byte(password), salt,
		archiveArgonTime, archiveArgonMemory, archiveArgonThreads, 32)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func archiveNonce(prefix []byte, counter uint32, final byte) []byte {
	var n [12]byte
	copy(n[:7], prefix)
	binary.BigEndian.PutUint32(n[7:11], counter)
	n[11] = final
	return n[:]
}

// sealWriter encrypts everything written to it into w. Close MUST be called:
// it emits the final frame, without which the archive reads as truncated.
type sealWriter struct {
	w      io.Writer
	aead   cipher.AEAD
	hdr    []byte
	prefix []byte
	buf    []byte
	n      int
	ctr    uint32
	closed bool
}

func newSealWriter(w io.Writer, password string) (*sealWriter, error) {
	hdr := make([]byte, 0, archiveHeaderLen)
	hdr = append(hdr, archiveMagic...)
	hdr = append(hdr, archiveVersion)
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return nil, fmt.Errorf("generate salt: %w", err)
	}
	prefix := make([]byte, 7)
	if _, err := rand.Read(prefix); err != nil {
		return nil, fmt.Errorf("generate nonce prefix: %w", err)
	}
	hdr = append(hdr, salt...)
	hdr = append(hdr, prefix...)

	aead, err := archiveAEAD(password, salt)
	if err != nil {
		return nil, err
	}
	if _, err := w.Write(hdr); err != nil {
		return nil, err
	}
	return &sealWriter{w: w, aead: aead, hdr: hdr, prefix: prefix, buf: make([]byte, archiveChunk)}, nil
}

func (s *sealWriter) Write(p []byte) (int, error) {
	written := 0
	for len(p) > 0 {
		n := copy(s.buf[s.n:], p)
		s.n += n
		p = p[n:]
		written += n
		if s.n == len(s.buf) {
			if err := s.flush(0); err != nil {
				return written, err
			}
		}
	}
	return written, nil
}

func (s *sealWriter) Close() error {
	if s.closed {
		return nil
	}
	s.closed = true
	return s.flush(1)
}

func (s *sealWriter) flush(final byte) error {
	if s.ctr == ^uint32(0) {
		return fmt.Errorf("backup too large for one archive (%d frames)", s.ctr)
	}
	ct := s.aead.Seal(nil, archiveNonce(s.prefix, s.ctr, final), s.buf[:s.n], s.hdr)
	var frame [5]byte
	frame[0] = final
	binary.BigEndian.PutUint32(frame[1:], uint32(len(ct)))
	if _, err := s.w.Write(frame[:]); err != nil {
		return err
	}
	if _, err := s.w.Write(ct); err != nil {
		return err
	}
	s.ctr++
	s.n = 0
	return nil
}

// openReader decrypts an archive written by sealWriter. The password is
// stretched when the reader is constructed, so the caller pays the Argon2id
// cost once even though the frames are opened lazily.
type openReader struct {
	r      io.Reader
	aead   cipher.AEAD
	hdr    []byte
	prefix []byte
	buf    []byte
	off    int
	ctr    uint32
	done   bool
}

func newOpenReader(r io.Reader, password string) (*openReader, error) {
	hdr := make([]byte, archiveHeaderLen)
	if _, err := io.ReadFull(r, hdr); err != nil {
		return nil, fmt.Errorf("not a chalk backup archive (header too short)")
	}
	if string(hdr[:8]) != archiveMagic {
		return nil, fmt.Errorf("not a chalk backup archive (bad magic)")
	}
	if hdr[8] != archiveVersion {
		return nil, fmt.Errorf("backup archive format v%d, this chalkctl understands v%d", hdr[8], archiveVersion)
	}
	aead, err := archiveAEAD(password, hdr[9:25])
	if err != nil {
		return nil, err
	}
	return &openReader{r: r, aead: aead, hdr: hdr, prefix: hdr[25:32]}, nil
}

func (o *openReader) Read(p []byte) (int, error) {
	for o.off >= len(o.buf) {
		if o.done {
			return 0, io.EOF
		}
		if err := o.fill(); err != nil {
			return 0, err
		}
	}
	n := copy(p, o.buf[o.off:])
	o.off += n
	return n, nil
}

func (o *openReader) fill() error {
	var frame [5]byte
	if _, err := io.ReadFull(o.r, frame[:]); err != nil {
		return fmt.Errorf("backup archive is truncated (no final frame)")
	}
	n := binary.BigEndian.Uint32(frame[1:])
	if int(n) > archiveChunk+o.aead.Overhead() {
		return fmt.Errorf("backup archive frame is implausibly large (%d bytes)", n)
	}
	ct := make([]byte, n)
	if _, err := io.ReadFull(o.r, ct); err != nil {
		return fmt.Errorf("backup archive is truncated mid-frame")
	}
	pt, err := o.aead.Open(ct[:0], archiveNonce(o.prefix, o.ctr, frame[0]), ct, o.hdr)
	if err != nil {
		return ErrArchivePassword
	}
	o.buf, o.off, o.done = pt, 0, frame[0] == 1
	o.ctr++
	return nil
}

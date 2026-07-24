// chalk -- phase31-slice31-2 password helper tests.
package auth

import (
	"bytes"
	"testing"
)

func TestHashAuthProofDeterministic(t *testing.T) {
	p := []byte("some-32-byte-authproof-value....")
	a := HashAuthProof(p)
	b := HashAuthProof(p)
	if !bytes.Equal(a, b) {
		t.Fatal("HashAuthProof not deterministic")
	}
	if len(a) != 32 {
		t.Fatalf("expected 32-byte hash, got %d", len(a))
	}
	if bytes.Equal(a, HashAuthProof([]byte("different"))) {
		t.Fatal("distinct inputs hashed equal")
	}
}

func TestVerifyAuthProof(t *testing.T) {
	proof := []byte("client-authproof-bytes")
	stored := HashAuthProof(proof)

	if !VerifyAuthProof(stored, proof) {
		t.Fatal("correct proof rejected")
	}
	if VerifyAuthProof(stored, []byte("wrong")) {
		t.Fatal("wrong proof accepted")
	}
	if VerifyAuthProof(nil, proof) {
		t.Fatal("nil stored hash accepted (unenrolled must fail)")
	}
	if VerifyAuthProof([]byte("short"), proof) {
		t.Fatal("length-mismatched stored hash accepted")
	}
}

func TestDecoyKDFParamsStableAndDistinct(t *testing.T) {
	a1 := DecoyKDFParams("alice")
	a2 := DecoyKDFParams("alice")
	if !bytes.Equal(a1.Salt, a2.Salt) {
		t.Fatal("decoy salt not stable for the same username")
	}
	b := DecoyKDFParams("bob")
	if bytes.Equal(a1.Salt, b.Salt) {
		t.Fatal("decoy salts collide across usernames")
	}
	if len(a1.Salt) != 16 {
		t.Fatalf("expected 16-byte decoy salt, got %d", len(a1.Salt))
	}
	if a1.Alg != 1 {
		t.Fatalf("expected argon2id alg=1, got %d", a1.Alg)
	}
	// case/space normalised: "Alice " must match "alice"
	if !bytes.Equal(a1.Salt, DecoyKDFParams("  Alice ").Salt) {
		t.Fatal("decoy salt not normalised over case/whitespace")
	}
}

func TestParamsMeetFloor(t *testing.T) {
	mem := Argon2MemFloorKiB()
	it := Argon2ItersFloor()
	par := Argon2ParFloor()

	if !ParamsMeetFloor(1, mem, it, par) {
		t.Fatal("params at floor rejected")
	}
	if ParamsMeetFloor(1, mem-1, it, par) {
		t.Fatal("below-floor memory accepted")
	}
	if ParamsMeetFloor(2, mem, it, par) {
		t.Fatal("non-argon2id alg accepted")
	}
}

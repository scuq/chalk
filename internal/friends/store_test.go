package friends

import (
	"testing"

	"github.com/google/uuid"
)

func TestOrderPair(t *testing.T) {
	a := uuid.MustParse("11111111-1111-1111-1111-111111111111")
	b := uuid.MustParse("22222222-2222-2222-2222-222222222222")

	// (a, b) and (b, a) must produce the same ordered pair.
	a1, b1 := orderPair(a, b)
	a2, b2 := orderPair(b, a)
	if a1 != a2 || b1 != b2 {
		t.Errorf("not commutative: (%s,%s) vs (%s,%s)", a1, b1, a2, b2)
	}
	if a1 != a || b1 != b {
		t.Errorf("wrong order: got (%s,%s), want (%s,%s)", a1, b1, a, b)
	}
}

func TestPairLess(t *testing.T) {
	cases := []struct {
		a, b uuid.UUID
		want bool
	}{
		{
			uuid.MustParse("00000000-0000-0000-0000-000000000001"),
			uuid.MustParse("00000000-0000-0000-0000-000000000002"),
			true,
		},
		{
			uuid.MustParse("ffffffff-ffff-ffff-ffff-fffffffffffe"),
			uuid.MustParse("ffffffff-ffff-ffff-ffff-ffffffffffff"),
			true,
		},
		{
			uuid.MustParse("aaaaaaaa-0000-0000-0000-000000000000"),
			uuid.MustParse("aaaaaaaa-0000-0000-0000-000000000000"),
			false,
		},
		{
			uuid.MustParse("aaaaaaaa-0000-0000-0000-000000000001"),
			uuid.MustParse("aaaaaaaa-0000-0000-0000-000000000000"),
			false,
		},
	}
	for _, c := range cases {
		if got := pairLess(c.a, c.b); got != c.want {
			t.Errorf("pairLess(%s, %s) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

func TestStatusPrecedence(t *testing.T) {
	if statusPrecedence(StatusBlocked) <= statusPrecedence(StatusAccepted) {
		t.Error("blocked should outrank accepted")
	}
	if statusPrecedence(StatusAccepted) <= statusPrecedence(StatusPending) {
		t.Error("accepted should outrank pending")
	}
}

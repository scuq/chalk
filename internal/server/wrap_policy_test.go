package server

import "testing"

// 82-6: checkWrapPublish is the pure policy for what a member may deposit via
// publish_channel_key. Split from the handler precisely so these bounds can be
// asserted without a database.
func TestCheckWrapPublish(t *testing.T) {
	const s1Blob = 92  // suite-1 wrap
	const s2Blob = 188 // suite-2 wrap

	cases := []struct {
		name        string
		suite       int
		blobLen     int
		ver, curVer int
		sigRequired bool
		wantErr     bool
	}{
		{"suite-1 at current version, flag off", 1, s1Blob, 1, 1, false, false},
		{"suite-2 at current version, flag off", 2, s2Blob, 1, 1, false, false},
		{"suite-2 at current version, flag on", 2, s2Blob, 1, 1, true, false},

		// The enforcement flag: unsigned wraps stop being writable.
		{"suite-1 refused when signatures required", 1, s1Blob, 1, 1, true, true},

		// Rotation pre-uploads at current+1; that is the ONLY future version.
		{"current+1 is a legitimate rotation upload", 2, s2Blob, 4, 3, false, false},
		{"current+2 corresponds to no committable rotation", 2, s2Blob, 5, 3, false, true},
		{"far-future version refused", 2, s2Blob, 1000, 1, false, true},

		// The blob cap publish_channel_key never had (mint path always did).
		{"blob at the cap is accepted", 2, maxWrapBlobBytes, 1, 1, false, false},
		{"blob over the cap is refused", 2, maxWrapBlobBytes + 1, 1, 1, false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := checkWrapPublish(tc.suite, tc.blobLen, tc.ver, tc.curVer, tc.sigRequired)
			if (err != nil) != tc.wantErr {
				t.Fatalf("checkWrapPublish(%d, %d, v%d/cur%d, required=%v) = %v, wantErr=%v",
					tc.suite, tc.blobLen, tc.ver, tc.curVer, tc.sigRequired, err, tc.wantErr)
			}
		})
	}
}

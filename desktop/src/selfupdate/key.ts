// chalk-desktop -- the release key the self-updater trusts (105-1).
//
// The raw 32-byte Ed25519 public key, hex, from tools/make-release-key.sh.
// Empty means "no key pinned": verification refuses everything and the app
// stays on 104-4's behaviour (announce, link, install by hand). That is the
// state of a fork, and of this repo until scuq runs the script once and
// pastes the hex here in the same commit that first ships a signed release.
//
// Rotation: pin the new key here in a release whose SHA256SUMS.desktop is
// still signed by the OLD key -- the workflow signs with every
// RELEASE_SIGN_KEY_B64* secret it finds -- and drop the old signature one
// release later. A shell only ever needs one key to match.
export const RELEASE_PUBLIC_KEY_HEX = "540d485a1b76595d62ab9d7e71b9a58dff42abac983fd783dd2d09e77ee94a85";

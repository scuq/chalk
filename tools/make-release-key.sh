#!/usr/bin/env bash
# Create the Ed25519 release key the desktop self-updater trusts (phase 105-1).
# Run once, locally; never commit the private half.
#
#   bash tools/make-release-key.sh [outdir]   (default: ./signing, gitignored)
#
# Produces:
#   chalk-release.key   private key (PEM)  -> GitHub secret RELEASE_SIGN_KEY_B64 (base64)
#   chalk-release.pub   public key (PEM)   -> keep with the private key
#   chalk-release.hex   raw 32-byte public key, hex -> PIN IT in
#                         desktop/src/selfupdate/key.ts (RELEASE_PUBLIC_KEY_HEX)
#
# The release workflow signs SHA256SUMS.desktop with the private key
# (openssl pkeyutl -rawin); the shell verifies with WebCrypto against the
# pinned hex. Rotating the key = a release whose shell pins the new key
# while the sums are still signed by the old one -- both must sign during the
# overlap (the workflow accepts a second secret for that; see the phase doc).
#
# Set the secret:
#   gh secret set RELEASE_SIGN_KEY_B64 < <(base64 -w0 signing/chalk-release.key)
set -euo pipefail

out="${1:-signing}"
mkdir -p "$out"
chmod 700 "$out"

if [ -e "$out/chalk-release.key" ]; then
  echo "refusing to overwrite $out/chalk-release.key" >&2
  exit 1
fi

openssl genpkey -algorithm ed25519 -out "$out/chalk-release.key"
openssl pkey -in "$out/chalk-release.key" -pubout -out "$out/chalk-release.pub"
# The raw key is the last 32 bytes of the SubjectPublicKeyInfo DER.
openssl pkey -pubin -in "$out/chalk-release.pub" -outform DER | tail -c 32 | xxd -p | tr -d '\n' > "$out/chalk-release.hex"
chmod 600 "$out"/chalk-release.*

echo "wrote:"
ls -1 "$out"
echo
echo "public key (raw, hex) -- pin this in desktop/src/selfupdate/key.ts:"
cat "$out/chalk-release.hex"; echo
echo
echo "next:"
echo "  gh secret set RELEASE_SIGN_KEY_B64 < <(base64 -w0 $out/chalk-release.key)"

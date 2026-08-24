#!/usr/bin/env bash
# Create the self-signed Windows code-signing certificate the release workflow
# uses for the desktop app's chalk.exe (phase 104-4; the same arrangement as
# scuq's f9). Run once, locally; never commit the outputs.
#
#   bash tools/make-signing-cert.sh [outdir]   (default: ./signing, gitignored)
#
# Produces:
#   chalk-codesign.pfx  private key + cert  -> GitHub secret WIN_SIGN_PFX_B64 (base64)
#   chalk-codesign.cer  public cert (DER)   -> shipped in every Windows zip so a
#                                              workstation can trust it by hand
#   password.txt                            -> GitHub secret WIN_SIGN_PFX_PASSWORD
#
# Set the two secrets:
#   gh secret set WIN_SIGN_PFX_B64      < <(base64 -w0 signing/chalk-codesign.pfx)
#   gh secret set WIN_SIGN_PFX_PASSWORD < signing/password.txt
#
# Self-signed means SmartScreen still warns on first run ("unknown publisher");
# what it buys is a stable, verifiable identity across releases and a
# signature the self-updater (phase 105) can pin.
set -euo pipefail

out="${1:-signing}"
days="${CHALK_CERT_DAYS:-3650}"
subject="${CHALK_CERT_SUBJECT:-/CN=chalk (self-signed)/O=chalk}"
mkdir -p "$out"
chmod 700 "$out"

if [ -e "$out/chalk-codesign.pfx" ]; then
  echo "refusing to overwrite $out/chalk-codesign.pfx" >&2
  exit 1
fi

pass="$(openssl rand -base64 24)"
printf '%s' "$pass" > "$out/password.txt"
chmod 600 "$out/password.txt"

# Code-signing certificate: EKU codeSigning, digitalSignature only.
openssl req -x509 -newkey rsa:4096 -sha256 -days "$days" -nodes \
  -subj "$subject" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -keyout "$out/chalk-codesign.key" -out "$out/chalk-codesign.crt" >/dev/null 2>&1

# PFX for signtool (legacy ciphers keep it readable by Windows' PFX importer).
openssl pkcs12 -export -legacy \
  -inkey "$out/chalk-codesign.key" -in "$out/chalk-codesign.crt" \
  -name "chalk code signing" -passout "pass:$pass" -out "$out/chalk-codesign.pfx" 2>/dev/null \
|| openssl pkcs12 -export \
  -inkey "$out/chalk-codesign.key" -in "$out/chalk-codesign.crt" \
  -name "chalk code signing" -passout "pass:$pass" -out "$out/chalk-codesign.pfx"
openssl x509 -in "$out/chalk-codesign.crt" -outform DER -out "$out/chalk-codesign.cer"
chmod 600 "$out"/chalk-codesign.*

echo "wrote:"
ls -1 "$out"
echo
echo "fingerprint (SHA-256):"
openssl x509 -in "$out/chalk-codesign.crt" -noout -fingerprint -sha256
echo
echo "next:"
echo "  gh secret set WIN_SIGN_PFX_B64      < <(base64 -w0 $out/chalk-codesign.pfx)"
echo "  gh secret set WIN_SIGN_PFX_PASSWORD < $out/password.txt"

#!/usr/bin/env bash

# Local builds need a certificate-backed identity. An ad-hoc designated
# requirement contains the changing cdhash and invalidates macOS folder grants
# after an update. Use the existing local certificate, without notarization or
# Apple's timestamp service. This is not a distribution signing pipeline.
set -euo pipefail

sc_app_path="${1:-}"
sc_identity="${SC_DESKTOP_CODESIGN_IDENTITY:-Noted Terminal Dev}"
sc_expected_identifier="com.sc.desktop"

if [[ "$(uname -s)" != "Darwin" || ! -d "$sc_app_path" ]]; then
  echo '[codesign:sc-local] usage on macOS: bash scripts/codesign/sign-local-fast.sh <SC Desktop.app>' >&2
  exit 2
fi

if ! /usr/bin/security find-identity -v -p codesigning | /usr/bin/grep -F "\"$sc_identity\"" >/dev/null; then
  echo "[codesign:sc-local] missing local signing certificate: $sc_identity" >&2
  echo '[codesign:sc-local] set SC_DESKTOP_CODESIGN_IDENTITY to an installed code-signing identity; installation was not started' >&2
  exit 1
fi

sc_started_at=$SECONDS
echo "[codesign:sc-local] signing $sc_app_path with $sc_identity (local, no timestamp server)"
/usr/bin/codesign --deep --force --timestamp=none --sign "$sc_identity" "$sc_app_path"
# The existing local Python venv intentionally links to Xcode's interpreter.
# Verify every nested signature and the resource seal, but do not require those
# interpreter links to be contained in this bundle (strict=symlinks).
/usr/bin/codesign --verify --deep --strict=sideband "$sc_app_path"

sc_signature_info="$(/usr/bin/codesign -dv --verbose=4 "$sc_app_path" 2>&1)"
sc_identifier="$(printf '%s\n' "$sc_signature_info" | /usr/bin/awk -F= '/^Identifier=/{print $2; exit}')"
sc_authority="$(printf '%s\n' "$sc_signature_info" | /usr/bin/awk -F= '/^Authority=/{print $2; exit}')"
sc_requirement="$(/usr/bin/codesign -dr - "$sc_app_path" 2>&1)"

if [[ "$sc_identifier" != "$sc_expected_identifier" || "$sc_authority" != "$sc_identity" ]]; then
  echo "[codesign:sc-local] unexpected signature: identifier=$sc_identifier authority=$sc_authority" >&2
  exit 1
fi
if [[ "$sc_requirement" != *'certificate'* || "$sc_requirement" == *'cdhash'* ]]; then
  echo '[codesign:sc-local] the designated requirement is not stable across rebuilds' >&2
  exit 1
fi

echo "[codesign:sc-local] verified stable identity: $sc_identifier / $sc_authority elapsed=$((SECONDS - sc_started_at))s"

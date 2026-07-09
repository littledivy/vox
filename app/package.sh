#!/bin/bash
# Build Vox.app and wrap it in a distributable .dmg (drag-to-Applications).
#
#   ./package.sh                 # ad-hoc signed, local use
#   SIGN_ID="Developer ID Application: NAME (TEAMID)" ./package.sh   # signed
#   SIGN_ID="…" NOTARIZE=1 NOTARY_KEY_JSON=key.json ./package.sh     # notarized
#
# With a real SIGN_ID the app is signed with a hardened runtime + entitlements so
# it passes Gatekeeper with no "unidentified developer" prompt; NOTARIZE=1 then
# notarizes + staples so it opens with no authorization on any Mac.
set -euo pipefail
cd "$(dirname "$0")"

APP="dist/Vox.app"
DMG="dist/Vox.dmg"
SIGN_ID="${SIGN_ID:--}"                       # "-" = ad-hoc
NOTARIZE="${NOTARIZE:-0}"
ENTITLEMENTS="${ENTITLEMENTS:-$PWD/scripts/entitlements.plist}"
NOTARY_KEY_JSON="${NOTARY_KEY_JSON:-$HOME/Downloads/notarize-key.json}"

echo "› building Vox.app…"
deno task build

if [ "$SIGN_ID" = "-" ]; then
  echo "› ad-hoc signing…"
  codesign --force --deep --sign - "$APP"
else
  echo "› signing inside-out as: $SIGN_ID"
  sign() { codesign --force --timestamp --options runtime "$@"; }
  # Frameworks (dylibs, then any nested helper apps).
  if [ -d "$APP/Contents/Frameworks" ]; then
    find "$APP/Contents/Frameworks" -type f -name "*.dylib" | while read -r d; do sign -s "$SIGN_ID" "$d"; done
    find "$APP/Contents/Frameworks" -maxdepth 1 -name "*.app" | while read -r h; do sign --entitlements "$ENTITLEMENTS" -s "$SIGN_ID" "$h"; done
  fi
  # MacOS payload: dylibs get a plain sign, executables get entitlements (the
  # deno/laufey host runs V8, so it needs the JIT entitlements).
  for f in "$APP/Contents/MacOS/"*; do
    case "$(file -b "$f")" in
      *Mach-O*library*)    sign -s "$SIGN_ID" "$f" ;;
      *Mach-O*executable*) sign --entitlements "$ENTITLEMENTS" -s "$SIGN_ID" "$f" ;;
    esac
  done
  sign --entitlements "$ENTITLEMENTS" -s "$SIGN_ID" "$APP"
  codesign --verify --deep --strict "$APP"
fi

echo "› creating dmg…"
rm -f "$DMG"
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Vox" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
[ "$SIGN_ID" != "-" ] && codesign --force --timestamp --sign "$SIGN_ID" "$DMG"

if [ "$NOTARIZE" = "1" ]; then
  echo "› notarizing (waits for Apple)…"
  KEY="$(mktemp /tmp/notary.XXXXXX.p8)"; trap 'rm -f "$KEY"' EXIT
  creds=$(python3 - "$NOTARY_KEY_JSON" "$KEY" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); pk = d["private_key"].strip()
if "-----BEGIN" not in pk:
    pk = "-----BEGIN PRIVATE KEY-----\n" + "\n".join(pk[i:i+64] for i in range(0, len(pk), 64)) + "\n-----END PRIVATE KEY-----\n"
open(sys.argv[2], "w").write(pk)
print(d["key_id"], d["issuer_id"])
PY
)
  xcrun notarytool submit "$DMG" --key "$KEY" --key-id "${creds% *}" --issuer "${creds#* }" --wait
  xcrun stapler staple "$DMG"
  xcrun stapler staple "$APP"
fi

echo "✓ $DMG  ($(du -h "$DMG" | cut -f1))"

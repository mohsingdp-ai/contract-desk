#!/usr/bin/env bash
# Tap-through tests (Maestro) on an Android phone or emulator over adb: builds and installs the debug APK, pushes the
# sample files, runs test/maestro/flows in order, then removes everything it made and uninstalls the app.
#   ANDROID_SERIAL=<id>  which device, when more than one is connected
#   SKIP_BUILD=1         reuse the last built APK
#   KEEP=1               leave the app, records and files on the device afterwards
#   extra arguments go to `maestro test`, e.g. -e SHEETS=skip (a device without Google Sheets)
# The records go to Documents/Contract Desk. The script refuses to run if that folder (or the app's folder note)
# belongs to someone's real records, and deletes only what it created.
set -euo pipefail
cd "$(dirname "$0")/../.."

ADB="${ANDROID_HOME:-$HOME/Android/Sdk}/platform-tools/adb"
SERIAL="${ANDROID_SERIAL:-}"
if [ -z "$SERIAL" ]; then
  mapfile -t devices < <("$ADB" devices | awk 'NR > 1 && $2 == "device" { print $1 }')
  [ "${#devices[@]}" -eq 1 ] || { echo "Connect one device, or pick one with ANDROID_SERIAL (found: ${devices[*]:-none})" >&2; exit 1; }
  SERIAL=${devices[0]}
fi
adb() { "$ADB" -s "$SERIAL" "$@"; }
exists() { adb shell "[ -e '$1' ]"; }

APP=com.contractdesk.app
APK=android/app/build/outputs/apk/debug/app-debug.apk
FOLDER='/sdcard/Documents/Contract Desk'
MARK="$FOLDER/.maestro-test"
NOTE=/sdcard/Documents/.contract-desk-folder # the app's note of its folder, read by a fresh install
SAMPLES=/sdcard/Download/cd-maestro

# Never touch real records.
if exists "$FOLDER" && ! exists "$MARK"; then
  echo "$FOLDER already exists and was not made by these tests: it may hold real records. Nothing was changed." >&2
  exit 1
fi
if exists "$NOTE" && [ "$(adb shell cat "$NOTE")" != '/storage/emulated/0/Documents/Contract Desk' ]; then
  echo "$NOTE points the app at another folder ($(adb shell cat "$NOTE")). Nothing was changed." >&2
  exit 1
fi

[ -n "${SKIP_BUILD:-}" ] || npm run android:build

downloads_before=$(adb shell ls /sdcard/Download)
cleanup() {
  [ -n "${KEEP:-}" ] && return
  adb uninstall "$APP" >/dev/null || true
  adb shell "rm -rf '$FOLDER' '$SAMPLES'"
  exists "$NOTE" && adb shell rm "$NOTE"
  # Backups the flows saved to Downloads (anything there before the run stays).
  adb shell ls /sdcard/Download | grep -E '^contract-desk-(backup|export)' | while read -r f; do
    grep -qxF "$f" <<<"$downloads_before" || adb shell "rm '/sdcard/Download/$f'"
  done
  adb shell content call --method scan_volume --uri content://media --arg external_primary >/dev/null
}
trap cleanup EXIT

# Fresh install, empty test folder, sample files for the upload flow.
adb uninstall "$APP" >/dev/null 2>&1 || true
adb shell "rm -rf '$FOLDER' '$SAMPLES' && mkdir -p '$FOLDER' && touch '$MARK'"
samples=$(mktemp -d)
node test/maestro/seed.mjs "$samples"
adb push "$samples/." "$SAMPLES/" >/dev/null
rm -r "$samples"
adb shell content call --method scan_volume --uri content://media --arg external_primary >/dev/null
adb install "$APK" >/dev/null

maestro --device "$SERIAL" test "$@" test/maestro/flows

#!/bin/bash
set -euo pipefail

# Extract the Apple Photos app icon and generate favicon + touch icon.
# macOS only — uses sips (built-in image converter).
#
# Usage:
#   ./scripts/dump-icon.sh
#
# Produces:
#   public/favicon.png          32x32   Browser tab icon
#   public/apple-touch-icon.png 180x180 iOS home screen icon

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PUBLIC_DIR="${PROJECT_DIR}/public"

ICON="/System/Applications/Photos.app/Contents/Resources/AppIcon.icns"

if [[ ! -f "$ICON" ]]; then
    echo "Error: Photos.app icon not found at $ICON"
    echo "This script only works on macOS."
    exit 1
fi

echo "Extracting icon from Photos.app..."

sips -s format png -z 32 32 "$ICON" --out "${PUBLIC_DIR}/favicon.png" >/dev/null 2>&1
echo "  favicon.png (32x32)"

sips -s format png -z 180 180 "$ICON" --out "${PUBLIC_DIR}/apple-touch-icon.png" >/dev/null 2>&1
echo "  apple-touch-icon.png (180x180)"

echo "Done."

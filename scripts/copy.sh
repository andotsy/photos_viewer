#!/bin/bash
set -euo pipefail

# Copy an Apple Photos library to a destination, keeping only what the
# photo_viewer app needs: the SQLite database, originals, and derivatives.
#
# Excludes:
#   - database/search/         Spotlight index cache (thousands of tiny files, macOS-only)
#   - database/Photos.sqlite-wal  WAL journal (regenerated on open)
#   - database/Photos.sqlite-shm  Shared memory file (regenerated on open)
#   - private/                 Face/ML model data (not used)
#   - scopes/                  CloudKit sync metadata
#   - **/.*                    Hidden files (.DS_Store etc.)
#
# Prerequisites:
#   - Homebrew rsync recommended (macOS ships rsync 2.6.9 which lacks --info=progress2)
#     Install: brew install rsync
#   - Stop Photos daemons before copying for a clean snapshot:
#       launchctl disable user/$(id -u)/com.apple.photoanalysisd
#       launchctl disable user/$(id -u)/com.apple.photolibraryd
#       launchctl kill SIGTERM user/$(id -u)/com.apple.photoanalysisd
#       launchctl kill SIGTERM user/$(id -u)/com.apple.photolibraryd
#     Re-enable after copy:
#       launchctl enable user/$(id -u)/com.apple.photoanalysisd
#       launchctl enable user/$(id -u)/com.apple.photolibraryd
#
# Usage:
#   ./scripts/copy.sh <source.photoslibrary> <destination>
#
# Examples:
#   ./scripts/copy.sh ~/Pictures/Photos\ Library.photoslibrary /Volumes/USB/Photos
#   ./scripts/copy.sh /Users/me/Pictures/Old/Photos\ Library.photoslibrary user@router:/media/photos

usage() {
    echo "Usage: $0 <source.photoslibrary> <destination>"
    echo ""
    echo "  source   Path to .photoslibrary directory"
    echo "  dest     Local path or remote (user@host:/path)"
    echo ""
    echo "Options (env vars):"
    echo "  DRY_RUN=1        Show what would be copied without copying"
    echo "  NO_PROGRESS=1    Disable progress display"
    echo "  KILL_DAEMONS=1   Stop Photos daemons before copy, restart after"
    echo "  RSYNC_BIN=path   Path to rsync binary (default: auto-detect)"
    exit 1
}

if [[ $# -lt 2 ]]; then
    usage
fi

SRC="$1"
DST="$2"

# Validate source
if [[ ! -d "$SRC" ]]; then
    echo "Error: source does not exist or is not a directory: $SRC"
    exit 1
fi

# Ensure source path ends with / so rsync copies contents
SRC="${SRC%/}/"

# Check for the database to confirm it's actually a Photos library
if [[ ! -f "${SRC}database/Photos.sqlite" ]]; then
    echo "Error: no database/Photos.sqlite found in $SRC"
    echo "Are you sure this is an Apple Photos library?"
    exit 1
fi

# Find a decent rsync
if [[ -n "${RSYNC_BIN:-}" ]]; then
    RSYNC="$RSYNC_BIN"
elif command -v /opt/homebrew/bin/rsync &>/dev/null; then
    RSYNC="/opt/homebrew/bin/rsync"
elif command -v /usr/local/bin/rsync &>/dev/null; then
    RSYNC="/usr/local/bin/rsync"
else
    RSYNC="rsync"
fi

# Check rsync version for --info=progress2 support
RSYNC_VER=$("$RSYNC" --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "0.0.0")
RSYNC_MAJOR=$(echo "$RSYNC_VER" | cut -d. -f1)
RSYNC_MINOR=$(echo "$RSYNC_VER" | cut -d. -f2)
HAS_PROGRESS2=false
if [[ "$RSYNC_MAJOR" -gt 3 ]] || { [[ "$RSYNC_MAJOR" -eq 3 ]] && [[ "$RSYNC_MINOR" -ge 1 ]]; }; then
    HAS_PROGRESS2=true
fi

echo "Using: $RSYNC (v${RSYNC_VER})"
echo "Source: $SRC"
echo "Dest:   $DST"
echo ""

# --- Daemon management ---
UID_NUM=$(id -u)
DAEMONS_STOPPED=false

stop_daemons() {
    echo "Stopping Photos background daemons..."
    launchctl disable "user/${UID_NUM}/com.apple.photoanalysisd" 2>/dev/null || true
    launchctl disable "user/${UID_NUM}/com.apple.photolibraryd" 2>/dev/null || true
    launchctl kill SIGTERM "user/${UID_NUM}/com.apple.photoanalysisd" 2>/dev/null || true
    launchctl kill SIGTERM "user/${UID_NUM}/com.apple.photolibraryd" 2>/dev/null || true
    sleep 2
    DAEMONS_STOPPED=true
    echo "Daemons stopped."
}

start_daemons() {
    if [[ "$DAEMONS_STOPPED" == true ]]; then
        echo ""
        echo "Re-enabling Photos background daemons..."
        launchctl enable "user/${UID_NUM}/com.apple.photoanalysisd" 2>/dev/null || true
        launchctl enable "user/${UID_NUM}/com.apple.photolibraryd" 2>/dev/null || true
        echo "Daemons re-enabled (they'll start on next Photos.app launch)."
        DAEMONS_STOPPED=false
    fi
}

# Re-enable daemons on exit (Ctrl+C, error, etc.)
trap start_daemons EXIT

if [[ "${KILL_DAEMONS:-0}" == "1" ]]; then
    stop_daemons
fi

# --- Build rsync args ---
ARGS=(
    -av
    --delete
    # Only sync what we need
    --include='database/'
    --include='database/Photos.sqlite'
    --include='originals/***'
    --include='resources/'
    --include='resources/derivatives/***'
    --exclude='*'
)

# The above include/exclude pattern means:
# - Copy database/Photos.sqlite (the only DB file we need)
# - Copy everything under originals/
# - Copy everything under resources/derivatives/
# - Exclude everything else (search index, WAL, SHM, private/, scopes/, etc.)

# Progress
if [[ "${NO_PROGRESS:-0}" != "1" ]]; then
    if [[ "$HAS_PROGRESS2" == true ]]; then
        ARGS+=(--info=progress2)
    else
        ARGS+=(--progress)
    fi
fi

# Dry run
if [[ "${DRY_RUN:-0}" == "1" ]]; then
    ARGS+=(--dry-run)
    echo "*** DRY RUN — nothing will be copied ***"
    echo ""
fi

# Compression for remote destinations
if [[ "$DST" == *:* ]]; then
    ARGS+=(-z)
    echo "Remote destination detected, enabling compression."
    echo ""
fi

echo "Starting rsync..."
echo "  $RSYNC ${ARGS[*]} $SRC $DST"
echo ""

START=$(date +%s)

"$RSYNC" "${ARGS[@]}" "$SRC" "$DST"

END=$(date +%s)
ELAPSED=$((END - START))
MINS=$((ELAPSED / 60))
SECS=$((ELAPSED % 60))

echo ""
echo "Done in ${MINS}m ${SECS}s."

# Show what was copied
if [[ "${DRY_RUN:-0}" != "1" ]]; then
    if [[ "$DST" != *:* ]] && [[ -d "$DST" ]]; then
        SIZE=$(du -sh "$DST" 2>/dev/null | cut -f1)
        echo "Destination size: $SIZE"
    fi
fi

#!/bin/bash
set -euo pipefail

# Copy an Apple Photos library to a destination, keeping only what the
# photo_viewer app needs: the SQLite database, originals, and derivatives.
#
# The destination will contain a directory named after the source library
# (e.g. "Photos Library.photoslibrary/") with the synced contents inside.
#
# What gets copied:
#   - database/Photos.sqlite   The main database (includes face data as BLOBs)
#   - originals/               All original photos and videos
#   - resources/derivatives/   Pre-rendered thumbnails/previews
#
# What gets excluded:
#   - database/search/         Spotlight index cache (macOS-only)
#   - database/Photos.sqlite-wal  WAL journal (regenerated)
#   - database/Photos.sqlite-shm  Shared memory (regenerated)
#   - private/                 ML model caches (not needed — face crops are BLOBs in the DB)
#   - scopes/                  CloudKit sync metadata
#
# Non-native filesystems (SMB, exFAT, NFS, etc.):
#   The script auto-detects when the destination is on a non-native filesystem
#   and applies --size-only --no-perms --no-owner --no-group so rsync doesn't
#   re-transfer everything due to metadata differences the filesystem can't store.
#
# Prerequisites:
#   - Homebrew rsync recommended (macOS ships rsync 2.6.9 which lacks --info=progress2)
#     Install: brew install rsync
#
# Usage:
#   ./scripts/copy.sh <source.photoslibrary> <destination>
#
# Examples:
#   ./scripts/copy.sh ~/Pictures/Photos\ Library.photoslibrary /Volumes/USB/
#   ./scripts/copy.sh ~/Pictures/Photos\ Library.photoslibrary /Volumes/SMB_SHARE/
#   ./scripts/copy.sh /Users/me/Pictures/Old/Photos\ Library.photoslibrary user@router:/media/

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
    echo "  RSYNC_BIN=path   Path to local rsync binary (default: auto-detect)"
    echo "  REMOTE_RSYNC=p   Path to rsync on remote host (SSH destinations only)"
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

# Strip trailing slash, then we'll add it back explicitly below
SRC="${SRC%/}"

# Check for the database to confirm it's actually a Photos library
if [[ ! -f "${SRC}/database/Photos.sqlite" ]]; then
    echo "Error: no database/Photos.sqlite found in $SRC"
    echo "Are you sure this is an Apple Photos library?"
    exit 1
fi

LIB_NAME="$(basename "$SRC")"
DST="${DST%/}"

# Source with trailing slash = copy contents; destination includes library name
SRC_RSYNC="${SRC}/"
DST_RSYNC="${DST}/${LIB_NAME}/"

# --- Detect non-native filesystems (SMB, exFAT, FAT32, etc.) ---
# On these filesystems, rsync can't preserve Unix ownership/permissions and
# timestamps may have lower precision or get mangled. We auto-detect this
# and apply the right flags so the user doesn't have to remember SIZE_ONLY=1.
DEST_IS_FOREIGN_FS=false
DEST_FS=""
if [[ "$DST" != *:* ]] && [[ -d "$DST" ]]; then
    # Resolve the destination to an absolute path for mount matching
    DEST_REAL=$(cd "$DST" && pwd -P 2>/dev/null || echo "$DST")
    # Find the filesystem type by matching against mount points.
    # We iterate mount output and pick the longest mount point that is a
    # prefix of our destination path (to handle nested mounts correctly).
    BEST_LEN=0
    while IFS= read -r line; do
        # mount output format: "device on /mount/point (fstype, opts...)"
        mp=$(echo "$line" | sed -E 's/.+ on (.+) \(.+/\1/')
        fs=$(echo "$line" | sed -E 's/.+\(([^,)]+).*/\1/')
        # Check if dest path is at or under this mount point
        if [[ "$DEST_REAL" == "$mp" ]] || [[ "$DEST_REAL" == "$mp"/* ]]; then
            if [[ ${#mp} -gt $BEST_LEN ]]; then
                BEST_LEN=${#mp}
                DEST_FS="$fs"
            fi
        fi
    done < <(mount)
    DEST_FS_LOWER=$(echo "$DEST_FS" | tr '[:upper:]' '[:lower:]')
    case "$DEST_FS_LOWER" in
        smbfs|cifs|msdos|exfat|vfat|fat32|ntfs|fuseblk|nfs|afpfs|webdav)
            DEST_IS_FOREIGN_FS=true
            ;;
    esac
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
RSYNC_VER=$("$RSYNC" --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || true)
RSYNC_VER="${RSYNC_VER%%$'\n'*}"  # take first line only
RSYNC_VER="${RSYNC_VER:-0.0.0}"
RSYNC_MAJOR=$(echo "$RSYNC_VER" | cut -d. -f1)
RSYNC_MINOR=$(echo "$RSYNC_VER" | cut -d. -f2)
HAS_PROGRESS2=false
if [[ "$RSYNC_MAJOR" -gt 3 ]] || { [[ "$RSYNC_MAJOR" -eq 3 ]] && [[ "$RSYNC_MINOR" -ge 1 ]]; }; then
    HAS_PROGRESS2=true
fi

echo "Using: $RSYNC (v${RSYNC_VER})"
echo "Source: $SRC"
echo "Dest:   $DST_RSYNC"
echo ""

# --- Daemon management ---
UID_NUM=$(id -u)
DAEMONS_STOPPED=false

stop_daemons() {
    echo "Stopping Photos background daemons..."

    # 1. Disable via launchctl so they don't auto-restart
    launchctl disable "user/${UID_NUM}/com.apple.photoanalysisd" 2>/dev/null || true
    launchctl disable "user/${UID_NUM}/com.apple.photolibraryd" 2>/dev/null || true
    launchctl disable "user/${UID_NUM}/com.apple.mediaanalysisd" 2>/dev/null || true

    # 2. Kill running instances — killall is more reliable than launchctl kill
    killall -TERM photoanalysisd 2>/dev/null || true
    killall -TERM photolibraryd 2>/dev/null || true
    killall -TERM mediaanalysisd 2>/dev/null || true

    # 3. Wait and verify they're actually dead
    local max_wait=10
    local waited=0
    while [[ $waited -lt $max_wait ]]; do
        local still_running=false
        pgrep -q photoanalysisd 2>/dev/null && still_running=true
        pgrep -q photolibraryd 2>/dev/null && still_running=true
        pgrep -q mediaanalysisd 2>/dev/null && still_running=true
        if [[ "$still_running" == false ]]; then
            break
        fi
        sleep 1
        waited=$((waited + 1))
    done

    if [[ $waited -ge $max_wait ]]; then
        echo "Warning: some daemons still running after ${max_wait}s, sending SIGKILL..."
        killall -KILL photoanalysisd 2>/dev/null || true
        killall -KILL photolibraryd 2>/dev/null || true
        killall -KILL mediaanalysisd 2>/dev/null || true
        sleep 1
    fi

    DAEMONS_STOPPED=true
    echo "Daemons stopped."
}

start_daemons() {
    if [[ "$DAEMONS_STOPPED" == true ]]; then
        echo ""
        echo "Re-enabling Photos background daemons..."
        launchctl enable "user/${UID_NUM}/com.apple.photoanalysisd" 2>/dev/null || true
        launchctl enable "user/${UID_NUM}/com.apple.photolibraryd" 2>/dev/null || true
        launchctl enable "user/${UID_NUM}/com.apple.mediaanalysisd" 2>/dev/null || true
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
    # Compare by size only — photo/video files with matching sizes are the same
    # file. Avoids re-transferring everything when timestamps differ due to
    # filesystem type (SMB, exFAT), transfer method, or clock drift.
    --size-only
    # Only sync what we need
    --include='database/'
    --include='database/Photos.sqlite'
    --include='originals/***'
    --include='resources/'
    --include='resources/derivatives/***'
    --exclude='*'
)

# The above include/exclude pattern means:
# - Copy database/Photos.sqlite (includes all metadata + face crop BLOBs)
# - Copy everything under originals/
# - Copy everything under resources/derivatives/
# - Exclude everything else (search index, WAL, SHM, private/, scopes/, etc.)

# Non-native filesystem handling: SMB, exFAT, NFS, etc. can't preserve Unix
# ownership/permissions. Avoid rsync errors and unnecessary re-transfers.
if [[ "$DEST_IS_FOREIGN_FS" == true ]]; then
    echo "Detected non-native filesystem (${DEST_FS}) — adjusting rsync flags."
    ARGS+=(
        --no-perms        # can't preserve Unix permissions
        --no-owner        # can't preserve Unix owner
        --no-group        # can't preserve Unix group
        --chmod=ugo=rwX   # set sane permissions instead of failing
    )
    echo "  → --no-perms --no-owner --no-group --chmod=ugo=rwX"
    echo ""
fi
# Note: Face/person data (ZPERSON, ZDETECTEDFACE, ZFACECROP tables) are all
# stored in Photos.sqlite — no additional files needed for faces support.

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

# Remote destination handling
if [[ "$DST" == *:* ]]; then
    ARGS+=(-z)
    echo "Remote destination detected, enabling compression."
    # Use custom remote rsync path if provided, otherwise try common locations
    # where a working binary might live (e.g. extracted to /mnt to bypass
    # broken overlay on OpenWrt).
    if [[ -n "${REMOTE_RSYNC:-}" ]]; then
        ARGS+=(--rsync-path="$REMOTE_RSYNC")
        echo "Using remote rsync: $REMOTE_RSYNC"
    fi
    echo ""
fi

echo "Starting rsync..."
echo "  $RSYNC ${ARGS[*]} $SRC_RSYNC $DST_RSYNC"
echo ""

START=$(date +%s)

# Run rsync — exit code 24 means "some files vanished before they could be
# transferred", which is expected if Photos daemons are still active.
# Treat it as a warning, not an error.
set +e
"$RSYNC" "${ARGS[@]}" "$SRC_RSYNC" "$DST_RSYNC"
RSYNC_EXIT=$?
set -e

if [[ $RSYNC_EXIT -eq 24 ]]; then
    echo ""
    echo "Warning: rsync reported some files vanished during transfer (exit 24)."
    echo "This is normal if Photos daemons were running. The copy is still usable."
    echo "Re-run this script to pick up any missed files."
elif [[ $RSYNC_EXIT -ne 0 ]]; then
    echo ""
    echo "Error: rsync failed with exit code $RSYNC_EXIT"
    exit $RSYNC_EXIT
fi

END=$(date +%s)
ELAPSED=$((END - START))
MINS=$((ELAPSED / 60))
SECS=$((ELAPSED % 60))

echo ""
echo "Done in ${MINS}m ${SECS}s."

# Show what was copied
DEST_LIB="${DST}/${LIB_NAME}"
if [[ "${DRY_RUN:-0}" != "1" ]]; then
    if [[ "$DST" != *:* ]] && [[ -d "$DEST_LIB" ]]; then
        SIZE=$(du -sh "$DEST_LIB" 2>/dev/null | cut -f1)
        echo "Destination: $DEST_LIB ($SIZE)"
    fi
fi

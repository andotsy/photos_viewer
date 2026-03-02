#!/bin/bash
set -euo pipefail

# Build, transfer, and deploy photo_viewer to a remote Docker host via SSH.
#
# Usage:
#   ./scripts/deploy.sh                          Deploy to default host
#   ./scripts/deploy.sh user@host                Deploy to specific host
#   ./scripts/deploy.sh user@host /path/to/lib   Deploy with custom library path
#
# Environment variables:
#   DEPLOY_HOST        Remote SSH host (default: root@bebop-station.lan)
#   DEPLOY_LIB_PATH    Path to .photoslibrary on remote (default: /mnt/sda1/Media/Apple/Photos Library.photoslibrary)
#   DEPLOY_PORT        Host port to expose (default: 3001)
#   DEPLOY_ARCH        Architecture to build (default: arm64)
#   SKIP_BUILD         Set to 1 to skip building, use existing .tar.gz
#
# Examples:
#   ./scripts/deploy.sh
#   DEPLOY_PORT=8080 ./scripts/deploy.sh
#   SKIP_BUILD=1 ./scripts/deploy.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

HOST="${1:-${DEPLOY_HOST:-root@bebop-station.lan}}"
LIB_PATH="${2:-${DEPLOY_LIB_PATH:-/mnt/sda1/Media/Apple/Photos Library.photoslibrary}}"
PORT="${DEPLOY_PORT:-3001}"
ARCH="${DEPLOY_ARCH:-arm64}"
CONTAINER="photo_viewer"
IMAGE="photo_viewer:latest-${ARCH}"
TARBALL="${PROJECT_DIR}/photo_viewer_latest_${ARCH}.tar.gz"

# --- SSH multiplexing: reuse a single connection for all SSH/SCP calls ---
SSH_SOCK="/tmp/deploy-ssh-${HOST//[^a-zA-Z0-9]/_}"
# Clean up any stale socket from a previous run
ssh -S "$SSH_SOCK" -O check "$HOST" 2>/dev/null && ssh -S "$SSH_SOCK" -O exit "$HOST" 2>/dev/null || true
rm -f "$SSH_SOCK"
echo "Establishing SSH connection to $HOST..."
ssh -fNM -S "$SSH_SOCK" "$HOST"
cleanup_ssh() { ssh -S "$SSH_SOCK" -O exit "$HOST" 2>/dev/null || true; }
trap cleanup_ssh EXIT
# Wrapper: all SSH calls go through the master socket
rssh() { ssh -S "$SSH_SOCK" "$@"; }

echo "Deploy configuration:"
echo "  Host:      $HOST"
echo "  Library:   $LIB_PATH"
echo "  Port:      $PORT (-> 3000)"
echo "  Arch:      $ARCH"
echo ""

# --- Build ---
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
    echo "=== Building image ==="
    "$SCRIPT_DIR/build.sh" "$ARCH"
else
    echo "=== Skipping build (SKIP_BUILD=1) ==="
    if [[ ! -f "$TARBALL" ]]; then
        echo "Error: $TARBALL not found. Run without SKIP_BUILD or build first."
        exit 1
    fi
fi

echo ""
echo "=== Transferring image to $HOST ==="
REMOTE_TMP="/tmp/photo_viewer_${ARCH}.tar.gz"
rssh "$HOST" "cat > $REMOTE_TMP" < "$TARBALL"
echo "Transferred $(du -h "$TARBALL" | cut -f1) to $HOST:$REMOTE_TMP"

echo ""
echo "=== Loading image ==="
rssh "$HOST" "docker load < $REMOTE_TMP && rm -f $REMOTE_TMP"

echo ""
echo "=== Deploying container ==="
rssh "$HOST" "
    docker rm -f $CONTAINER 2>/dev/null || true
    docker run -d \
        --name $CONTAINER \
        --restart unless-stopped \
        -p ${PORT}:3000 \
        -v '${LIB_PATH}:/media:ro' \
        $IMAGE
"

echo ""
echo "=== Waiting for startup ==="
sleep 4
rssh "$HOST" "docker logs $CONTAINER 2>&1"

echo ""
echo "=== Deployed ==="
# Extract hostname/IP for the URL
HOST_ADDR="${HOST#*@}"
echo "Access at: http://${HOST_ADDR}:${PORT}"

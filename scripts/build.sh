#!/bin/bash
set -euo pipefail

# Build Docker images for photo_viewer and export as .tar.gz
#
# Usage:
#   ./scripts/build.sh              Build arm64 + amd64, export both
#   ./scripts/build.sh arm64        Build only arm64
#   ./scripts/build.sh amd64        Build only amd64
#   ./scripts/build.sh all          Build arm64 + amd64 (same as no args)
#   ./scripts/build.sh all v2       Build both with tag "v2"
#
# The first argument is the platform (arm64, amd64, all). Default: all.
# The second argument is the tag. Default: latest.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

IMAGE_NAME="photo_viewer"
ARCH="${1:-all}"
TAG="${2:-latest}"

build_one() {
    local arch="$1"
    local platform="linux/${arch}"
    local full_tag="${IMAGE_NAME}:${TAG}-${arch}"
    local output="${PROJECT_DIR}/${IMAGE_NAME}_${TAG}_${arch}.tar.gz"

    echo "=== Building ${full_tag} (${platform}) ==="
    docker build --platform "${platform}" -t "${full_tag}" "$PROJECT_DIR"

    echo "Exporting to ${output}..."
    docker save "${full_tag}" | gzip > "${output}"

    local size
    size=$(du -h "${output}" | cut -f1)
    echo "Done: ${output} (${size})"
    echo ""
}

case "$ARCH" in
    all)
        build_one arm64
        build_one amd64
        echo "=== All builds complete ==="
        ls -lh "${PROJECT_DIR}"/${IMAGE_NAME}_${TAG}_*.tar.gz
        ;;
    arm64|amd64)
        build_one "$ARCH"
        ;;
    *)
        echo "Unknown platform: $ARCH"
        echo "Usage: $0 [arm64|amd64|all] [tag]"
        exit 1
        ;;
esac

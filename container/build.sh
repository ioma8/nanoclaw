#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CLEAN_DANGLING="${CLEAN_DANGLING:-1}"
CLEAN_BUILDER_CACHE="${CLEAN_BUILDER_CACHE:-0}"

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

# Build with Docker
docker build --pull --rm -t "${IMAGE_NAME}:${TAG}" .

if [ "${CLEAN_DANGLING}" = "1" ]; then
  docker image prune -f >/dev/null
fi

if [ "${CLEAN_BUILDER_CACHE}" = "1" ]; then
  docker builder prune -f --filter=unused-for=24h >/dev/null
fi

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | docker run -i ${IMAGE_NAME}:${TAG}"

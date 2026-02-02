#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Building NanoClaw agent runner..."
cd "$SCRIPT_DIR/agent-runner"
npm run build

echo ""
echo "Build complete!"
echo "Agent runner: container/agent-runner/dist/index.js"

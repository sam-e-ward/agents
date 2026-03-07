#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

# Check pi is available
if ! command -v pi &>/dev/null; then
  echo "Error: pi is not installed or not on PATH" >&2
  exit 1
fi

# Install web-browser skill dependencies
if [ -f "$REPO_DIR/skills/web-browser/scripts/package.json" ]; then
  echo "Installing web-browser skill dependencies..."
  (cd "$REPO_DIR/skills/web-browser/scripts" && npm install --silent)
fi

# Install as global pi package
echo "Installing pi package from $REPO_DIR..."
pi install "$REPO_DIR"

echo "Done. Start pi and run /context to verify."

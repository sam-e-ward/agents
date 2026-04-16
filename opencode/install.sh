#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
OC_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
OC_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"

# Ensure opencode is available on PATH
if ! command -v opencode &>/dev/null; then
  OC_BIN="/opt/homebrew/bin/opencode"
  LINK_DIR="/usr/local/bin"
  if [ -x "$OC_BIN" ]; then
    echo "opencode not found on PATH — creating symlink at $LINK_DIR/opencode → $OC_BIN"
    sudo mkdir -p "$LINK_DIR"
    sudo ln -sf "$OC_BIN" "$LINK_DIR/opencode"
    echo "  ✓ Symlinked $LINK_DIR/opencode → $OC_BIN"
  else
    echo "Error: opencode is not installed at $OC_BIN and not on PATH" >&2
    echo "Install with: brew install opencode-ai/tap/opencode" >&2
    exit 1
  fi
fi

# Helper: create symlink, backing up existing real file
symlink_file() {
  local src="$1"
  local dst="$2"

  if [ ! -f "$src" ]; then
    echo "Warning: source file not found: $src" >&2
    return
  fi

  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
    echo "  ✓ $dst (already linked)"
    return
  fi

  if [ -f "$dst" ] && [ ! -L "$dst" ]; then
    local backup="${dst}.bak.$(date +%Y%m%d%H%M%S)"
    echo "  ⚠ Backing up existing file: $dst → $backup"
    mv "$dst" "$backup"
  fi

  if [ -L "$dst" ]; then
    rm "$dst"
  fi

  mkdir -p "$(dirname "$dst")"
  ln -s "$src" "$dst"
  echo "  ✓ Linked $dst → $src"
}

# Helper: create symlink for directory
symlink_dir() {
  local src="$1"
  local dst="$2"

  if [ ! -d "$src" ]; then
    echo "Warning: source directory not found: $src" >&2
    return
  fi

  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
    echo "  ✓ $dst (already linked)"
    return
  fi

  if [ -d "$dst" ] && [ ! -L "$dst" ]; then
    local backup="${dst}.bak.$(date +%Y%m%d%H%M%S)"
    echo "  ⚠ Backing up existing directory: $dst → $backup"
    mv "$dst" "$backup"
  fi

  if [ -L "$dst" ]; then
    rm "$dst"
  fi

  mkdir -p "$(dirname "$dst")"
  ln -s "$src" "$dst"
  echo "  ✓ Linked $dst → $src"
}

echo "=== Linking agents ==="
symlink_dir "$REPO_DIR/agents" "$OC_CONFIG_DIR/agents"

echo ""
echo "=== Linking skills ==="
symlink_dir "$REPO_DIR/skills" "$OC_CONFIG_DIR/skills"

echo ""
echo "=== Installing plugins ==="
PLUGIN_DIR="$REPO_DIR/plugins"
if [ -d "$PLUGIN_DIR" ]; then
  # Install plugin dependencies
  if [ -f "$PLUGIN_DIR/package.json" ]; then
    echo "  Installing plugin dependencies..."
    (cd "$PLUGIN_DIR" && npm install --silent 2>&1 | tail -1)
  fi

  # Register plugins in global config
  OC_GLOBAL_CONFIG="$OC_CONFIG_DIR/config.json"
  PLUGIN_PATH="$PLUGIN_DIR/auto-commit.ts"

  if [ -f "$PLUGIN_PATH" ]; then
    if [ -f "$OC_GLOBAL_CONFIG" ]; then
      # Check if plugin is already registered
      if grep -qF "$PLUGIN_PATH" "$OC_GLOBAL_CONFIG" 2>/dev/null; then
        echo "  ✓ auto-commit plugin already registered in $OC_GLOBAL_CONFIG"
      else
        # Add plugin to existing config using node for safe JSON manipulation
        node -e "
          const fs = require('fs');
          const cfg = JSON.parse(fs.readFileSync('$OC_GLOBAL_CONFIG', 'utf8'));
          if (!Array.isArray(cfg.plugin)) cfg.plugin = [];
          cfg.plugin.push('$PLUGIN_PATH');
          fs.writeFileSync('$OC_GLOBAL_CONFIG', JSON.stringify(cfg, null, 2) + '\n');
        "
        echo "  ✓ Added auto-commit plugin to $OC_GLOBAL_CONFIG"
      fi
    else
      # Create config with plugin
      mkdir -p "$(dirname "$OC_GLOBAL_CONFIG")"
      cat > "$OC_GLOBAL_CONFIG" <<EOF
{
  "plugin": ["$PLUGIN_PATH"]
}
EOF
      echo "  ✓ Created $OC_GLOBAL_CONFIG with auto-commit plugin"
    fi
  fi
else
  echo "  ⚠ Plugin directory not found: $PLUGIN_DIR"
fi

echo ""
echo "=== Configuring shell ==="
ZSHRC_LOCAL="$HOME/.zshrc.local"
OC_SHELL_MARKER="# opencode: reset terminal after exit"
if [ -f "$ZSHRC_LOCAL" ] && grep -qF "$OC_SHELL_MARKER" "$ZSHRC_LOCAL"; then
  echo "  ✓ opencode shell function already configured in $ZSHRC_LOCAL"
else
  {
    echo ""
    echo "$OC_SHELL_MARKER"
    echo 'opencode() { command opencode "$@"; reset }'
  } >> "$ZSHRC_LOCAL"
  echo "  ✓ Added opencode shell function to $ZSHRC_LOCAL"
fi

echo ""
echo "Done! Files linked from $REPO_DIR"
echo ""
echo "To use project instructions, copy or symlink opencode.md into your project root:"
echo "  ln -s $REPO_DIR/opencode.md /path/to/project/opencode.md"
echo ""
echo "Start opencode in a project directory to verify."

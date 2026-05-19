#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

# ── Detect OS ──────────────────────────────────────────────────────────
OS="$(uname -s)"
case "$OS" in
  Darwin)  IS_MAC=1; IS_LINUX=0 ;;
  Linux)   IS_MAC=0; IS_LINUX=1 ;;
  *)
    echo "Warning: unsupported OS '$OS'. Proceeding anyway, but some features may not work." >&2
    IS_MAC=0; IS_LINUX=0 ;;
esac

# ── Color helpers ──────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN} →${NC} $1"; }
ok()    { echo -e "${GREEN} ✓${NC} $1"; }
warn()  { echo -e "${YELLOW} ⚠${NC} $1"; }

# ── Ensure pi is on PATH ───────────────────────────────────────────────
ensure_pi() {
  if command -v pi &>/dev/null; then
    ok "pi found on PATH ($(command -v pi))"
    return
  fi

  # Common install locations
  for candidate in /opt/homebrew/bin/pi /usr/local/bin/pi /home/linuxbrew/.linuxbrew/bin/pi; do
    if [ -x "$candidate" ]; then
      LINK_DIR="/usr/local/bin"
      sudo mkdir -p "$LINK_DIR"
      sudo ln -sf "$candidate" "$LINK_DIR/pi"
      ok "Symlinked $LINK_DIR/pi → $candidate"
      return
    fi
  done

  # Try npx
  if command -v npx &>/dev/null; then
    warn "pi not installed. Run: npx @earendil-works/pi-coding-agent"
    return
  fi

  echo "Error: pi is not installed and couldn't be auto-detected." >&2
  echo "  Install with: npm install -g @earendil-works/pi-coding-agent" >&2
  exit 1
}

# ── Install Chromium/Chrome for web-browser skill ──────────────────────
ensure_browser() {
  echo ""
  echo "=== Web-browser skill: Checking browser ==="

  # Already installed?
  if [ -n "${CHROME_BIN:-}" ] && [ -x "$CHROME_BIN" ]; then
    ok "Browser found at CHROME_BIN=$CHROME_BIN"
    return
  fi

  if command -v chromium-browser &>/dev/null; then
    ok "chromium-browser found on PATH"
    return
  fi
  if command -v chromium &>/dev/null; then
    ok "chromium found on PATH"
    return
  fi
  if command -v google-chrome-stable &>/dev/null; then
    ok "google-chrome-stable found on PATH"
    return
  fi
  if command -v google-chrome &>/dev/null; then
    ok "google-chrome found on PATH"
    return
  fi
  if [ "$IS_MAC" = 1 ] && [ -d "/Applications/Google Chrome.app" ]; then
    ok "Google Chrome found in /Applications"
    return
  fi

  # Not found — install it
  if [ "$IS_LINUX" = 1 ]; then
    info "Installing chromium-browser via apt..."
    sudo apt-get update -qq
    sudo apt-get install -y -qq chromium-browser 2>&1 | tail -2
    ok "chromium-browser installed"
  elif [ "$IS_MAC" = 1 ]; then
    if command -v brew &>/dev/null; then
      info "Installing Google Chrome via brew..."
      brew install --cask google-chrome 2>&1 | tail -2
      ok "Google Chrome installed"
    else
      warn "Google Chrome not found. Install it manually from https://google.com/chrome"
      warn "Or set CHROME_BIN env var to the browser executable path."
    fi
  else
    warn "Unknown OS — please install chromium-browser or google-chrome manually."
    warn "Then set CHROME_BIN env var to the browser executable path."
  fi
}

# ── Symlink config files ───────────────────────────────────────────────
symlink_file() {
  local src="$1"
  local dst="$2"

  if [ ! -f "$src" ]; then
    warn "Source file not found: $src"
    return
  fi

  # Already the correct symlink
  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
    ok "$dst (already linked)"
    return
  fi

  # Back up real file if it exists
  if [ -f "$dst" ] && [ ! -L "$dst" ]; then
    local backup="${dst}.bak.$(date +%Y%m%d%H%M%S)"
    warn "Backing up existing file: $dst → $backup"
    mv "$dst" "$backup"
  fi

  # Remove stale symlink
  if [ -L "$dst" ]; then
    rm "$dst"
  fi

  mkdir -p "$(dirname "$dst")"
  ln -s "$src" "$dst"
  ok "Linked $dst → $src"
}

# ── Install npm dependencies for skills ────────────────────────────────
install_skill_deps() {
  echo ""
  echo "=== Installing skill dependencies ==="

  local skill_dirs=(
    "$REPO_DIR/skills/web-browser/scripts"
  )

  for dir in "${skill_dirs[@]}"; do
    if [ -f "$dir/package.json" ]; then
      info "Installing deps in $dir..."
      (cd "$dir" && npm install --silent 2>&1 | tail -1)
      ok "Dependencies installed in $dir"
    fi
  done
}

# ══════════════════════════════════════════════════════════════════════
# Main
# ══════════════════════════════════════════════════════════════════════

echo -e "${CYAN}═══════════════════════════════════════════${NC}"
echo -e "${CYAN}  pi agent environment setup${NC}"
echo -e "${CYAN}═══════════════════════════════════════════${NC}"
echo ""

ensure_pi
ensure_browser
install_skill_deps

echo ""
echo "=== Setting up symlinks ==="

symlink_file "$REPO_DIR/AGENTS.md" "$PI_DIR/AGENTS.md"
symlink_file "$REPO_DIR/philosophy.md" "$HOME/.pi/philosophy.md"

echo ""
echo "=== Linking agents ==="
for agent in "$REPO_DIR"/agents/*.md; do
  [ -f "$agent" ] || continue
  name=$(basename "$agent")
  symlink_file "$agent" "$PI_DIR/agents/$name"
done

echo ""
echo "=== Installing pi package ==="
pi install "$REPO_DIR"
ok "Package installed"

# Ensure pi runs `reset` after exit to restore terminal state
echo ""
echo "=== Configuring shell ==="
ZSHRC_LOCAL="$HOME/.zshrc.local"
PI_SHELL_MARKER="# pi: reset terminal after exit"
if [ -f "$ZSHRC_LOCAL" ] && grep -qF "$PI_SHELL_MARKER" "$ZSHRC_LOCAL"; then
  ok "pi shell function already configured in $ZSHRC_LOCAL"
else
  {
    echo ""
    echo "$PI_SHELL_MARKER"
    echo 'pi() { command pi "$@"; reset }'
  } >> "$ZSHRC_LOCAL"
  ok "Added pi shell function to $ZSHRC_LOCAL"
fi

echo ""
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo -e "${GREEN}  Done!${NC}"
echo -e "${GREEN}  Symlinks point to files in $REPO_DIR${NC}"
echo -e "${GREEN}  Chromium/Chrome: installed${NC}"
echo -e "${GREEN}  Skill deps: installed${NC}"
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo ""
echo "Start pi and run /context to verify."
echo ""
echo "Web-browser quick start:"
echo "  cd $REPO_DIR/skills/web-browser/scripts"
echo "  ./start.js"
echo "  ./nav.js https://example.com"
echo "  ./eval.js 'document.title'"
echo "  ./screenshot.js"

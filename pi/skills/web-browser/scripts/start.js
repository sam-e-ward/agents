#!/usr/bin/env node

import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";

const args = process.argv.slice(2);
const useProfile = args.includes("--profile");
const useHeadless = args.includes("--headless");

if (args.some((a) => a !== "--profile" && a !== "--headless")) {
  console.log("Usage: start.js [--profile] [--headless]");
  console.log("");
  console.log("Options:");
  console.log("  --profile   Copy your default Chrome/Chromium profile (cookies, logins)");
  console.log("  --headless  Run without a visible window (no GUI needed)");
  console.log("");
  console.log("Environment:");
  console.log("  CHROME_BIN        Path or command name of the browser binary");
  console.log("  CHROME_HEADLESS=1 Force headless mode");
  console.log("");
  console.log("Examples:");
  console.log("  start.js              # Start with fresh profile (visible window)");
  console.log("  start.js --headless   # Start headless (no window)");
  console.log("  start.js --profile    # Start with your existing profile");
  process.exit(1);
}

// Determine headless mode:
// 1. --headless flag  2. CHROME_HEADLESS=1 env  3. No DISPLAY → auto-headless
const forceHeadless = useHeadless || process.env.CHROME_HEADLESS === "1";
const noDisplay = !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
const headless = forceHeadless || noDisplay;

const HOME = homedir();
const IS_MAC = platform() === "darwin";
const IS_LINUX = platform() === "linux";

// ── Detect browser binary ─────────────────────────────────────────────

function findBrowser() {
  // CHROME_BIN env var takes highest precedence
  if (process.env.CHROME_BIN) {
    const bin = process.env.CHROME_BIN;
    if (existsSync(bin)) return bin;
    // Treat as a command name — check PATH
    try {
      const found = execSync(`which "${bin}"`, { encoding: "utf8" }).trim();
      if (found) return found;
    } catch {
      // fall through
    }
    console.warn(`Warning: CHROME_BIN=${bin} not found, trying auto-detect`);
  }

  if (IS_MAC) {
    const macPaths = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
    for (const p of macPaths) {
      if (existsSync(p)) return p;
    }
  }

  if (IS_LINUX) {
    const linuxCmds = [
      "chromium-browser",
      "chromium",
      "google-chrome-stable",
      "google-chrome",
    ];
    for (const cmd of linuxCmds) {
      try {
        const found = execSync(`which "${cmd}"`, { encoding: "utf8" }).trim();
        if (found) return found;
      } catch {
        // not found, try next
      }
    }
  }

  return null;
}

// ── Detect browser profile directory ──────────────────────────────────

function findProfileDir(browserPath) {
  const name = browserPath?.toLowerCase() || "";

  if (IS_MAC) {
    return `${HOME}/Library/Application Support/Google/Chrome`;
  }

  if (IS_LINUX) {
    if (name.includes("chromium")) {
      return `${HOME}/.config/chromium`;
    }
    // google-chrome(-stable)
    return `${HOME}/.config/google-chrome`;
  }

  return null;
}

// ── Main ──────────────────────────────────────────────────────────────

async function isDebugEndpointUp() {
  try {
    const response = await fetch("http://localhost:9222/json/version");
    return response.ok;
  } catch {
    return false;
  }
}

// If something is already listening on :9222, reuse it
if (await isDebugEndpointUp()) {
  console.log("✓ Browser already running on :9222 (reusing existing instance)");
  process.exit(0);
}

// Find browser
const browserPath = findBrowser();
if (!browserPath) {
  console.error("✗ No Chrome/Chromium found.");
  if (IS_LINUX) {
    console.error("  Install chromium-browser:");
    console.error("    sudo apt install chromium-browser");
    console.error("  Or set CHROME_BIN env var to the browser path.");
  } else if (IS_MAC) {
    console.error("  Install Google Chrome from https://google.com/chrome");
    console.error("  Or set CHROME_BIN env var to the browser path.");
  }
  process.exit(1);
}

// Setup profile directory
const cacheDir = `${HOME}/.cache/scraping`;
execSync(`mkdir -p "${cacheDir}"`, { stdio: "ignore" });

if (useProfile) {
  const profileDir = findProfileDir(browserPath);
  if (profileDir && existsSync(profileDir)) {
    console.log(`  Syncing profile from ${profileDir}...`);
    execSync(
      `rsync -a --delete "${profileDir}/" "${cacheDir}/"`,
      { stdio: "pipe" },
    );
    console.log("  ✓ Profile synced");
  } else {
    console.warn("  Warning: No existing browser profile found to copy.");
  }
}

console.log(`  Using browser: ${browserPath}`);

const launchArgs = [
  "--remote-debugging-port=9222",
  `--user-data-dir=${cacheDir}`,
  "--profile-directory=Default",
  "--disable-search-engine-choice-screen",
  "--no-first-run",
  "--disable-features=ProfilePicker",
  "--disable-gpu",
  "--disable-session-crashed-bubble",
];

if (headless) {
  launchArgs.push("--headless=new");
}

// --no-sandbox is needed in Docker, CI, WSL2, and other restricted environments.
// It's safe to always include since this is a dedicated debugging instance.
if (IS_LINUX) {
  launchArgs.push("--no-sandbox");
}

if (IS_MAC) {
  // macOS: use `open -na` to launch in background
  const appName = browserPath.endsWith("Google Chrome")
    ? "Google Chrome"
    : browserPath.endsWith("Chromium")
      ? "Chromium"
      : browserPath;

  spawn("/usr/bin/open", ["-na", appName, "--args", ...launchArgs], {
    detached: true,
    stdio: "ignore",
  }).unref();
} else {
  // Linux: spawn the binary directly
  const proc = spawn(browserPath, launchArgs, {
    detached: true,
    stdio: "ignore",
  });
  proc.unref();
}

// Wait for Chrome to be ready
let connected = false;
for (let i = 0; i < 30; i++) {
  try {
    const response = await fetch("http://localhost:9222/json/version");
    if (response.ok) {
      connected = true;
      break;
    }
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}

if (!connected) {
  console.error("✗ Failed to connect to browser on :9222");
  process.exit(1);
}

// Start background watcher for logs/network (detached)
const scriptDir = dirname(fileURLToPath(import.meta.url));
const watcherPath = join(scriptDir, "watch.js");
spawn(process.execPath, [watcherPath], { detached: true, stdio: "ignore" }).unref();

console.log(
  `✓ Browser started on :9222${useProfile ? " with your profile" : ""}`,
);

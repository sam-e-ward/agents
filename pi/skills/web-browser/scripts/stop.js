#!/usr/bin/env node

import { execSync } from "node:child_process";
import { homedir } from "node:os";

const HOME = homedir();
const PORT = 9222;

async function isDebugEndpointUp() {
  try {
    const response = await fetch(`http://localhost:${PORT}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

if (!(await isDebugEndpointUp())) {
  console.log(`✓ No browser running on :${PORT}`);
  process.exit(0);
}

// Gracefully close via CDP
try {
  const targets = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
  for (const target of targets) {
    if (target.type === "page") {
      const ws = new WebSocket(
        `ws://localhost:${PORT}/devtools/page/${target.id}`,
      );
      await new Promise((resolve) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({ id: 1, method: "Page.close" }));
          ws.close();
          resolve();
        };
        ws.onerror = () => resolve();
      });
    }
  }
} catch {
  // fall through to force-kill
}

// Kill the browser process
try {
  if (process.platform === "darwin") {
    execSync(`pkill -f "remote-debugging-port=${PORT}"`, { stdio: "pipe" });
  } else {
    execSync(`pkill -f "remote-debugging-port=${PORT}"`, { stdio: "pipe" });
  }
} catch {
  // process may already be gone
}

// Kill the detached watcher
try {
  execSync(`pkill -f "watch.js"`, { stdio: "pipe" });
} catch {
  // watcher may already be gone
}

console.log(`✓ Browser on :${PORT} stopped`);

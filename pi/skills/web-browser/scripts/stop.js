#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 9222;
const profileDir = join(homedir(), ".cache/scraping");
const watcherPath = join(dirname(fileURLToPath(import.meta.url)), "watch.js");
const watcherPidFile = join(homedir(), ".cache/agent-web/logs/.pid");

function processes() {
  return execFileSync("ps", ["-ax", "-o", "pid=", "-o", "command="], {
    encoding: "utf8",
  }).split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), command: match[2] }] : [];
  });
}

function isBrowser(command) {
  return command.includes(`--remote-debugging-port=${PORT}`) &&
    command.includes(`--user-data-dir=${profileDir}`) &&
    !command.includes("--type=");
}

function isWatcher(command) {
  return command.includes(watcherPath);
}

async function terminate(pid, matches) {
  if (!processes().some((p) => p.pid === pid && matches(p.command))) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  for (let i = 0; i < 20; i++) {
    if (!processes().some((p) => p.pid === pid && matches(p.command))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (processes().some((p) => p.pid === pid && matches(p.command))) {
    process.kill(pid, "SIGKILL");
  }
}

const running = processes();
const browsers = running.filter((p) => isBrowser(p.command));
const watchers = running.filter((p) => isWatcher(p.command));

// Stop only this skill's dedicated browser, never another process using :9222.
for (const browser of browsers) await terminate(browser.pid, isBrowser);
for (const watcher of watchers) await terminate(watcher.pid, isWatcher);

if (existsSync(watcherPidFile)) {
  // The watcher may have exited without removing its pid file.
  const pid = Number(readFileSync(watcherPidFile, "utf8").trim());
  if (!processes().some((p) => p.pid === pid && isWatcher(p.command))) {
    unlinkSync(watcherPidFile);
  }
}

console.log(browsers.length || watchers.length
  ? `✓ Browser on :${PORT} and log watcher stopped`
  : `✓ No skill browser or log watcher running`);

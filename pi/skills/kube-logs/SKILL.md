---
name: kube-logs
description: "Analyze Kubernetes pod/container logs that have been dumped to files. Find time gaps, extract pattern search timelines, and investigate slow requests. Safe read-only analysis — no kubectl access."
---

# Kube Logs Analysis Skill

Analyze Kubernetes log files that have been pre-dumped to `~/kube-logs/`. This skill provides read-only tools for structured log analysis — it cannot run kubectl, docker, or any other command.

## Safety

This skill provides a custom `kube_logs` tool that can **only read files** from `~/kube-logs/`. It cannot execute commands, connect to clusters, or modify anything. Use this tool exclusively for log analysis. **Do not use the `bash` tool for log processing.**

If no log files are found, tell the user to dump logs from a privileged session and stop. Do not attempt to fetch logs yourself.

## Setup

The user must dump logs from a privileged session first:

```bash
# From a session with kubectl access:
mkdir -p ~/kube-logs
just kube logs statefulset/cf-prod-be-82 > ~/kube-logs/cf-prod-be-82.log
```

## Tool

### `kube_logs` — Read and analyze log files

**Actions:**

- `list` — List available log files in `~/kube-logs/`
- `read` — Read a log file, optionally filtered by time range
- `gaps` — Find time gaps between consecutive log lines (reveals slow operations)
- `timeline` — Extract a structured timeline of operations between two timestamps

### Examples

```
kube_logs(action: "list")
kube_logs(action: "read", file: "cf-prod-be-82.log", start: "14:11:00", end: "14:20:00")
kube_logs(action: "read", file: "cf-prod-be-82.log", start: "14:11:00", end: "14:20:00", grep: "results for pattern")
kube_logs(action: "gaps", file: "cf-prod-be-82.log", start: "14:11:00", end: "14:20:00", min_gap: 10)
kube_logs(action: "timeline", file: "cf-prod-be-82.log", start: "14:11:00", end: "14:20:00")
```

## Workflow

### Step 1 — Check available logs

```
kube_logs(action: "list")
```

If no files exist, tell the user:
> No log files found in ~/kube-logs/. Dump logs from a privileged session first:
> ```
> mkdir -p ~/kube-logs
> just kube logs <resource> > ~/kube-logs/<name>.log
> ```

### Step 2 — Identify the time window

Ask the user what time range to investigate, or use `read` to scan the file and find relevant timestamps.

### Step 3 — Analyze

Use the appropriate action:

- **`gaps`** to find where time was spent (big gaps = slow operations)
- **`read` with `grep`** to filter for specific log patterns
- **`timeline`** for a structured overview of what happened

### Step 4 — Investigate specific patterns

For Countfire backend logs, common patterns to grep for:

- `"results for pattern"` — pattern search results (selection_id is the number after "pattern")
- `"Starting TrackedSearch"` — drawing load initiated
- `"Loading file"` — asset library fetch
- `"Adding .* elements to the SearchManager"` — element count
- `"remaining unseen patterns"` — number of patterns to search
- `"Resolving clash"` — clash resolution phase
- `"SIGPIPE"` — client disconnected (timeout)
- `"Reapplying action"` — operation replay
- `"Classifier loaded"` — classifier initialization

## Countfire Log Analysis Patterns

### Slow Drawing Load

A typical drawing load flows through:
1. `Starting TrackedSearch` — session begins
2. `Loading file` — fetch SVG from asset library (can be slow for large files)
3. `Skipped N duplicates during parsed svg load` — SVG parsing
4. `Ignoring N elements` — filter/background rules applied
5. `Adding N elements to the SearchManager` — index built
6. `Classifier loaded` — ML classifier initialized
7. `N remaining unseen patterns after pattern search cache` — patterns to search
8. Per-pattern results logged
9. `Resolving clash` — clash resolution
10. Response sent (or SIGPIPE if client timed out)

### Finding Slow Patterns

Use `gaps` to find time gaps during pattern search. The pattern logged immediately AFTER a gap is the one that was slow (it was the last to finish on the parallel worker pool). With N CPU cores, the first N patterns completing after a gap represent one-per-core — the slowest of that batch.

The pattern IDs in the log correspond to `selection_id` values in the database.

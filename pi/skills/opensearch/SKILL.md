---
name: opensearch
description: "Search and analyze Kubernetes application logs via OpenSearch. Find slow requests, errors, trace request flows, and investigate incidents. Safe read-only access — queries only."
---

# OpenSearch Skill

Search and analyze Kubernetes application logs via OpenSearch. This skill provides a `opensearch` tool that can **only perform read-only HTTP queries** against OpenSearch. It cannot run kubectl, docker, or any other command.

## Safety

The `opensearch` tool makes HTTP GETs/POSTs to an OpenSearch instance over HTTPS (via Tailscale). It cannot execute commands, connect to clusters, or modify anything. **Do not use the `bash` tool for log queries.**

## Host Configuration

The tool reads the OpenSearch hostname from the knowledge file at `~/.pi/opensearch-knowledge/<environment>.md`. It looks for a metadata line:

```
opensearch_host: cf-prod-opensearch
```

This hostname is resolved via Tailscale MagicDNS and connected to over HTTPS (port 443).

### First-time setup

If no host is configured, the tool will report that no host is found. Ask the user for the Tailscale hostname, then save it:

```
opensearch(action: "set_host", host: "cf-prod-opensearch")
```

This tests connectivity and saves the hostname to the knowledge file for future use.

### If connectivity fails

The host machine must have Tailscale access to the OpenSearch instance. If the tool reports the host is unreachable, tell the user to check their Tailscale connection. **Do not attempt to fix connectivity yourself — never use bash to debug networking.** Just report the error and stop.

## Tool

### `opensearch` — Search and analyze logs

**Actions:**

- `services` — List available container/service names
- `search` — Search logs with filters (service, time range, text match)
- `slow_requests` — Find the slowest HTTP requests (uwsgi `generated X bytes in Y msecs`)
- `errors` — Find error-level log lines
- `count` — Count log lines matching filters, grouped by service or time interval
- `set_host` — Configure the OpenSearch Tailscale hostname (saved to knowledge file)

### Examples

```
opensearch(action: "set_host", host: "cf-prod-opensearch")
opensearch(action: "services")
opensearch(action: "search", service: "cf-prod-be", start: "2026-04-07T14:10:00", end: "2026-04-07T14:20:00")
opensearch(action: "search", service: "cf-prod-be", start: "-5m", grep: "SIGPIPE")
opensearch(action: "slow_requests", start: "-30m", min_duration_ms: 5000)
opensearch(action: "slow_requests", service: "cf-prod-api", start: "-1h", limit: 20)
opensearch(action: "errors", service: "cf-prod-be", start: "-15m")
opensearch(action: "count", start: "-1h", group_by: "service")
```

## Scope — Logs Only

**This skill is strictly for log analysis.** When investigating an issue:

- **Only use the `opensearch` tool.** Never use `ipython`, `bash`, or database queries to look up IDs, drawing names, or other context found in logs.
- If you find drawing IDs, pattern IDs, session IDs, or other identifiers in the logs, **report them as-is**. The user knows these IDs are visible in the logs — that's why they're asking.
- Do not attempt to "enrich" log data by querying a database or running code. The answer must come entirely from the logs.

## ⚠️ MANDATORY: Load Knowledge BEFORE Any Investigation

**You MUST load the environment knowledge file before running any investigative queries.** This is not optional. Skipping this step leads to misinterpreting normal behaviour as problems, missing known patterns, and asking questions already answered in the knowledge file.

1. Run `opensearch(action: "services")` to check connectivity and identify the environment
2. Read `~/.pi/opensearch-knowledge/<environment>.md` using the `read` tool
3. Only then proceed to answer the user's question

If the knowledge file doesn't exist yet, run the discovery queries in Step 2 below to create it first.

---

## Workflow

### Step 1 — Check connectivity and load knowledge

```
opensearch(action: "services")
```

If this fails because no host is configured, ask the user for the Tailscale hostname and use `set_host` to save it. If it fails because the host is unreachable, tell the user to check their Tailscale connection and stop.

Then **immediately** load the knowledge file:

1. **Identify the environment**: the `services` action auto-detects the environment from OpenSearch index names (e.g. `cf-prod` from `cf-prod-fluentd-2026.04.07`).

2. **Load knowledge**: use the `read` tool to read `~/.pi/opensearch-knowledge/<environment>.md`. This contains previously discovered information about the environment — service names, log formats, request flows, known slow paths, and what is normal. Pay close attention to these — they prevent you from misinterpreting expected behaviour as problems. **Do not proceed to investigation without reading this file.**

### Step 2 — First-time discovery (only if no knowledge file exists)

If the knowledge file does not exist, run discovery:

```
opensearch(action: "services")
opensearch(action: "count", start: "-1h", group_by: "service")
```

Then create the knowledge file with what was found. Use the template below.

### Step 3 — Investigate the user's question

Choose the right action based on the question:

- **"Find slow requests"** → `slow_requests` with appropriate service/time filters
- **"What happened at 14:15?"** → `search` with a narrow time window
- **"Any errors in the last hour?"** → `errors` with `start: "-1h"`
- **"Which service is busiest?"** → `count` with `group_by: "service"`

Once you've identified an interesting request or time window, use `search` with a narrow time range to see the full context — surrounding log lines, the sequence of operations, and timing.

### ⚠️ MANDATORY: Use `pipe` for bulk log analysis

**When analyzing more than a handful of logs, you MUST use the `pipe` parameter** to extract only the fields you need. Raw log lines are verbose — dumping hundreds of them into context wastes tokens and makes analysis harder.

The workflow is **sample → pipe → analyze**:

#### 1. Sample: Grab a few representative logs to see the format

```
opensearch(action: "search", service: "cf-prod-be", start: "...", end: "...", grep: "drawing_state", limit: 3)
```

Read the output to understand field positions and patterns.

#### 2. Pipe: Build a grep + awk pipeline to extract what you need

Based on the sample, craft a pipe that extracts only the relevant fields. The pipe operates on formatted log lines with this structure:

```
YYYY-MM-DD HH:MM:SS  service/pod  <original log message>
```

The timestamp is fields `$1 $2`, service/pod is `$3`, and the rest is the original message.

Example — extract drawing IDs and durations from uwsgi access logs:

```
opensearch(action: "search", service: "cf-prod-be", start: "...", end: "...", grep: "drawing_state",
  pipe: "grep 'msecs' | sed 's/.*drawing_state\\///' | awk '{split($1,a,\" \"); id=a[1]; for(i=1;i<=NF;i++) if($i==\"in\") {dur=$(i+1); break} print id, dur \"ms\"}'")
```

#### 3. Analyze: Run the pipe over the full dataset

Use a high limit (the default is 2000 when pipe is set) to capture all relevant logs. The pipe compresses the output so only the extracted fields enter context.

#### Tips for effective pipes

- **Always test your pipe on the sample first** by including it in a `limit: 5` call
- **grep first, awk second** — filter down to relevant lines before extracting fields
- **Use `sort` and `uniq -c`** to aggregate (e.g. count requests per drawing ID)
- **Use `sort -rn` and `head`** to find top-N by some numeric field
- **Allowed commands**: grep, egrep, fgrep, awk, sed, sort, uniq, head, tail, wc, cut, tr, column

#### Example

```
# Step 1: Sample a few logs to see the actual format
opensearch(action: "search", service: "cf-prod-be", start: "-1h", grep: "some_endpoint", limit: 3)

# Step 2: Read the sample output, identify which fields you need and their positions,
# then craft a pipe to extract just those fields.
# The pipe should be derived entirely from the sample — do not assume a format.

opensearch(action: "search", service: "cf-prod-be", start: "-1h", grep: "some_endpoint",
  pipe: "<grep/awk/sed pipeline derived from the sample log format>")
```

### Step 4 — Update knowledge

If you discovered anything new that is **generic to the environment** (a service's log format, request flow patterns, what's normal, known slow paths), **append it to the knowledge file** so future sessions benefit. Do not record specific incidents — only generic learnings about the environment's normal behaviour and characteristics.

## Analysis Tips

### uwsgi Request Lines

Many services use uwsgi which logs request completion as:
```
[pid: 850|app: 0|req: 810/1594] 172.16.x.x () {N vars in N bytes} [Tue Apr 7 14:11:03 2026] GET /path => generated N bytes in N msecs (HTTP/1.1 200) ...
```

Key fields:
- **pid** — worker process ID (same pid = same worker)
- **req: N/M** — request number for this worker / total
- **generated N bytes in N msecs** — response size and total duration
- **HTTP status** — 200, 500, etc.

For long requests, use `search` to find all log lines from that pid in that time window to understand what happened inside the request.

### Time Gaps in Sequential Services

Some services process requests sequentially per worker (e.g. backend workers). When analyzing logs from these services, large time gaps between consecutive log lines from the same pid indicate slow operations — the worker was busy doing something that didn't produce log output.

### Correlating Across Services

A single user action often touches multiple services. Use timestamps and request paths to correlate log lines across services.

## Knowledge File Template

```markdown
# Environment: <environment-name>
opensearch_host: <tailscale-hostname>

## Environment Info
- Environment: <environment-name>
- Discovered: <date>

## Services
- <service-name>: <description, what it does>

## Log Formats
- <service>: <describe the log format, what fields are present>

## Request Flows
- <describe how requests flow through services>
- <note which services are sequential per worker vs concurrent>

## Known Slow Paths
- <endpoint or operation>: <typical duration, why it's slow, what's normal>

## What's Normal
- <describe patterns that look alarming but are expected>
- <note baseline durations, sizes, error rates>

## Notes
- <anything learned during investigations>
```

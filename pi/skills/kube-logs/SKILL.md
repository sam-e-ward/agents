---
name: kube-logs
description: "Search and analyze Kubernetes application logs via OpenSearch. Find slow requests, errors, trace request flows, and investigate incidents. Safe read-only access — queries only."
---

# Kube Logs Skill

Search and analyze Kubernetes application logs via OpenSearch. This skill provides a `kube_logs` tool that can **only perform read-only HTTP queries** against a local port. It cannot run kubectl, docker, or any other command.

## Safety

The `kube_logs` tool makes HTTP GETs/POSTs to `localhost:9201` (OpenSearch search API only). It cannot execute commands, connect to clusters, or modify anything. **Do not use the `bash` tool for log queries.**

If the tool reports that OpenSearch is unreachable, tell the user to start a port-forward and stop. **Do not attempt to fix connectivity yourself — never use bash to debug, start, or restart socat, ssh tunnels, or any port-forwarding process.** Just ask the user to set it up and wait.

## Setup

The user must forward OpenSearch to localhost first. **This is the user's responsibility — never start, restart, or debug port-forwards yourself.** If connectivity fails, show the user these commands and stop:

```bash
# Via SSH tunnel (if OpenSearch is accessible via Tailscale on a remote host):
ssh -L 9201:cf-prod-opensearch:443 <jumphost> -N &

# Or, if running on a host with direct Tailscale access:
socat TCP-LISTEN:9201,fork,reuseaddr OPENSSL:cf-prod-opensearch:443,verify=0 &
```

## Tool

### `kube_logs` — Search and analyze logs

**Actions:**

- `services` — List available container/service names
- `search` — Search logs with filters (service, time range, text match)
- `slow_requests` — Find the slowest HTTP requests (uwsgi `generated X bytes in Y msecs`)
- `errors` — Find error-level log lines
- `count` — Count log lines matching filters, grouped by service or time interval

### Examples

```
kube_logs(action: "services")
kube_logs(action: "search", service: "cf-prod-be", start: "2026-04-07T14:10:00", end: "2026-04-07T14:20:00")
kube_logs(action: "search", service: "cf-prod-be", start: "-5m", grep: "SIGPIPE")
kube_logs(action: "slow_requests", start: "-30m", min_duration_ms: 5000)
kube_logs(action: "slow_requests", service: "cf-prod-api", start: "-1h", limit: 20)
kube_logs(action: "errors", service: "cf-prod-be", start: "-15m")
kube_logs(action: "count", start: "-1h", group_by: "service")
```

## Scope — Logs Only

**This skill is strictly for log analysis.** When investigating an issue:

- **Only use the `kube_logs` tool.** Never use `ipython`, `bash`, or database queries to look up IDs, drawing names, or other context found in logs.
- If you find drawing IDs, pattern IDs, session IDs, or other identifiers in the logs, **report them as-is**. The user knows these IDs are visible in the logs — that's why they're asking.
- Do not attempt to "enrich" log data by querying a database or running code. The answer must come entirely from the logs.

## Workflow

### Step 1 — Check connectivity

```
kube_logs(action: "services")
```

If this fails, relay the setup instructions to the user and stop.

### Step 2 — Load or create environment knowledge

Knowledge files are stored at `~/.pi/kube-logs-knowledge/<environment>.md`.

1. **Identify the environment**: the `services` action auto-detects the environment from OpenSearch index names (e.g. `cf-prod` from `cf-prod-fluentd-2026.04.07`).

2. **Load knowledge**: read `~/.pi/kube-logs-knowledge/<environment>.md` if it exists. This contains previously discovered information about the environment — service names, log formats, request flows, known slow paths, and what is normal. Pay close attention to these — they prevent you from misinterpreting expected behaviour as problems.

3. **First time? Run discovery** (only if no knowledge file exists):
   ```
   kube_logs(action: "services")
   kube_logs(action: "count", start: "-1h", group_by: "service")
   ```
   Then create the knowledge file with what was found. Use the template below.

### Step 3 — Investigate the user's question

Choose the right action based on the question:

- **"Find slow requests"** → `slow_requests` with appropriate service/time filters
- **"What happened at 14:15?"** → `search` with a narrow time window
- **"Any errors in the last hour?"** → `errors` with `start: "-1h"`
- **"Which service is busiest?"** → `count` with `group_by: "service"`

Once you've identified an interesting request or time window, use `search` with a narrow time range to see the full context — surrounding log lines, the sequence of operations, and timing.

### Step 4 — Update knowledge

If you discovered anything new about the environment (a service's log format, request flow patterns, what's normal, known slow paths, incident learnings), **append it to the knowledge file** so future sessions benefit.

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

## Incident History
- <date> — <brief description and root cause>

## Notes
- <anything learned during investigations>
```

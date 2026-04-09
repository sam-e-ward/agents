---
name: victoria-metrics
description: "Query VictoriaMetrics to investigate Kubernetes cluster health, debug incidents, and answer infrastructure questions. Covers CPU, memory, pods, nodes, restarts, OOMKills, and more."
---

# VictoriaMetrics Query Skill

Query a VictoriaMetrics instance (via its Prometheus-compatible API) to investigate Kubernetes infrastructure questions.

## Safety

This skill provides two custom tools — `vm_query` and `vm_labels` — that can **only** perform HTTP GETs against `localhost:8481`. They cannot run kubectl, docker, or any other command. Use these tools exclusively for all VictoriaMetrics queries. **Do not use the `bash` tool for querying metrics.**

If the tools report that VictoriaMetrics is unreachable, tell the user to start a port-forward and stop. Do not attempt to fix connectivity.

## Tools

### `vm_query` — Run PromQL queries

```
vm_query(query: "up{job=\"node-exporter\"}")
vm_query(query: "rate(container_cpu_usage_seconds_total[5m])", range: true, start: "-1h", step: "60s")
vm_query(query: "up{job=\"node-exporter\"}", range: true, start: "2025-01-15T14:00:00Z", end: "2025-01-15T14:30:00Z", step: "30s")
```

Results are returned in compact format by default: common labels are factored out, range queries show summary stats (min/max/avg/first/last) plus head/tail samples. Use `raw: true` if you need the full JSON.

### `vm_labels` — Discover metrics and labels

```
vm_labels(action: "names")
vm_labels(action: "values", label: "cluster")
vm_labels(action: "values", label: "namespace")
vm_labels(action: "values", label: "node")
vm_labels(action: "series", match: "node_memory_MemTotal_bytes", limit: 5)
```

## ⚠️ MANDATORY: Load Knowledge BEFORE Any Investigation

**You MUST load the environment knowledge file before running any investigative queries.** This is not optional. Skipping this step leads to misinterpreting normal behaviour as problems, using wrong label names, and wasting queries on already-known information.

1. Query the cluster name: `vm_labels(action: "values", label: "cluster")`
2. Read `~/.pi/vm-knowledge/<cluster-name>.md` using the `read` tool
3. Only then proceed to answer the user's question

If the knowledge file doesn't exist yet, run the discovery queries in Step 2 below to create it first.

---

## Workflow

Follow this sequence every time the skill is invoked:

### Step 1 — Check connectivity and load knowledge

```
vm_query(query: "up", range: false)
```

If this fails, the tool will report the error with setup instructions. **Stop and relay those to the user.**

Then **immediately** identify the environment and load knowledge:

1. **Identify the environment**: query the cluster label:
   ```
   vm_labels(action: "values", label: "cluster")
   ```
   This returns the cluster name(s). If there's exactly one, use it. If multiple, ask the user which one.

2. **Load knowledge**: use the `read` tool to read `~/.pi/vm-knowledge/<cluster-name>.md`. This contains previously discovered information about the environment — node types, namespaces, useful metrics, label conventions, **workload characteristics, and known baselines**. Pay close attention to these — they tell you what is normal for this environment. **Do not proceed to investigation without reading this file.**

### Step 2 — First-time discovery (only if no knowledge file exists)

If the knowledge file does not exist, run discovery:

```
vm_labels(action: "values", label: "namespace")
vm_labels(action: "values", label: "node")
vm_labels(action: "values", label: "job")
vm_query(query: "count by (node, node_kubernetes_io_instance_type) (node_uname_info)")
```

Then create the knowledge file with what was found. Use the template below.

### Step 3 — Investigate the user's question

Use targeted PromQL queries from the cookbook below. Iterate: run a query, interpret results, refine.

**Follow the investigation principles below** — do not jump to conclusions based on CPU/RAM spikes alone.

### Step 4 — Update knowledge

If you discovered anything new (a useful metric, a label pattern, a node group, workload baseline, traffic pattern, incident learnings), **append it to the knowledge file** so future sessions benefit.

## Investigation Principles

These principles override any default assumptions. Follow them for every investigation.

### 1. Don't assume spikes are abnormal — verify against history

When you see a metric spike (CPU, RAM, network, etc.), **always check whether it's within the normal range** before attributing blame:

```promql
# Check 7-day and 30-day peak for comparison
max_over_time(<metric>[7d:5m])
max_over_time(<metric>[30d:5m])
```

A pod at 8GB RAM or 50 MB/s network might be completely normal for that workload. Compare the incident value against the historical max. If today's spike is within the range of past peaks, it's probably not the root cause — look elsewhere.

### 2. Check ALL resource dimensions, not just CPU and RAM

CPU and memory are the most visible metrics, but incidents are often caused by other resource exhaustion. **Always check these during incident investigation:**

- **Network throughput**: Per-node and per-pod receive/transmit rates. Look for sudden surges or asymmetric traffic.
  ```promql
  sum by (instance) (rate(node_network_receive_bytes_total{device!~"lo|veth.*|cali.*"}[5m]))
  sum by (pod) (rate(container_network_receive_bytes_total{namespace="<ns>"}[5m]))
  ```

- **Disk I/O saturation**: High iowait or disk latency can stall everything.
  ```promql
  rate(node_disk_io_time_seconds_total[5m])
  rate(node_disk_read_time_seconds_total[5m]) / rate(node_disk_reads_completed_total[5m])
  ```

- **CPU steal time**: Indicates AWS host-level contention (noisy neighbour, degraded hardware).
  ```promql
  sum by (instance) (rate(node_cpu_seconds_total{mode="steal"}[5m]))
  ```

- **CPU iowait**: High iowait means CPU is waiting on I/O, not actually doing work.
  ```promql
  sum by (instance) (rate(node_cpu_seconds_total{mode="iowait"}[5m]))
  ```

- **Network errors**: Even small error rates can indicate infrastructure problems.
  ```promql
  rate(node_network_receive_errs_total[5m]) > 0
  rate(node_network_transmit_errs_total[5m]) > 0
  ```

- **Conntrack table exhaustion**: Can silently break networking.
  ```promql
  node_nf_conntrack_entries / node_nf_conntrack_entries_limit
  ```

### 3. Look for the EARLIEST signal, not the loudest

Cascading failures produce many loud signals (OOMKills, pod restarts, node flapping). These are **symptoms, not causes**. Work backwards to find the first anomaly:

- When did the first node-exporter scrape fail?
- When did the first pod go not-ready?
- Was there a node-level event (disk, network, AWS) before the pod-level chaos started?
- Did node memory/CPU/network change trend before pods started failing?

### 4. Check node-level health, not just pod-level

Pod metrics can mask node-level infrastructure problems. Always check:

```promql
# Node-exporter availability (gaps = node issues)
changes(up{job="node-exporter"}[10m]) > 0

# Node ready status changes
changes(kube_node_status_condition{condition="Ready", status="true"}[10m]) > 0

# Total nodes reporting (drops = nodes disappearing)
count(up{job="node-exporter"})

# Node conditions (disk pressure, memory pressure, PID pressure)
kube_node_status_condition{condition=~"DiskPressure|MemoryPressure|PIDPressure", status="true"} == 1
```

### 5. Check for slow-burn trends, not just point-in-time

Some failures are caused by gradual resource erosion over days/weeks. When investigating capacity-related incidents, always check the multi-day trend:

```promql
# Node memory trend over the past week (was it slowly climbing?)
100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)
# Query as range with start=-7d, step=2h

# Pod memory trend (is a workload slowly leaking?)
sum by (pod) (container_memory_working_set_bytes{namespace="<ns>", container!=""})
# Query as range with start=-7d, step=1h
```

### 6. Verify monitoring pipeline health

Gaps in metrics can mean the monitoring system itself had issues (vmagent down, scrape failures), not that the targets were actually unreachable:

```promql
# Was vmagent healthy?
up{job=~"vmagent.*"}

# Scrape duration (slow scrapes suggest target or network issues)
scrape_duration_seconds{job="node-exporter"}
```

## Knowledge File Template

```markdown
# Environment: <cluster-name>

## Cluster Info
- Cluster: <cluster-name>
- Discovered: <date>

## Namespaces
- <list of namespaces>

## Node Groups
- <instance-type>: <description/role> (node names)

## Key Labels
- <label>: <what it identifies>

## Workload Characteristics
- <describe memory-intensive, network-intensive, or bursty workloads>
- <note what is NORMAL for this environment so future investigations don't flag it>

## Useful Metrics
- <metric_name> — <what it measures>

## Incident History
- <date> — <brief description and root cause>

## Notes
- <anything learned during investigations>
```

## PromQL Cookbook

### Node Health

```promql
# Is a node up? (by node-exporter)
up{job="node-exporter"}

# Node conditions (Ready, DiskPressure, MemoryPressure, etc.)
kube_node_status_condition{condition="Ready", status="true"}

# When did nodes last boot?
node_boot_time_seconds

# Nodes that disappeared (were up 10m ago but not now)
up{job="node-exporter"} offset 10m unless up{job="node-exporter"}
```

### CPU

```promql
# CPU usage by node (percentage, 5m average)
100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])))

# CPU usage by pod (cores)
sum by (namespace, pod) (rate(container_cpu_usage_seconds_total[5m]))

# Top CPU consumers in a namespace
topk(10, sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="<ns>"}[5m])))

# CPU throttling by pod
sum by (namespace, pod) (rate(container_cpu_cfs_throttled_seconds_total[5m]))

# CPU by mode — check steal, iowait, system for node-level issues
sum by (instance, mode) (rate(node_cpu_seconds_total{mode=~"steal|iowait|system"}[5m]))
```

### Memory

```promql
# Node RAM usage (percentage)
100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)

# Pod memory working set (the metric k8s uses for OOM decisions)
sum by (namespace, pod) (container_memory_working_set_bytes{container!=""})

# Top memory consumers in a namespace
topk(10, sum by (pod) (container_memory_working_set_bytes{namespace="<ns>", container!=""}))

# Memory vs requests
sum by (namespace, pod) (container_memory_working_set_bytes{container!=""})
  /
sum by (namespace, pod) (kube_pod_container_resource_requests{resource="memory"})
```

### Pod Restarts & OOMKills

```promql
# Restart count by pod
sum by (namespace, pod) (kube_pod_container_status_restarts_total)

# Pods that restarted recently (increase in last hour)
sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total[1h])) > 0

# OOMKilled containers
kube_pod_container_status_last_terminated_reason{reason="OOMKilled"}

# Pods not ready
kube_pod_status_ready{condition="false"}
```

### Disk

```promql
# Node filesystem usage (percentage)
100 * (1 - node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"} / node_filesystem_size_bytes)

# Disk I/O utilisation (1.0 = 100% busy)
rate(node_disk_io_time_seconds_total[5m])

# Disk read/write latency (seconds per operation)
rate(node_disk_read_time_seconds_total[5m]) / rate(node_disk_reads_completed_total[5m])
rate(node_disk_write_time_seconds_total[5m]) / rate(node_disk_writes_completed_total[5m])

# PVC usage (if supported)
kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes * 100
```

### Network

```promql
# Network receive rate by node (bytes/sec) — use physical interface only
sum by (instance) (rate(node_network_receive_bytes_total{device!~"lo|veth.*|cali.*"}[5m]))

# Network receive rate by pod (bytes/sec)
sum by (namespace, pod) (rate(container_network_receive_bytes_total[5m]))

# Network transmit rate by pod
sum by (namespace, pod) (rate(container_network_transmit_bytes_total[5m]))

# Network errors
rate(node_network_receive_errs_total[5m]) > 0
rate(node_network_transmit_errs_total[5m]) > 0

# Conntrack usage
node_nf_conntrack_entries / node_nf_conntrack_entries_limit
```

### Historical Baseline Comparison

```promql
# 7-day max for any metric (replace <metric_expr> with the expression)
max_over_time(<metric_expr>[7d:5m])

# 30-day max
max_over_time(<metric_expr>[30d:5m])

# Multi-day trend (use as range query with start=-7d, step=2h)
<metric_expr>
```

### Deployments & Scaling

```promql
# Deployment replica status
kube_deployment_status_replicas_available
kube_deployment_spec_replicas

# Deployments with unavailable replicas
kube_deployment_spec_replicas - kube_deployment_status_replicas_available > 0

# HPA current vs desired
kube_horizontalpodautoscaler_status_current_replicas
kube_horizontalpodautoscaler_spec_max_replicas
```

### Time-based Investigation

When the user says something happened "around 14:15", use range queries centred on that time:

```
vm_query(query: "up{job=\"node-exporter\"}", range: true, start: "2025-01-15T14:00:00Z", end: "2025-01-15T14:30:00Z", step: "30s")
vm_query(query: "increase(kube_pod_container_status_restarts_total[5m])", range: true, start: "2025-01-15T14:00:00Z", end: "2025-01-15T14:30:00Z", step: "60s")
```

### Discovery Queries

When you don't know what's available:

```
vm_labels(action: "series", match: "{__name__=~\"node_.*\"}", limit: 10)
vm_labels(action: "values", label: "job")
vm_query(query: "count by (container) (container_cpu_usage_seconds_total{namespace=\"<ns>\"})")
```

## Tips

- **Start broad, narrow down.** Don't jump to a specific pod — first check nodes, then namespaces, then pods.
- **Use `topk()`** to avoid overwhelming output. `topk(10, ...)` is your friend.
- **Rate matters for counters.** Always wrap `_total` metrics in `rate()` or `increase()`.
- **`container!=""`** filters out pod-level aggregates in container metrics.
- **The `offset` modifier** lets you look at past values: `up offset 10m` gives you the value from 10 minutes ago.
- **Use range mode for trends**, instant queries for current state.
- **Don't attribute blame to the first spike you find.** Always verify it's abnormal by comparing against historical data (7d/30d max). What looks like a problem might be normal for that workload.
- **Check all dimensions** — network, disk, steal time, conntrack — not just CPU and RAM. The cause is often in a resource you didn't check first.
- **Look for slow-burn trends** over days/weeks, not just the incident window. Capacity erosion is a common root cause.

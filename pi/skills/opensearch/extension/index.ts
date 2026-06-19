import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const KNOWLEDGE_DIR = join(homedir(), ".pi", "opensearch-knowledge");

// ── Host resolution ────────────────────────────────────────────────────

/**
 * Scan all knowledge files for one that has an `opensearch_host:` metadata line.
 * Returns { host, env } or null.
 */
function loadHostFromKnowledge(): { host: string; env: string } | null {
	if (!existsSync(KNOWLEDGE_DIR)) return null;
	try {
		const files = readdirSync(KNOWLEDGE_DIR).filter(f => f.endsWith(".md"));
		for (const name of files) {
			const file = join(KNOWLEDGE_DIR, name);
			const content = readFileSync(file, "utf-8");
			const m = content.match(/^opensearch_host:\s*(.+)$/m);
			if (m) {
				const host = m[1].trim();
				const env = basename(name, ".md");
				return { host, env };
			}
		}
	} catch {}
	return null;
}

function saveHostToKnowledge(env: string, host: string): void {
	mkdirSync(KNOWLEDGE_DIR, { recursive: true });
	const file = join(KNOWLEDGE_DIR, `${env}.md`);
	if (existsSync(file)) {
		let content = readFileSync(file, "utf-8");
		if (content.match(/^opensearch_host:/m)) {
			content = content.replace(/^opensearch_host:.*$/m, `opensearch_host: ${host}`);
		} else {
			// Insert after the first line (title)
			const lines = content.split("\n");
			lines.splice(1, 0, `opensearch_host: ${host}`);
			content = lines.join("\n");
		}
		writeFileSync(file, content);
	} else {
		writeFileSync(file, `# Environment: ${env}\nopensearch_host: ${host}\n`);
	}
}

let resolvedHost: string | null = null;

function getOpenSearchBase(): string | null {
	if (resolvedHost) return resolvedHost;
	const info = loadHostFromKnowledge();
	if (info) {
		resolvedHost = `https://${info.host}`;
		return resolvedHost;
	}
	return null;
}

// ── HTTP helpers ───────────────────────────────────────────────────────

function osGet(path: string, timeout_ms = 15_000): string {
	const base = getOpenSearchBase();
	if (!base) throw new Error("NO_HOST");
	const url = `${base}${path}`;
	return execSync(`curl -sk --max-time ${Math.ceil(timeout_ms / 1000)} '${url}'`, {
		encoding: "utf-8",
		timeout: timeout_ms + 2_000,
	});
}

function osPost(path: string, body: object, timeout_ms = 30_000): string {
	const base = getOpenSearchBase();
	if (!base) throw new Error("NO_HOST");
	const url = `${base}${path}`;
	const json = JSON.stringify(body);
	return execSync(`curl -sk --max-time ${Math.ceil(timeout_ms / 1000)} -H 'Content-Type: application/json' -d '${json.replace(/'/g, "\\'")}' '${url}'`, {
		encoding: "utf-8",
		timeout: timeout_ms + 2_000,
	});
}

function checkConnectivity(): string | null {
	const base = getOpenSearchBase();
	if (!base) {
		return [
			"No OpenSearch host configured.",
			"",
			"I need the Tailscale hostname for OpenSearch (e.g. `cf-prod-opensearch`).",
			"Please provide it and I'll save it to the knowledge file for future use.",
		].join("\n");
	}
	try {
		osGet("/_cat/health?format=json", 5_000);
		return null;
	} catch {
		return [
			`Cannot reach OpenSearch at ${base}.`,
			"",
			"The configured host may be unreachable. Check that this machine has Tailscale access,",
			"or provide a different hostname.",
		].join("\n");
	}
}

// ── Environment detection ──────────────────────────────────────────────

let cachedEnv: string | null = null;

function detectEnvironment(): string {
	if (cachedEnv) return cachedEnv;

	// Try from knowledge first
	const info = loadHostFromKnowledge();
	if (info) {
		cachedEnv = info.env;
		return cachedEnv;
	}

	try {
		const raw = osGet("/_cat/indices?format=json&h=index", 5_000);
		const indices = JSON.parse(raw) as { index: string }[];
		for (const { index } of indices) {
			const m = index.match(/^(.+)-fluentd-\d{4}\.\d{2}\.\d{2}$/);
			if (m) {
				cachedEnv = m[1];
				return cachedEnv;
			}
		}
	} catch {}
	cachedEnv = "cf-prod";
	return cachedEnv;
}

// ── Time helpers ───────────────────────────────────────────────────────

function resolveTime(value: string): string {
	const rel = value.match(/^-(\d+)(s|m|h|d)$/);
	if (rel) {
		const amount = parseInt(rel[1]);
		const unit = rel[2];
		const ms = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
		return new Date(Date.now() - amount * ms).toISOString();
	}
	if (value.includes("T")) {
		if (!value.endsWith("Z") && !value.includes("+")) {
			return value + "Z";
		}
		return value;
	}
	return value + "T00:00:00Z";
}

function indicesForRange(env: string, start: string, end: string): string {
	const startDate = new Date(start);
	const endDate = new Date(end);
	const dates = new Set<string>();
	const current = new Date(startDate);
	while (current <= endDate) {
		const y = current.getUTCFullYear();
		const m = String(current.getUTCMonth() + 1).padStart(2, "0");
		const d = String(current.getUTCDate()).padStart(2, "0");
		dates.add(`${env}-fluentd-${y}.${m}.${d}`);
		current.setUTCDate(current.getUTCDate() + 1);
	}
	return Array.from(dates).sort().join(",");
}

// ── Query builders ─────────────────────────────────────────────────────

function buildSearchQuery(
	service: string | undefined,
	start: string,
	end: string,
	grep: string | undefined,
	size: number,
	searchAfter?: unknown[],
): object {
	const musts: object[] = [];

	if (service) {
		musts.push({ term: { "kubernetes.container_name.keyword": service } });
	}
	if (grep) {
		musts.push({ match_phrase: { message: grep } });
	}
	musts.push({ range: { timestamp: { gte: start, lte: end } } });

	const query: Record<string, unknown> = {
		query: { bool: { must: musts } },
		size,
		sort: [{ timestamp: "asc" }, { _id: "asc" }],
		_source: ["timestamp", "message", "kubernetes.container_name", "kubernetes.pod_name"],
	};

	if (searchAfter) {
		query.search_after = searchAfter;
	}

	return query;
}

// ── Pipe processing ────────────────────────────────────────────────────

const ALLOWED_PIPE_COMMANDS = new Set([
	"grep", "egrep", "fgrep", "awk", "sed", "sort", "uniq", "head", "tail",
	"wc", "cut", "tr", "tee", "cat", "column",
]);

function validatePipe(pipe: string): string | null {
	// Split on pipe characters, check each command
	const segments = pipe.split(/\s*\|\s*/);
	for (const seg of segments) {
		const cmd = seg.trim().split(/\s+/)[0];
		if (!cmd) continue;
		if (!ALLOWED_PIPE_COMMANDS.has(cmd)) {
			return `Command '${cmd}' is not allowed in pipe. Allowed: ${[...ALLOWED_PIPE_COMMANDS].join(", ")}`;
		}
	}
	return null;
}

function applyPipe(lines: string[], pipe: string): string {
	const err = validatePipe(pipe);
	if (err) return `Pipe error: ${err}`;

	const { writeFileSync, unlinkSync } = require("node:fs");
	const { execSync } = require("node:child_process");
	const tmpFile = `/tmp/os-pipe-${Date.now()}.txt`;

	try {
		writeFileSync(tmpFile, lines.join("\n") + "\n");
		const result = execSync(`cat '${tmpFile}' | ${pipe}`, {
			encoding: "utf-8",
			timeout: 30_000,
			maxBuffer: 10 * 1024 * 1024,
		}).trim();

		if (!result) {
			return `Pipe produced no output (${lines.length} input lines).`;
		}

		const outputLines = result.split("\n");
		return `${outputLines.length} line(s) (from ${lines.length} input lines, piped through: ${pipe}):\n\n${result}`;
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		// grep returns exit code 1 when no matches — not an error
		if (msg.includes("status 1") && pipe.match(/^\s*grep|.*\|\s*grep/)) {
			return `Pipe produced no matches (${lines.length} input lines).`;
		}
		return `Pipe execution error: ${msg}`;
	} finally {
		try { unlinkSync(tmpFile); } catch {}
	}
}

// ── Formatters ─────────────────────────────────────────────────────────

function formatHit(hit: { _source: Record<string, unknown> }): string {
	const src = hit._source;
	const ts = (src.timestamp as string ?? "").replace(/T/, " ").replace(/\.\d+Z$/, "");
	const k8s = src.kubernetes as Record<string, string> | undefined;
	const container = k8s?.container_name ?? "";
	const pod = k8s?.pod_name ?? "";
	const msg = src.message as string ?? "";

	const prefix = pod ? `${container}/${pod.split("-").pop()}` : container;
	return `${ts}  ${prefix}  ${msg}`;
}

function truncateLines(lines: string[], max: number): { text: string; truncated: boolean } {
	if (lines.length <= max) return { text: lines.join("\n"), truncated: false };
	return {
		text: lines.slice(0, max).join("\n") + `\n\n... truncated (${lines.length} total, showing first ${max})`,
		truncated: true,
	};
}

// ── Actions ────────────────────────────────────────────────────────────

function actionServices(): string {
	const env = detectEnvironment();
	const now = new Date();
	const y = now.getUTCFullYear();
	const m = String(now.getUTCMonth() + 1).padStart(2, "0");
	const d = String(now.getUTCDate()).padStart(2, "0");
	const index = `${env}-fluentd-${y}.${m}.${d}`;

	const raw = osPost(`/${index}/_search`, {
		size: 0,
		aggs: {
			containers: {
				terms: { field: "kubernetes.container_name.keyword", size: 100 },
			},
		},
	}, 60_000);

	const data = JSON.parse(raw);
	const buckets = data.aggregations?.containers?.buckets ?? [];

	if (buckets.length === 0) {
		return "No containers found in today's index.";
	}

	const lines: string[] = [`${buckets.length} services in ${index}:`, ""];
	for (const b of buckets) {
		const count = (b.doc_count as number).toLocaleString();
		lines.push(`  ${b.key}  (${count} logs)`);
	}
	return lines.join("\n");
}

function actionSearch(
	service: string | undefined,
	start: string,
	end: string,
	grep: string | undefined,
	limit: number,
	pipe: string | undefined,
): string {
	const env = detectEnvironment();
	const startIso = resolveTime(start);
	const endIso = resolveTime(end);
	const indices = indicesForRange(env, startIso, endIso);

	const pageSize = Math.min(limit, 500);
	const allLines: string[] = [];
	let searchAfter: unknown[] | undefined;

	while (allLines.length < limit) {
		const query = buildSearchQuery(service, startIso, endIso, grep, pageSize, searchAfter);
		const raw = osPost(`/${indices}/_search`, query);
		const data = JSON.parse(raw);
		const hits = data.hits?.hits ?? [];

		if (hits.length === 0) break;

		for (const hit of hits) {
			allLines.push(formatHit(hit));
			searchAfter = hit.sort;
		}

		if (hits.length < pageSize) break;
	}

	if (allLines.length === 0) {
		return "No matching logs found.";
	}

	// If a pipe is specified, run the log lines through it
	if (pipe) {
		return applyPipe(allLines, pipe);
	}

	const { text } = truncateLines(allLines, limit);
	return `${allLines.length} log line(s):\n\n${text}`;
}

function actionSlowRequests(
	service: string | undefined,
	start: string,
	end: string,
	minDurationMs: number,
	limit: number,
): string {
	const env = detectEnvironment();
	const startIso = resolveTime(start);
	const endIso = resolveTime(end);
	const indices = indicesForRange(env, startIso, endIso);

	const musts: object[] = [
		{ match_phrase: { message: "generated" } },
		{ match_phrase: { message: "msecs" } },
		{ range: { timestamp: { gte: startIso, lte: endIso } } },
	];
	if (service) {
		musts.push({ term: { "kubernetes.container_name.keyword": service } });
	}

	const raw = osPost(`/${indices}/_search`, {
		query: { bool: { must: musts } },
		size: 2000,
		sort: [{ timestamp: "desc" }],
		_source: ["timestamp", "message", "kubernetes.container_name", "kubernetes.pod_name"],
	});

	const data = JSON.parse(raw);
	const hits = data.hits?.hits ?? [];

	type ParsedRequest = {
		line: string;
		duration_ms: number;
		method: string;
		path: string;
		status: string;
		bytes: number;
		pid: string;
		timestamp: string;
		container: string;
	};

	const requests: ParsedRequest[] = [];
	const uwsgiRe = /\[pid: (\d+).*?\]\s+\S+.*?(GET|POST|PUT|DELETE|PATCH|OPTIONS)\s+(\S+)\s+=>\s+generated\s+(\d+)\s+bytes\s+in\s+(\d+)\s+msecs\s+\(HTTP\/\S+\s+(\d+)\)/;

	for (const hit of hits) {
		const msg = hit._source.message as string;
		const m = msg.match(uwsgiRe);
		if (!m) continue;

		const duration_ms = parseInt(m[5]);
		if (duration_ms < minDurationMs) continue;

		const k8s = hit._source.kubernetes as Record<string, string> | undefined;
		requests.push({
			line: formatHit(hit),
			duration_ms,
			method: m[2],
			path: m[3],
			status: m[6],
			bytes: parseInt(m[4]),
			pid: m[1],
			timestamp: hit._source.timestamp as string,
			container: k8s?.container_name ?? "",
		});
	}

	requests.sort((a, b) => b.duration_ms - a.duration_ms);
	const top = requests.slice(0, limit);

	if (top.length === 0) {
		return `No requests found with duration >= ${minDurationMs}ms.`;
	}

	const lines: string[] = [`${top.length} slow request(s) (of ${requests.length} total >= ${minDurationMs}ms):`, ""];

	for (const r of top) {
		const durSec = (r.duration_ms / 1000).toFixed(1);
		const sizeKb = (r.bytes / 1024).toFixed(0);
		const ts = r.timestamp.replace(/T/, " ").replace(/\.\d+Z$/, "");
		lines.push(`  ${durSec}s  ${r.method} ${r.path}  ${r.status}  ${sizeKb}KB  pid=${r.pid}  ${r.container}  ${ts}`);
	}

	return lines.join("\n");
}

function actionErrors(
	service: string | undefined,
	start: string,
	end: string,
	limit: number,
): string {
	const env = detectEnvironment();
	const startIso = resolveTime(start);
	const endIso = resolveTime(end);
	const indices = indicesForRange(env, startIso, endIso);

	const musts: object[] = [
		{ range: { timestamp: { gte: startIso, lte: endIso } } },
	];
	if (service) {
		musts.push({ term: { "kubernetes.container_name.keyword": service } });
	}

	const shoulds: object[] = [
		{ match_phrase: { message: "ERROR" } },
		{ match_phrase: { message: "Exception" } },
		{ match_phrase: { message: "Traceback" } },
		{ match_phrase: { message: "SIGPIPE" } },
		{ match_phrase: { message: "Internal Server Error" } },
		{ match_phrase: { message: "HTTP/1.1 500" } },
		{ match_phrase: { message: "HTTP/1.1 502" } },
		{ match_phrase: { message: "HTTP/1.1 503" } },
	];

	const raw = osPost(`/${indices}/_search`, {
		query: {
			bool: {
				must: musts,
				should: shoulds,
				minimum_should_match: 1,
			},
		},
		size: limit,
		sort: [{ timestamp: "desc" }],
		_source: ["timestamp", "message", "kubernetes.container_name", "kubernetes.pod_name"],
	});

	const data = JSON.parse(raw);
	const hits = data.hits?.hits ?? [];

	if (hits.length === 0) {
		return "No errors found in the given time range.";
	}

	const total = data.hits?.total?.value ?? hits.length;
	const lines: string[] = [`${hits.length} error(s) shown (${total} total):`, ""];

	for (const hit of hits) {
		lines.push(formatHit(hit));
	}

	return lines.join("\n");
}

function actionCount(
	service: string | undefined,
	start: string,
	end: string,
	groupBy: "service" | "time" | undefined,
): string {
	const env = detectEnvironment();
	const startIso = resolveTime(start);
	const endIso = resolveTime(end);
	const indices = indicesForRange(env, startIso, endIso);

	const musts: object[] = [
		{ range: { timestamp: { gte: startIso, lte: endIso } } },
	];
	if (service) {
		musts.push({ term: { "kubernetes.container_name.keyword": service } });
	}

	const aggs: Record<string, object> = {};
	if (groupBy === "service" || !groupBy) {
		aggs.by_service = {
			terms: { field: "kubernetes.container_name.keyword", size: 50 },
		};
	}
	if (groupBy === "time") {
		aggs.by_time = {
			date_histogram: { field: "timestamp", fixed_interval: "1m" },
		};
	}

	const raw = osPost(`/${indices}/_search`, {
		query: { bool: { must: musts } },
		size: 0,
		aggs,
	}, 60_000);

	const data = JSON.parse(raw);
	const total = data.hits?.total?.value ?? 0;
	const lines: string[] = [`Total: ${total.toLocaleString()} logs`, ""];

	if (data.aggregations?.by_service) {
		lines.push("By service:");
		for (const b of data.aggregations.by_service.buckets) {
			lines.push(`  ${b.key}: ${(b.doc_count as number).toLocaleString()}`);
		}
	}

	if (data.aggregations?.by_time) {
		lines.push("By minute:");
		for (const b of data.aggregations.by_time.buckets) {
			if (b.doc_count === 0) continue;
			const ts = (b.key_as_string as string).replace(/T/, " ").replace(/\.\d+Z$/, "");
			lines.push(`  ${ts}: ${(b.doc_count as number).toLocaleString()}`);
		}
	}

	return lines.join("\n");
}

// ── Host configuration action ──────────────────────────────────────────

function actionSetHost(host: string): string {
	// Strip protocol if provided
	host = host.replace(/^https?:\/\//, "").replace(/\/+$/, "");

	// Determine env from knowledge or default
	const existing = loadHostFromKnowledge();
	const env = existing?.env ?? "cf-prod";

	// Test connectivity before saving
	resolvedHost = `https://${host}`;
	try {
		osGet("/_cat/health?format=json", 5_000);
	} catch {
		resolvedHost = null;
		return [
			`Cannot reach OpenSearch at https://${host}.`,
			"",
			"Check that the hostname is correct and this machine has Tailscale access.",
		].join("\n");
	}

	saveHostToKnowledge(env, host);
	cachedEnv = null; // Reset so it re-detects

	return `OpenSearch host set to ${host} and saved to knowledge file (~/.pi/opensearch-knowledge/${env}.md).`;
}

// ── Extension entry point ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.events.emit("command-guard:register", {
		pattern: "\\bcurl\\b.*\\bopensearch\\b",
		reason: "Use the opensearch tool for OpenSearch queries, not curl/bash.",
	});

	pi.registerTool({
		name: "opensearch",
		label: "OpenSearch",
		description:
			"Search and analyze Kubernetes application logs via OpenSearch. " +
			"Supports searching by service/time/text, finding slow HTTP requests, " +
			"listing errors, and counting logs by service or time. " +
			"Connects directly to OpenSearch over Tailscale (HTTPS). " +
			"Read-only — queries only.",
		promptSnippet:
			"Search Kubernetes logs via OpenSearch. Find slow requests, errors, search by service/time/text, count by service or time.",
		promptGuidelines: [
			"Use opensearch for all log queries — do not use bash/curl directly.",
			"Start with opensearch(action: 'services') to check connectivity and see available services.",
			"If the tool reports no host configured, ask the user for the Tailscale hostname and use opensearch(action: 'set_host', host: '<hostname>') to save it.",
			"Use 'slow_requests' to find long-running HTTP requests across any service.",
			"Use 'search' with 'grep' for targeted text searches within a time window.",
			"Use relative times like '-5m', '-1h' for recent queries.",
			"For Countfire backend analysis, pattern IDs in logs correspond to selection_id values in the database.",
			"For bulk log analysis, ALWAYS use the 'pipe' parameter to extract only needed fields. Sample 3-5 logs first to understand the format, then craft a grep+awk pipe. This avoids dumping hundreds of verbose log lines into context.",
		],
		parameters: Type.Object({
			action: StringEnum(["services", "search", "slow_requests", "errors", "count", "set_host"] as const, {
				description:
					"services: list container names, search: query logs, slow_requests: find slow HTTP requests, errors: find errors, count: count logs by group, set_host: configure the OpenSearch Tailscale hostname",
			}),
			host: Type.Optional(
				Type.String({ description: "OpenSearch Tailscale hostname (for 'set_host' action, e.g. 'cf-prod-opensearch')" }),
			),
			service: Type.Optional(
				Type.String({ description: "Container name filter (e.g. 'cf-prod-be', 'cf-prod-api')" }),
			),
			start: Type.Optional(
				Type.String({
					description: "Start time — ISO datetime or relative like '-5m', '-1h' (default: -5m)",
				}),
			),
			end: Type.Optional(
				Type.String({
					description: "End time — ISO datetime or relative (default: now)",
				}),
			),
			grep: Type.Optional(
				Type.String({ description: "Text to match in log messages (for 'search' action)" }),
			),
			pipe: Type.Optional(
				Type.String({
					description:
						"Shell pipe to transform log lines before returning (for 'search' action). " +
						"Allowed commands: grep, awk, sed, sort, uniq, head, tail, wc, cut, tr, column. " +
						"Example: \"grep drawing_state | awk '{print $1, $NF}'\"",
				}),
			),
			min_duration_ms: Type.Optional(
				Type.Number({
					description: "Minimum request duration in ms for 'slow_requests' (default: 5000)",
				}),
			),
			group_by: Type.Optional(
				StringEnum(["service", "time"] as const, {
					description: "Grouping for 'count' action (default: service)",
				}),
			),
			limit: Type.Optional(
				Type.Number({ description: "Max results to return (default: 50)" }),
			),
		}),

		async execute(_tool_call_id, params) {
			// Handle set_host action separately — no connectivity check needed
			if (params.action === "set_host") {
				if (!params.host) {
					return {
						content: [{ type: "text" as const, text: "The 'host' parameter is required for 'set_host' action." }],
						isError: true,
						details: {},
					};
				}
				const result = actionSetHost(params.host);
				const isError = result.includes("Cannot reach");
				return {
					content: [{ type: "text" as const, text: result }],
					isError,
					details: { action: "set_host", host: params.host },
				};
			}

			const err = checkConnectivity();
			if (err) {
				return {
					content: [{ type: "text" as const, text: err }],
					isError: true,
					details: {},
				};
			}

			try {
				const start = params.start ?? "-5m";
				const end = params.end ?? new Date().toISOString();
				const defaultLimit = params.pipe ? 2000 : 50;
				const limit = params.limit ?? defaultLimit;
				let result: string;

				switch (params.action) {
					case "services":
						result = actionServices();
						break;
					case "search":
						result = actionSearch(params.service, start, end, params.grep, limit, params.pipe);
						break;
					case "slow_requests":
						result = actionSlowRequests(
							params.service,
							start,
							end,
							params.min_duration_ms ?? 5000,
							limit,
						);
						break;
					case "errors":
						result = actionErrors(params.service, start, end, limit);
						break;
					case "count":
						result = actionCount(params.service, start, end, params.group_by);
						break;
					default:
						result = "Unknown action.";
				}

				return {
					content: [{ type: "text" as const, text: result }],
					details: { action: params.action, service: params.service },
				};
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				return {
					content: [{ type: "text" as const, text: `Error: ${msg}` }],
					isError: true,
					details: { action: params.action },
				};
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("opensearch "));
			text += theme.fg("muted", args.action);
			if (args.host) text += " " + theme.fg("dim", args.host);
			if (args.service) text += " " + theme.fg("dim", args.service);
			if (args.start || args.end) {
				text += theme.fg("muted", ` [${args.start ?? "-5m"}..${args.end ?? "now"}]`);
			}
			if (args.grep) text += theme.fg("muted", ` /${args.grep}/`);
			if (args.pipe) text += theme.fg("muted", ` | ${args.pipe}`);
			if (args.min_duration_ms) text += theme.fg("muted", ` >=${args.min_duration_ms}ms`);
			return new Text(text, 0, 0);
		},
	});
}

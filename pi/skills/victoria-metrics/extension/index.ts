import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { execSync } from "node:child_process";

const VM_PORT = process.env.VM_PORT ?? "8481";
const VM_BASE = `http://localhost:${VM_PORT}/select/0/prometheus/api/v1`;
const KNOWLEDGE_DIR = `${process.env.HOME}/.pi/vm-knowledge`;

function vmGet(path: string, timeout_ms = 30_000): string {
	const url = `${VM_BASE}${path}`;
	return execSync(`curl -sf --max-time ${Math.ceil(timeout_ms / 1000)} '${url}'`, {
		encoding: "utf-8",
		timeout: timeout_ms + 2_000,
	});
}

function checkConnectivity(): string | null {
	try {
		vmGet("/query?query=up&limit=1", 5_000);
		return null;
	} catch {
		return [
			`Cannot reach VictoriaMetrics at localhost:${VM_PORT}.`,
			"",
			"Start a port-forward first:",
			`  kubectl port-forward -n <monitoring-namespace> svc/<vmselect-service> ${VM_PORT}:8481 &`,
		].join("\n");
	}
}

function encodeQuery(query: string): string {
	return encodeURIComponent(query);
}

// ── Compact formatting helpers ─────────────────────────────────────────

/** Find labels that have the same value across ALL series and separate them out */
function partitionLabels(results: any[]): { common: Record<string, string>; unique: Record<string, string>[] } {
	if (results.length === 0) return { common: {}, unique: [] };
	if (results.length === 1) {
		return { common: {}, unique: [results[0].metric ?? {}] };
	}

	const allKeys = new Set<string>();
	for (const r of results) {
		for (const k of Object.keys(r.metric ?? {})) allKeys.add(k);
	}

	const common: Record<string, string> = {};
	const varyingKeys: string[] = [];

	for (const key of allKeys) {
		const values = new Set(results.map((r) => r.metric?.[key]));
		if (values.size === 1 && !values.has(undefined)) {
			common[key] = results[0].metric[key];
		} else {
			varyingKeys.push(key);
		}
	}

	const unique = results.map((r) => {
		const u: Record<string, string> = {};
		for (const k of varyingKeys) {
			if (r.metric?.[k] !== undefined) u[k] = r.metric[k];
		}
		return u;
	});

	return { common, unique };
}

function formatTimestamp(ts: number): string {
	return new Date(ts * 1000).toISOString().replace("T", " ").replace(/\.000Z$/, "Z");
}

function formatValue(v: string): string {
	const n = parseFloat(v);
	if (isNaN(n)) return v;
	if (Number.isInteger(n) && Math.abs(n) < 1e15) return n.toString();
	if (Math.abs(n) >= 1000) return n.toFixed(1);
	if (Math.abs(n) >= 1) return n.toFixed(3);
	if (Math.abs(n) >= 0.001) return n.toFixed(6);
	return n.toExponential(3);
}

function labelString(labels: Record<string, string>): string {
	const entries = Object.entries(labels).filter(([k]) => k !== "__name__");
	if (entries.length === 0) return "{}";
	return "{" + entries.map(([k, v]) => `${k}="${v}"`).join(", ") + "}";
}

function computeStats(values: [number, string][]): { min: number; max: number; avg: number; first: number; last: number; count: number; firstTs: number; lastTs: number } {
	let min = Infinity, max = -Infinity, sum = 0;
	const first = parseFloat(values[0][1]);
	const last = parseFloat(values[values.length - 1][1]);
	for (const [, v] of values) {
		const n = parseFloat(v);
		if (n < min) min = n;
		if (n > max) max = n;
		sum += n;
	}
	return { min, max, avg: sum / values.length, first, last, count: values.length, firstTs: values[0][0], lastTs: values[values.length - 1][0] };
}

/** Format an instant query result compactly */
function formatInstantCompact(data: any): string {
	const results = data.result ?? [];
	if (results.length === 0) return "No results.";

	const { common, unique } = partitionLabels(results);
	const lines: string[] = [];

	if (Object.keys(common).length > 0) {
		lines.push(`Common labels: ${labelString(common)}`);
		lines.push("");
	}

	lines.push(`${results.length} result(s):`);
	lines.push("");

	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		const labels = labelString(unique[i]);
		const [ts, val] = r.value;
		lines.push(`  ${labels}  →  ${formatValue(val)}  @${formatTimestamp(ts)}`);
	}

	return lines.join("\n");
}

/** Maximum number of raw data points per series before switching to summary mode */
const MAX_RAW_POINTS = 30;

/** Format a range query result compactly */
function formatRangeCompact(data: any): string {
	const results = data.result ?? [];
	if (results.length === 0) return "No results.";

	const { common, unique } = partitionLabels(results);
	const lines: string[] = [];

	if (Object.keys(common).length > 0) {
		lines.push(`Common labels: ${labelString(common)}`);
		lines.push("");
	}

	lines.push(`${results.length} series:`);

	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		const values: [number, string][] = r.values ?? [];
		const labels = labelString(unique[i]);

		lines.push("");
		lines.push(`── ${labels} (${values.length} points) ──`);

		if (values.length === 0) {
			lines.push("  (no data)");
			continue;
		}

		const stats = computeStats(values);
		lines.push(`  range: ${formatTimestamp(stats.firstTs)} → ${formatTimestamp(stats.lastTs)}`);
		lines.push(`  min=${formatValue(String(stats.min))}  max=${formatValue(String(stats.max))}  avg=${formatValue(String(stats.avg))}  first=${formatValue(String(stats.first))}  last=${formatValue(String(stats.last))}`);

		if (values.length <= MAX_RAW_POINTS) {
			// Show all points inline
			for (const [ts, val] of values) {
				lines.push(`  ${formatTimestamp(ts)}  ${formatValue(val)}`);
			}
		} else {
			// Show first 10, gap indicator, last 10
			const head = values.slice(0, 10);
			const tail = values.slice(-10);
			for (const [ts, val] of head) {
				lines.push(`  ${formatTimestamp(ts)}  ${formatValue(val)}`);
			}
			lines.push(`  ... (${values.length - 20} more points) ...`);
			for (const [ts, val] of tail) {
				lines.push(`  ${formatTimestamp(ts)}  ${formatValue(val)}`);
			}
		}
	}

	return lines.join("\n");
}

function formatCompact(parsed: any): string {
	if (parsed.status !== "success") {
		return JSON.stringify(parsed, null, 2);
	}

	const data = parsed.data;
	let output: string;

	if (data.resultType === "vector") {
		output = formatInstantCompact(data);
	} else if (data.resultType === "matrix") {
		output = formatRangeCompact(data);
	} else {
		// scalar, string, or unknown — fall back to JSON
		output = JSON.stringify(data, null, 2);
	}

	// Append stats if available
	if (parsed.stats) {
		const s = parsed.stats;
		const parts: string[] = [];
		if (s.seriesFetched) parts.push(`series_fetched=${s.seriesFetched}`);
		if (s.executionTimeMsec) parts.push(`exec_ms=${s.executionTimeMsec}`);
		if (parts.length > 0) output += `\n\n[${parts.join(", ")}]`;
	}

	return output;
}

// ── Truncation ─────────────────────────────────────────────────────────

function truncateResult(text: string, max_lines = 400): { text: string; truncated: boolean } {
	const lines = text.split("\n");
	if (lines.length <= max_lines) return { text, truncated: false };
	return {
		text: lines.slice(0, max_lines).join("\n") + `\n\n... truncated (${lines.length} total lines, showing first ${max_lines})`,
		truncated: true,
	};
}

// ── Extension entry point ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Guard: don't let the LLM bypass vm_query/vm_labels with raw curl/bash queries
	pi.events.emit("command-guard:register", {
		pattern: "\\bcurl\\b.*\\blocalhost[:/].*8481\\b",
		reason: "Use the vm_query or vm_labels tool for VictoriaMetrics queries, not curl/bash.",
	});
	pi.events.emit("command-guard:register", {
		pattern: "\\bcurl\\b.*\\bvictoriametrics\\b",
		reason: "Use the vm_query or vm_labels tool for VictoriaMetrics queries, not curl/bash.",
	});

	// ── vm_query ────────────────────────────────────────────────────────
	pi.registerTool({
		name: "vm_query",
		label: "VM Query",
		description:
			"Run a PromQL query against VictoriaMetrics. Supports instant and range queries. " +
			"This is a read-only tool that queries metrics via HTTP GET to localhost. " +
			"Results are returned in compact format: common labels factored out, range queries show summary stats " +
			"(min/max/avg/first/last) plus head/tail samples when series have many points.",
		promptSnippet: "Run PromQL queries against VictoriaMetrics (instant or range). Results are compact: common labels stripped, range queries summarised.",
		promptGuidelines: [
			"Use vm_query for all VictoriaMetrics/Prometheus metric queries — never use bash/curl directly.",
			"Always wrap _total metrics in rate() or increase().",
			"Use topk() to limit large result sets.",
			"Use range mode with start/end/step for time-series investigation.",
			"Results show summary stats (min/max/avg) for range queries. Use raw=true if you need every data point.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "PromQL expression" }),
			range: Type.Optional(
				Type.Boolean({
					description: "Use range query instead of instant (default: false)",
				})
			),
			start: Type.Optional(
				Type.String({
					description: "Start time for range queries (RFC3339, unix timestamp, or relative like -1h)",
				})
			),
			end: Type.Optional(
				Type.String({
					description: "End time for range queries (default: now)",
				})
			),
			step: Type.Optional(
				Type.String({
					description: "Step for range queries (default: 60s)",
				})
			),
			raw: Type.Optional(
				Type.Boolean({
					description: "Return raw JSON instead of compact format (default: false)",
				})
			),
		}),

		async execute(_tool_call_id, params) {
			const err = checkConnectivity();
			if (err) {
				return {
					content: [{ type: "text" as const, text: err }],
					isError: true,
					details: {},
				};
			}

			const encoded = encodeQuery(params.query);
			let path: string;

			if (params.range) {
				const parts = [`query=${encoded}`];
				if (params.start) parts.push(`start=${encodeURIComponent(params.start)}`);
				if (params.end) parts.push(`end=${encodeURIComponent(params.end)}`);
				parts.push(`step=${params.step ?? "60s"}`);
				path = `/query_range?${parts.join("&")}`;
			} else {
				path = `/query?query=${encoded}`;
			}

			try {
				const raw = vmGet(path);
				let output: string;
				if (params.raw) {
					const formatted = JSON.stringify(JSON.parse(raw), null, 2);
					output = formatted;
				} else {
					const parsed = JSON.parse(raw);
					output = formatCompact(parsed);
				}
				const { text, truncated } = truncateResult(output);
				return {
					content: [{ type: "text" as const, text }],
					details: { query: params.query, truncated },
				};
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				return {
					content: [{ type: "text" as const, text: `Query failed: ${msg}` }],
					isError: true,
					details: { query: params.query },
				};
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("vm_query "));
			const mode = args.range ? "range" : "instant";
			text += theme.fg("muted", `(${mode}) `);
			text += theme.fg("dim", args.query);
			if (args.range && args.start) {
				text += theme.fg("muted", ` [${args.start}..${args.end ?? "now"}, step=${args.step ?? "60s"}]`);
			}
			if (args.raw) text += theme.fg("muted", " [raw]");
			return new Text(text, 0, 0);
		},
	});

	// ── vm_labels ───────────────────────────────────────────────────────
	pi.registerTool({
		name: "vm_labels",
		label: "VM Labels",
		description:
			"Discover available label names, values for a label, or series matching a metric. " +
			"Read-only — queries VictoriaMetrics via HTTP GET to localhost.",
		promptSnippet: "Discover VictoriaMetrics label names, values, and series",
		parameters: Type.Object({
			action: StringEnum(["names", "values", "series"] as const, {
				description: "names: list all label names, values: list values for a label, series: list series matching a selector",
			}),
			label: Type.Optional(
				Type.String({
					description: "Label name (required for 'values' action)",
				})
			),
			match: Type.Optional(
				Type.String({
					description: "Metric name or series selector (required for 'series' action, e.g. 'node_memory_MemTotal_bytes' or '{job=\"node-exporter\"}')",
				})
			),
			limit: Type.Optional(
				Type.Number({
					description: "Max series to return for 'series' action (default: 10)",
				})
			),
		}),

		async execute(_tool_call_id, params) {
			const err = checkConnectivity();
			if (err) {
				return {
					content: [{ type: "text" as const, text: err }],
					isError: true,
					details: {},
				};
			}

			try {
				let raw: string;

				switch (params.action) {
					case "names":
						raw = vmGet("/labels");
						break;
					case "values": {
						if (!params.label) {
							return {
								content: [{ type: "text" as const, text: "Error: 'label' parameter is required for 'values' action" }],
								isError: true,
								details: {},
							};
						}
						raw = vmGet(`/label/${encodeURIComponent(params.label)}/values`);
						break;
					}
					case "series": {
						if (!params.match) {
							return {
								content: [{ type: "text" as const, text: "Error: 'match' parameter is required for 'series' action" }],
								isError: true,
								details: {},
							};
						}
						const limit = params.limit ?? 10;
						raw = vmGet(`/series?match[]=${encodeQuery(params.match)}&limit=${limit}`);
						break;
					}
				}

				// Labels/values/series responses are already compact, just format
				const formatted = JSON.stringify(JSON.parse(raw), null, 2);
				const { text } = truncateResult(formatted);
				return {
					content: [{ type: "text" as const, text }],
					details: { action: params.action },
				};
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				return {
					content: [{ type: "text" as const, text: `Labels query failed: ${msg}` }],
					isError: true,
					details: {},
				};
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("vm_labels "));
			text += theme.fg("muted", args.action);
			if (args.label) text += " " + theme.fg("dim", args.label);
			if (args.match) text += " " + theme.fg("dim", args.match);
			return new Text(text, 0, 0);
		},
	});
}

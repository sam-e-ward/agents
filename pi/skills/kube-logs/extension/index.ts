import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const LOGS_DIR = join(process.env.HOME ?? "/home/ubuntu", "kube-logs");

function logsDir(): string {
	return LOGS_DIR;
}

function listFiles(): string[] {
	try {
		return readdirSync(logsDir())
			.filter((f) => f.endsWith(".log"))
			.sort();
	} catch {
		return [];
	}
}

function filePath(file: string): string {
	// Prevent path traversal
	const name = basename(file);
	return join(logsDir(), name);
}

/** Parse a timestamp from a log line. Returns seconds since midnight, or null. */
function parseTimestamp(line: string): number | null {
	// Match "HH:MM:SS" anywhere — handles both "2026-04-07 14:11:03,948" and "[Tue Apr 7 14:11:03 2026]"
	const m = line.match(/(\d{2}):(\d{2}):(\d{2})/);
	if (!m) return null;
	return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
}

/** Parse a timestamp with millisecond precision. Returns seconds since midnight. */
function parseTimestampMs(line: string): number | null {
	// "2026-04-07 14:11:03,948" format (comma-separated millis)
	const m1 = line.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
	if (m1) {
		return parseInt(m1[1]) * 3600 + parseInt(m1[2]) * 60 + parseInt(m1[3]) + parseInt(m1[4]) / 1000;
	}
	// "14:11:03.948" format (dot-separated millis)
	const m2 = line.match(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
	if (m2) {
		return parseInt(m2[1]) * 3600 + parseInt(m2[2]) * 60 + parseInt(m2[3]) + parseInt(m2[4]) / 1000;
	}
	// Fall back to second precision
	return parseTimestamp(line);
}

/** Parse "HH:MM:SS" string to seconds since midnight */
function parseTimeArg(time: string): number {
	const parts = time.split(":");
	return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + (parts[2] ? parseInt(parts[2]) : 0);
}

/** Format seconds since midnight to HH:MM:SS.mmm */
function formatTime(secs: number): string {
	const h = Math.floor(secs / 3600);
	const m = Math.floor((secs % 3600) / 60);
	const s = secs % 60;
	const hh = String(h).padStart(2, "0");
	const mm = String(m).padStart(2, "0");
	const ss = s.toFixed(3).padStart(6, "0");
	return `${hh}:${mm}:${ss}`;
}

/** Read lines from a file within an optional time range */
function readLines(file: string, start?: string, end?: string): string[] {
	const content = readFileSync(filePath(file), "utf-8");
	const lines = content.split("\n");

	if (!start && !end) return lines;

	const startSecs = start ? parseTimeArg(start) : 0;
	const endSecs = end ? parseTimeArg(end) : 86400;

	return lines.filter((line) => {
		const ts = parseTimestamp(line);
		if (ts === null) return false;
		return ts >= startSecs && ts <= endSecs;
	});
}

// ── Actions ────────────────────────────────────────────────────────────

function actionList(): string {
	const files = listFiles();
	if (files.length === 0) {
		return [
			`No log files found in ${logsDir()}.`,
			"",
			"Dump logs from a privileged session first:",
			"  mkdir -p ~/kube-logs",
			"  just kube logs <resource> > ~/kube-logs/<name>.log",
		].join("\n");
	}

	const lines: string[] = [`${files.length} log file(s) in ${logsDir()}:`, ""];
	for (const f of files) {
		try {
			const stat = statSync(join(logsDir(), f));
			const sizeMb = (stat.size / 1024 / 1024).toFixed(1);
			lines.push(`  ${f}  (${sizeMb} MB)`);
		} catch {
			lines.push(`  ${f}`);
		}
	}
	return lines.join("\n");
}

function actionRead(file: string, start?: string, end?: string, grep?: string, limit?: number): string {
	let lines = readLines(file, start, end);

	if (grep) {
		const re = new RegExp(grep);
		lines = lines.filter((l) => re.test(l));
	}

	const maxLines = limit ?? 500;
	const truncated = lines.length > maxLines;
	if (truncated) {
		lines = lines.slice(0, maxLines);
	}

	let output = lines.join("\n");
	if (truncated) {
		output += `\n\n... truncated (showing first ${maxLines} of ${lines.length + (truncated ? 1 : 0)}+ lines). Use 'start'/'end' to narrow the time range, or 'grep' to filter.`;
	}
	return output || "No matching lines.";
}

function actionGaps(file: string, start?: string, end?: string, minGap?: number): string {
	const lines = readLines(file, start, end);
	const threshold = minGap ?? 5;

	let prevTs: number | null = null;
	let prevLine: string | null = null;

	const gaps: { gap: number; beforeLine: string; afterLine: string; beforeTime: string; afterTime: string }[] = [];

	for (const line of lines) {
		const ts = parseTimestampMs(line);
		if (ts === null) continue;

		if (prevTs !== null && ts - prevTs > threshold) {
			gaps.push({
				gap: ts - prevTs,
				beforeLine: prevLine!,
				afterLine: line,
				beforeTime: formatTime(prevTs),
				afterTime: formatTime(ts),
			});
		}

		prevTs = ts;
		prevLine = line;
	}

	if (gaps.length === 0) {
		return `No gaps > ${threshold}s found.`;
	}

	// Sort by gap size descending
	gaps.sort((a, b) => b.gap - a.gap);

	const output: string[] = [`${gaps.length} gap(s) > ${threshold}s (sorted by duration):`, ""];

	for (const g of gaps) {
		output.push(`═══ ${g.gap.toFixed(1)}s gap (${g.beforeTime} → ${g.afterTime}) ═══`);
		output.push(`  before: ${g.beforeLine.substring(0, 200)}`);
		output.push(`  after:  ${g.afterLine.substring(0, 200)}`);
		output.push("");
	}

	return output.join("\n");
}

function actionTimeline(file: string, start?: string, end?: string): string {
	const lines = readLines(file, start, end);

	// Extract key events
	const events: { time: string; event: string }[] = [];

	for (const line of lines) {
		const ts = parseTimestampMs(line);
		if (ts === null) continue;
		const time = formatTime(ts);

		// Key events to extract
		if (line.includes("Starting TrackedSearch")) {
			const m = line.match(/Starting TrackedSearch on (\d+):(\d+)/);
			events.push({ time, event: `TrackedSearch started: drawing=${m?.[1]} session=${m?.[2]}` });
		} else if (line.includes("Loading file")) {
			const m = line.match(/Loading file (\d+) for drawing (\d+)/);
			events.push({ time, event: `Loading file ${m?.[1]} for drawing ${m?.[2]}` });
		} else if (line.includes("duplicates during parsed svg load")) {
			const m = line.match(/Skipped (\d+) duplicates/);
			events.push({ time, event: `SVG parsed (${m?.[1]} duplicates skipped)` });
		} else if (line.includes("Ignoring") && line.includes("elements")) {
			const m = line.match(/Ignoring (\d+) elements/);
			events.push({ time, event: `Filter rules applied: ${m?.[1]} elements ignored` });
		} else if (line.includes("Adding") && line.includes("elements to the SearchManager")) {
			const m = line.match(/Adding (\d+) elements/);
			events.push({ time, event: `SearchManager initialized: ${m?.[1]} elements` });
		} else if (line.includes("Classifier loaded")) {
			events.push({ time, event: "Classifier loaded" });
		} else if (line.includes("remaining unseen patterns")) {
			const m = line.match(/(\d+) remaining unseen patterns/);
			events.push({ time, event: `Pattern search starting: ${m?.[1]} unseen patterns` });
		} else if (line.includes("patterns retrieved from the cache")) {
			const m = line.match(/(\d+) patterns retrieved from the cache/);
			if (m && parseInt(m[1]) > 0) {
				events.push({ time, event: `${m[1]} patterns from cache` });
			}
		} else if (line.includes("Backend using")) {
			const m = line.match(/Backend using (\d+) CPU cores/);
			events.push({ time, event: `Search backend: ${m?.[1]} CPU cores` });
		} else if (line.includes("Removing") && line.includes("patterns")) {
			events.push({ time, event: "Pattern search complete" });
		} else if (line.includes("Resolving clash")) {
			// Only count these, don't list each one
			const lastEvent = events[events.length - 1];
			if (lastEvent?.event.startsWith("Resolving clashes:")) {
				const m = lastEvent.event.match(/(\d+)/);
				const count = parseInt(m![1]) + 1;
				lastEvent.event = `Resolving clashes: ${count}`;
			} else {
				events.push({ time, event: "Resolving clashes: 1" });
			}
		} else if (line.includes("SIGPIPE")) {
			const m = line.match(/on request ([^ ]+)/);
			events.push({ time, event: `⚠ SIGPIPE (client disconnected): ${m?.[1] ?? ""}` });
		} else if (line.includes("Reapplying action")) {
			events.push({ time, event: "Reapplying saved action" });
		} else if (line.includes("Adding drawing to cache")) {
			events.push({ time, event: "Drawing added to cache" });
		} else if (line.match(/\[pid: \d+.*\] (GET|POST|PUT|DELETE|OPTIONS)/)) {
			const m = line.match(/\[pid: (\d+).*?\] (GET|POST|PUT|DELETE|OPTIONS) ([^ ]+) => generated (\d+) bytes in (\d+) msecs/);
			if (m && m[2] !== "OPTIONS") {
				const sizeKb = (parseInt(m[4]) / 1024).toFixed(0);
				const durationSec = (parseInt(m[5]) / 1000).toFixed(1);
				events.push({ time, event: `${m[2]} ${m[3]} → ${sizeKb}KB in ${durationSec}s (pid ${m[1]})` });
			}
		} else if (line.includes("Discipline") && line.includes("updated from")) {
			events.push({ time, event: line.substring(line.indexOf("Discipline")).trim() });
		}
	}

	if (events.length === 0) {
		return "No recognizable events in the given time range.";
	}

	const output: string[] = [`${events.length} events:`, ""];
	for (const e of events) {
		output.push(`  ${e.time}  ${e.event}`);
	}
	return output.join("\n");
}

// ── Extension entry point ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "kube_logs",
		label: "Kube Logs",
		description:
			"Read and analyze Kubernetes log files from ~/kube-logs/. Supports filtering by time range, " +
			"finding time gaps (slow operations), and extracting structured timelines. " +
			"Read-only — can only access pre-dumped log files.",
		promptSnippet:
			"Read and analyze Kubernetes log files. List files, read with time/grep filters, find time gaps, extract timelines.",
		promptGuidelines: [
			"Use kube_logs for all log file analysis — do not use bash/grep/awk directly.",
			"Start with kube_logs(action: 'list') to see available files.",
			"Use 'gaps' action to find where time was spent in slow requests.",
			"Use 'timeline' action for a structured overview of what happened.",
			"Use 'read' with 'grep' for targeted searches.",
			"Pattern IDs in Countfire logs correspond to selection_id values in the database.",
		],
		parameters: Type.Object({
			action: StringEnum(["list", "read", "gaps", "timeline"] as const, {
				description: "list: show available log files, read: read with filters, gaps: find time gaps, timeline: structured event extraction",
			}),
			file: Type.Optional(Type.String({ description: "Log filename (required for read/gaps/timeline)" })),
			start: Type.Optional(Type.String({ description: "Start time filter, HH:MM:SS (inclusive)" })),
			end: Type.Optional(Type.String({ description: "End time filter, HH:MM:SS (inclusive)" })),
			grep: Type.Optional(Type.String({ description: "Regex filter for 'read' action" })),
			min_gap: Type.Optional(Type.Number({ description: "Minimum gap in seconds for 'gaps' action (default: 5)" })),
			limit: Type.Optional(Type.Number({ description: "Max lines to return for 'read' action (default: 500)" })),
		}),

		async execute(_tool_call_id, params) {
			try {
				if (params.action === "list") {
					return {
						content: [{ type: "text" as const, text: actionList() }],
						details: {},
					};
				}

				if (!params.file) {
					return {
						content: [{ type: "text" as const, text: "Error: 'file' parameter is required for this action." }],
						isError: true,
						details: {},
					};
				}

				// Verify file exists
				try {
					statSync(filePath(params.file));
				} catch {
					return {
						content: [
							{
								type: "text" as const,
								text: `File not found: ${params.file}\n\nAvailable files:\n${actionList()}`,
							},
						],
						isError: true,
						details: {},
					};
				}

				let result: string;
				switch (params.action) {
					case "read":
						result = actionRead(params.file, params.start, params.end, params.grep, params.limit);
						break;
					case "gaps":
						result = actionGaps(params.file, params.start, params.end, params.min_gap);
						break;
					case "timeline":
						result = actionTimeline(params.file, params.start, params.end);
						break;
					default:
						result = "Unknown action.";
				}

				return {
					content: [{ type: "text" as const, text: result }],
					details: { action: params.action, file: params.file },
				};
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				return {
					content: [{ type: "text" as const, text: `Error: ${msg}` }],
					isError: true,
					details: {},
				};
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("kube_logs "));
			text += theme.fg("muted", args.action);
			if (args.file) text += " " + theme.fg("dim", args.file);
			if (args.start || args.end) {
				text += theme.fg("muted", ` [${args.start ?? ""}..${args.end ?? ""}]`);
			}
			if (args.grep) text += theme.fg("muted", ` /${args.grep}/`);
			if (args.min_gap) text += theme.fg("muted", ` gap>${args.min_gap}s`);
			return new Text(text, 0, 0);
		},
	});
}

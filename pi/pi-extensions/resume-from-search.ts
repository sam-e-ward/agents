/**
 * /resume-from-search — find an old session from a prose description.
 *
 * Pipeline (kept cheap on purpose — no whole sessions are ever sent to a model):
 *   1. A small model turns the description into search keywords (+ optional
 *      date window).
 *   2. All sessions (SessionManager.listAll, every working dir) are scored
 *      locally against those keywords. Only the top candidates go further.
 *   3. One model call triages the candidates using cheap evidence (first
 *      message, keyword snippets) and keeps only the plausible ones (max 10).
 *   4. Only those get a one-sentence summary from a small model, based on a
 *      short excerpt (start + end). Summaries are cached per session id and
 *      invalidated when the session's modified date moves.
 *   5. The survivors are shown in a list; Enter resumes one like /resume.
 *
 * Model: configurable via /tool-models (tool name: "resume-search").
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DynamicBorder, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionInfo } from "@earendil-works/pi-coding-agent";
import {
	CancellableLoader,
	Container,
	matchesKey,
	Spacer,
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { resolveToolModel } from "./lib/tool-model-config";

const TOOL_NAME = "resume-search";
const CACHE_PATH = path.join(getAgentDir(), "session-search-summaries.json");

// Candidates passed to the (cheap, single-call) triage step.
const MAX_CANDIDATES = 25;
// Candidates below this fraction of the best keyword score are dropped.
const RELATIVE_SCORE_CUTOFF = 0.4;
// Only triage survivors are summarised, so this bounds the expensive work.
const MAX_SHOWN = 10;
const SUMMARY_BATCH_SIZE = 5;
const SUMMARY_CONCURRENCY = 5;
const FIRST_MESSAGE_CHARS = 220;
const MAX_KEYWORDS = 25;
const LLM_TIMEOUT_MS = 45_000;

const EXCERPT_HEAD_CHARS = 700;
const EXCERPT_TAIL_CHARS = 500;
const SNIPPET_RADIUS = 90;
const MAX_TERM_OCCURRENCES = 20;

const MODEL_DEFAULTS = [
	["anthropic", "claude-haiku-4-5"],
	["openai-codex", "gpt-5.4-mini"],
	["openrouter", "deepseek/deepseek-v4-flash"],
	["anthropic", "claude-3-5-haiku-latest"],
] as const;

const STOPWORDS = new Set(
	"a an and are as at be but by for from had has have how i if in into is it its me my of on or our so some that the their then there these they this to was we were what when where which while with would about session sessions remember something thing working worked did does done doing just like".split(
		" ",
	),
);

// =============================================================================
// Types
// =============================================================================

interface Llm {
	complete(prompt: string, signal: AbortSignal): Promise<string>;
}

interface ParsedQuery {
	keywords: string[];
	after?: Date;
	before?: Date;
}

interface Candidate {
	info: SessionInfo;
	score: number;
	matchedTerms: string[];
	snippet: string;
}

interface Match {
	info: SessionInfo;
	summary: string;
}

interface SearchOutcome {
	matches: Match[];
	warnings: string[];
	note?: string;
}

// =============================================================================
// Model access
// =============================================================================

async function createLlm(ctx: ExtensionContext): Promise<Llm | undefined> {
	const resolved = await resolveToolModel(TOOL_NAME, ctx, MODEL_DEFAULTS);
	const model = resolved ? ctx.modelRegistry.find(resolved.provider, resolved.id) : ctx.model;
	if (!model) return undefined;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return undefined;

	return {
		async complete(prompt, signal) {
			const stream = ctx.modelRegistry.streamSimple(
				model,
				{ messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
				{ reasoning: "low", signal: AbortSignal.any([signal, AbortSignal.timeout(LLM_TIMEOUT_MS)]) },
			);
			const response = await stream.result();
			if (response.stopReason === "error" || response.stopReason === "aborted") {
				throw new Error(response.errorMessage ?? response.stopReason);
			}
			return response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
		},
	};
}

function parseJson<T>(text: string, open: "{" | "["): T | undefined {
	const close = open === "{" ? "}" : "]";
	const start = text.indexOf(open);
	const end = text.lastIndexOf(close);
	if (start < 0 || end <= start) return undefined;
	try {
		return JSON.parse(text.slice(start, end + 1)) as T;
	} catch {
		return undefined;
	}
}

// =============================================================================
// Step 1: description -> keywords
// =============================================================================

function fallbackKeywords(description: string): string[] {
	const words = description.toLowerCase().match(/[a-z0-9][a-z0-9_.\-/]{2,}/g) ?? [];
	return [...new Set(words.filter((w) => !STOPWORDS.has(w)))].slice(0, MAX_KEYWORDS);
}

function parseDate(value: unknown): Date | undefined {
	if (typeof value !== "string") return undefined;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

async function extractQuery(llm: Llm | undefined, description: string, signal: AbortSignal): Promise<ParsedQuery> {
	const fallback: ParsedQuery = { keywords: fallbackKeywords(description) };
	if (!llm) return fallback;

	const today = new Date().toISOString().slice(0, 10);
	const prompt = [
		`Today is ${today}. The user is searching their old coding-assistant sessions and described the one they want:`,
		"",
		`<description>${description}</description>`,
		"",
		"Reply with JSON only, in this shape:",
		`{"keywords": [...], "after": "YYYY-MM-DD" | null, "before": "YYYY-MM-DD" | null}`,
		"",
		`- keywords: up to ${MAX_KEYWORDS} lowercase terms or short phrases likely to appear literally in that conversation. Include synonyms, abbreviations, related technical terms and likely file/library/tool names. Avoid generic words.`,
		"- after/before: only if the description implies a time period (e.g. 'last week'), otherwise null.",
	].join("\n");

	try {
		const parsed = parseJson<{ keywords?: unknown; after?: unknown; before?: unknown }>(
			await llm.complete(prompt, signal),
			"{",
		);
		const keywords = Array.isArray(parsed?.keywords)
			? parsed.keywords.filter((k): k is string => typeof k === "string").map((k) => k.toLowerCase().trim())
			: [];
		if (!parsed || keywords.length === 0) return fallback;
		return {
			keywords: [...new Set(keywords.filter(Boolean))].slice(0, MAX_KEYWORDS),
			after: parseDate(parsed.after),
			before: parseDate(parsed.before),
		};
	} catch (error) {
		if (signal.aborted) throw error;
		return fallback;
	}
}

// =============================================================================
// Step 2: local scoring
// =============================================================================

function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let from = 0;
	while (count < MAX_TERM_OCCURRENCES) {
		const index = haystack.indexOf(needle, from);
		if (index < 0) break;
		count++;
		from = index + needle.length;
	}
	return count;
}

function compactSnippet(text: string, index: number): string {
	const start = Math.max(0, index - SNIPPET_RADIUS);
	return text
		.slice(start, index + SNIPPET_RADIUS)
		.replace(/\s+/g, " ")
		.trim();
}

function inDateWindow(info: SessionInfo, query: ParsedQuery): boolean {
	if (query.after && info.modified < query.after) return false;
	if (query.before && info.created > new Date(query.before.getTime() + 86_400_000)) return false;
	return true;
}

/** BM25-flavoured scoring: rare terms count more, repeats saturate. */
function scoreSessions(sessions: SessionInfo[], query: ParsedQuery): Candidate[] {
	const haystacks = sessions.map((s) => `${s.name ?? ""} ${s.cwd} ${s.allMessagesText}`.toLowerCase());
	const scores = new Array<number>(sessions.length).fill(0);
	const matched = sessions.map(() => [] as string[]);
	const bestHit = sessions.map(() => ({ weight: 0, index: -1 }));

	for (const term of query.keywords) {
		const counts = haystacks.map((h) => countOccurrences(h, term));
		const docFreq = counts.filter((c) => c > 0).length;
		if (docFreq === 0) continue;
		const idf = Math.log(1 + sessions.length / docFreq);
		counts.forEach((count, i) => {
			if (count === 0) return;
			scores[i] += idf * (count / (count + 2));
			matched[i].push(term);
			if (idf > bestHit[i].weight) bestHit[i] = { weight: idf, index: haystacks[i].indexOf(term) };
		});
	}

	const scored = sessions.flatMap((info, i): Candidate[] =>
		scores[i] > 0 && inDateWindow(info, query)
			? [{ info, score: scores[i], matchedTerms: matched[i], snippet: compactSnippet(haystacks[i], bestHit[i].index) }]
			: [],
	);
	scored.sort((a, b) => b.score - a.score);
	const floor = (scored[0]?.score ?? 0) * RELATIVE_SCORE_CUTOFF;
	return scored.filter((c) => c.score >= floor).slice(0, MAX_CANDIDATES);
}

// =============================================================================
// Step 3: cached summaries
// =============================================================================

interface SummaryRecord {
	modified: string;
	summary: string;
}

type SummaryCache = Record<string, SummaryRecord>;

function readCache(): SummaryCache {
	try {
		const parsed = JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** Re-reads before writing so concurrent pi instances don't clobber each other. */
function saveToCache(entries: Record<string, SummaryRecord>): void {
	try {
		const cache = { ...readCache(), ...entries };
		fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
		const tmpPath = `${CACHE_PATH}.${process.pid}.tmp`;
		fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2) + "\n");
		fs.renameSync(tmpPath, CACHE_PATH);
	} catch {
		// Best-effort cache.
	}
}

function cachedSummary(cache: SummaryCache, info: SessionInfo): string | undefined {
	const record = cache[info.id];
	return record && record.modified === info.modified.toISOString() ? record.summary : undefined;
}

function excerptOf(info: SessionInfo): string {
	const text = info.allMessagesText.replace(/\s+/g, " ").trim();
	if (text.length <= EXCERPT_HEAD_CHARS + EXCERPT_TAIL_CHARS) return text;
	return `${text.slice(0, EXCERPT_HEAD_CHARS)} [...] ${text.slice(-EXCERPT_TAIL_CHARS)}`;
}

function fallbackSummary(info: SessionInfo): string {
	const first = info.name ?? info.firstMessage.replace(/\s+/g, " ").trim();
	return first.length > 140 ? `${first.slice(0, 137)}...` : first || "(no text)";
}

async function summariseBatch(llm: Llm, batch: SessionInfo[], signal: AbortSignal): Promise<Record<string, string>> {
	const sessions = batch.map((info, i) => {
		const name = info.name ? ` (named "${info.name}")` : "";
		return `<session id="${i + 1}"${name} cwd="${info.cwd}">\n${excerptOf(info)}\n</session>`;
	});
	const prompt = [
		"Below are excerpts (start and end) of coding-assistant sessions between a user and an AI.",
		"For each, write ONE sentence (under 140 characters) saying what the user was working on. Be specific: name the project, technology, file or problem. No preamble.",
		`Reply with JSON only: {"1": "sentence", "2": "sentence", ...}`,
		"",
		...sessions,
	].join("\n");

	const parsed = parseJson<Record<string, unknown>>(await llm.complete(prompt, signal), "{") ?? {};
	const summaries: Record<string, string> = {};
	batch.forEach((info, i) => {
		const value = parsed[String(i + 1)];
		if (typeof value === "string" && value.trim()) summaries[info.id] = value.replace(/\s+/g, " ").trim();
	});
	return summaries;
}

function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
	return chunks;
}

async function runPool<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
	const results: T[] = new Array(tasks.length);
	let next = 0;
	const worker = async () => {
		while (next < tasks.length) {
			const index = next++;
			results[index] = await tasks[index]();
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
	return results;
}

async function summariseCandidates(
	llm: Llm | undefined,
	candidates: Candidate[],
	signal: AbortSignal,
	warnings: string[],
): Promise<Map<string, string>> {
	const cache = readCache();
	const summaries = new Map<string, string>();
	const missing: SessionInfo[] = [];
	for (const { info } of candidates) {
		const hit = cachedSummary(cache, info);
		if (hit) summaries.set(info.id, hit);
		else missing.push(info);
	}
	if (missing.length === 0 || !llm) {
		if (missing.length > 0) warnings.push("No model available; using first messages instead of summaries");
		return summaries;
	}

	const fresh: Record<string, SummaryRecord> = {};
	const batches = chunk(missing, SUMMARY_BATCH_SIZE);
	let failed = false;
	await runPool(
		batches.map((batch) => async () => {
			try {
				const result = await summariseBatch(llm, batch, signal);
				for (const info of batch) {
					const summary = result[info.id];
					if (!summary) continue;
					summaries.set(info.id, summary);
					fresh[info.id] = { modified: info.modified.toISOString(), summary };
				}
			} catch (error) {
				if (signal.aborted) throw error;
				failed = true;
			}
		}),
		SUMMARY_CONCURRENCY,
	);
	saveToCache(fresh);
	if (failed) warnings.push("Some summaries could not be generated");
	return summaries;
}

// =============================================================================
// Step 4: choose which candidates could match
// =============================================================================

function formatDateRange(info: SessionInfo): string {
	const date = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
	const time = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
	if (date(info.created) === date(info.modified)) {
		return `${date(info.created)} ${time(info.created)}–${time(info.modified)}`;
	}
	return `${date(info.created)} – ${date(info.modified)}`;
}

function shortenHome(dir: string): string {
	if (!dir) return "(unknown dir)";
	const home = os.homedir();
	return dir === home || dir.startsWith(home + path.sep) ? `~${dir.slice(home.length)}` : dir;
}

/**
 * Triage: one model call over cheap evidence (first message, keyword snippet,
 * and a cached summary when we already have one). Runs before summarising so
 * only the survivors cost summary calls.
 */
async function selectMatching(
	llm: Llm | undefined,
	description: string,
	candidates: Candidate[],
	signal: AbortSignal,
	warnings: string[],
): Promise<Candidate[]> {
	const fallback = candidates.slice(0, MAX_SHOWN);
	if (!llm) return fallback;

	const cache = readCache();
	const lines = candidates.map((c, i) => {
		const summary = cachedSummary(cache, c.info);
		const firstMessage = c.info.firstMessage.replace(/\s+/g, " ").trim().slice(0, FIRST_MESSAGE_CHARS);
		return [
			`[${i + 1}] ${formatDateRange(c.info)} | ${shortenHome(c.info.cwd)} | ${c.info.messageCount} msgs`,
			summary ? `    summary: ${summary}` : `    first message: ${firstMessage}`,
			`    matched terms: ${c.matchedTerms.join(", ")}`,
			`    snippet: …${c.snippet}…`,
		].join("\n");
	});
	const prompt = [
		"A user is looking for one of their old coding-assistant sessions. They described it as:",
		"",
		`<description>${description}</description>`,
		"",
		"These candidate sessions were found by keyword search:",
		"",
		...lines,
		"",
		`Pick the candidates that could plausibly be the session described, best match first, at most ${MAX_SHOWN}. Exclude ones that merely share generic words; keep ones that are plausible even if uncertain.`,
		"Reply with a JSON array of candidate numbers only, e.g. [3, 1, 7].",
	].join("\n");

	try {
		const parsed = parseJson<unknown[]>(await llm.complete(prompt, signal), "[");
		if (!parsed) throw new Error("unparseable");
		return [...new Set(parsed.filter((n): n is number => Number.isInteger(n)))]
			.map((n) => candidates[n - 1])
			.filter((c): c is Candidate => c !== undefined)
			.slice(0, MAX_SHOWN);
	} catch (error) {
		if (signal.aborted) throw error;
		warnings.push("Could not rank candidates; showing top keyword matches");
		return fallback;
	}
}

// =============================================================================
// Orchestration
// =============================================================================

async function searchSessions(
	ctx: ExtensionContext,
	description: string,
	signal: AbortSignal,
	progress: (message: string) => void,
): Promise<SearchOutcome> {
	const warnings: string[] = [];
	const llm = await createLlm(ctx);
	if (!llm) warnings.push("No model available; falling back to plain keyword search");

	progress("Understanding your description…");
	const query = await extractQuery(llm, description, signal);

	progress("Scanning session history…");
	const currentSession = ctx.sessionManager.getSessionFile();
	const sessions = (await SessionManager.listAll(undefined, undefined, signal)).filter((s) => s.path !== currentSession);
	const candidates = scoreSessions(sessions, query);
	if (candidates.length === 0) {
		return {
			matches: [],
			warnings,
			note: `No sessions matched (searched ${sessions.length} for: ${query.keywords.join(", ")})`,
		};
	}

	progress(`Narrowing ${candidates.length} candidate sessions…`);
	const selected = await selectMatching(llm, description, candidates, signal, warnings);

	progress(`Summarising ${selected.length} sessions…`);
	const summaries = await summariseCandidates(llm, selected, signal, warnings);

	return {
		matches: selected.map((c) => ({ info: c.info, summary: summaries.get(c.info.id) ?? fallbackSummary(c.info) })),
		warnings,
		note: selected.length === 0 ? `Found ${candidates.length} keyword matches, but none looked right` : undefined,
	};
}

/** Runs the search behind a cancellable loader. Resolves null if cancelled. */
function searchWithLoader(ctx: ExtensionCommandContext, description: string): Promise<SearchOutcome | null> {
	return ctx.ui.custom<SearchOutcome | null>((tui, theme, _kb, done) => {
		const loader = new CancellableLoader(
			tui,
			(s) => theme.fg("accent", s),
			(s) => theme.fg("muted", s),
			"Searching sessions…",
		);
		loader.onAbort = () => done(null);

		searchSessions(ctx, description, loader.signal, (message) => loader.setMessage(message))
			.then((outcome) => !loader.aborted && done(outcome))
			.catch((error) => {
				if (loader.aborted) return;
				const message = error instanceof Error ? error.message : String(error);
				done({ matches: [], warnings: [], note: `Search failed: ${message}` });
			});

		const border = (s: string) => theme.fg("border", s);
		const container = new Container();
		container.addChild(new DynamicBorder(border));
		container.addChild(loader);
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", "esc cancel"), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(new DynamicBorder(border));
		(container as Container & { handleInput?: (data: string) => void }).handleInput = (data) =>
			loader.handleInput(data);
		return container;
	});
}

// =============================================================================
// Result picker
// =============================================================================

type PickerTheme = { fg(color: string, text: string): string; bold(text: string): string };

function createPicker(
	tui: TUI,
	theme: PickerTheme,
	description: string,
	matches: Match[],
	done: (result: Match | undefined) => void,
): Component & { handleInput(data: string): void } {
	let selected = 0;
	let scrollTop = 0;
	const LINES_PER_ITEM = 5; // date, dir, up to 2 summary lines, spacer
	const CHROME_LINES = 6;

	const pageSize = () => Math.max(1, Math.floor((tui.terminal.rows - CHROME_LINES) / LINES_PER_ITEM));

	const move = (to: number) => {
		selected = Math.max(0, Math.min(matches.length - 1, to));
		const size = pageSize();
		if (selected < scrollTop) scrollTop = selected;
		if (selected >= scrollTop + size) scrollTop = selected - size + 1;
		tui.requestRender();
	};

	return {
		handleInput(data: string) {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return done(undefined);
			if (matchesKey(data, "enter")) return done(matches[selected]);
			if (matchesKey(data, "up")) return move(selected - 1);
			if (matchesKey(data, "down")) return move(selected + 1);
			if (matchesKey(data, "pageUp")) return move(selected - pageSize());
			if (matchesKey(data, "pageDown")) return move(selected + pageSize());
			if (matchesKey(data, "home")) return move(0);
			if (matchesKey(data, "end")) return move(matches.length - 1);
		},
		invalidate() {},
		render(width: number): string[] {
			const lines: string[] = [];
			const rule = theme.fg("border", "─".repeat(width));
			lines.push(rule);
			lines.push(truncateToWidth(` ${theme.bold("Sessions matching:")} ${theme.fg("muted", description)}`, width));
			lines.push("");

			const visible = matches.slice(scrollTop, scrollTop + pageSize());
			visible.forEach((match, offset) => {
				const isSelected = scrollTop + offset === selected;
				const marker = isSelected ? theme.fg("accent", "›") : " ";
				const dateText = formatDateRange(match.info);
				const dateLabel = isSelected ? theme.fg("accent", dateText) : dateText;
				const header = `${dateLabel}  ${theme.fg("dim", `${match.info.messageCount} msgs`)}`;
				lines.push(truncateToWidth(` ${marker} ${header}`, width));
				lines.push(truncateToWidth(`   ${theme.fg("dim", shortenHome(match.info.cwd))}`, width));
				const summary = wrapTextWithAnsi(match.summary, Math.max(10, width - 4)).slice(0, 2);
				for (const line of summary) lines.push(truncateToWidth(`   ${isSelected ? line : theme.fg("muted", line)}`, width));
				lines.push("");
			});

			const position = theme.fg("dim", `${selected + 1}/${matches.length}`);
			lines.push(truncateToWidth(` ${theme.fg("dim", "↑↓ navigate • enter resume • esc cancel")}  ${position}`, width));
			lines.push(rule);
			return lines;
		},
	};
}

// =============================================================================
// Command
// =============================================================================

async function runCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/resume-from-search needs an interactive session", "error");
		return;
	}

	const description =
		args.trim() || (await ctx.ui.input("Describe the session you're looking for", "e.g. the one where I fixed the flaky websocket reconnect test"))?.trim();
	if (!description) return;

	const outcome = await searchWithLoader(ctx, description);
	if (!outcome) return;
	for (const warning of outcome.warnings) ctx.ui.notify(warning, "warning");
	if (outcome.matches.length === 0) {
		ctx.ui.notify(outcome.note ?? "No matching sessions found", "info");
		return;
	}

	const choice = await ctx.ui.custom<Match | undefined>((tui, theme, _kb, done) =>
		createPicker(tui, theme, description, outcome.matches, done),
	);
	if (!choice) return;

	await ctx.switchSession(choice.info.path);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("resume-from-search", {
		description: "Find and resume a session (any directory) from a prose description",
		handler: runCommand,
	});
}

/**
 * Session summaries for the /resume list.
 *
 * - On exit (or when leaving a session) a one-line summary is generated with a
 *   small model and stored in ~/.pi/agent/session-summaries.json, keyed by
 *   session id. Session files themselves are never modified.
 * - pi's built-in /resume picker can't be extended, so this extension rewrites
 *   "/resume" + Enter into /resume-summaries, which opens the same picker
 *   (SessionSelectorComponent) with summaries shown in place of the first
 *   message. Sessions lacking a summary are summarised on the spot, with a
 *   spinner. Sessions the user has named with /name keep their name.
 *
 * The model can be changed with /tool-models (tool name: "session-summary").
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	getAgentDir,
	parseSessionEntries,
	SessionManager,
	SessionSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, SessionInfo } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, matchesKey } from "@earendil-works/pi-tui";
import { resolveToolModel } from "./lib/tool-model-config";

const STORE_PATH = path.join(getAgentDir(), "session-summaries.json");
const TOOL_NAME = "session-summary";
const COMMAND_NAME = "resume-summaries";

const SUMMARY_TIMEOUT_MS = 20_000;
const MAX_SUMMARY_CHARS = 160;
// Per /resume scope load: newest sessions first, the rest are filled next time.
const MAX_SUMMARIES_PER_LOAD = 50;
const CONCURRENCY = 5;

const TRANSCRIPT_MAX_CHARS = 6000;
const MESSAGE_MAX_CHARS = 700;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const SUMMARY_MODEL_DEFAULTS = [
	["anthropic", "claude-haiku-4-5"],
	["openai-codex", "gpt-5.4-mini"],
	["openrouter", "deepseek/deepseek-v4-flash"],
	["anthropic", "claude-3-5-haiku-latest"],
] as const;

// =============================================================================
// Storage
// =============================================================================

interface SummaryRecord {
	summary: string;
	/** Message entries in the session when the summary was written. */
	messageCount: number;
	generatedAt: string;
}

type SummaryStore = Record<string, SummaryRecord>;

function readStore(): SummaryStore {
	try {
		const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** Re-reads before writing so concurrent pi instances don't clobber each other. */
function saveSummary(sessionId: string, record: SummaryRecord): void {
	try {
		const store = readStore();
		store[sessionId] = record;
		fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
		const tmpPath = `${STORE_PATH}.${process.pid}.tmp`;
		fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2) + "\n");
		fs.renameSync(tmpPath, STORE_PATH);
	} catch {
		// Best-effort persistence.
	}
}

// =============================================================================
// Transcript
// =============================================================================

interface EntryLike {
	type: string;
	message?: { role?: string; content?: unknown };
}

interface Transcript {
	text: string;
	messageCount: number;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Returns undefined when there's nothing worth summarising yet. */
function buildTranscript(entries: ReadonlyArray<EntryLike>): Transcript | undefined {
	const lines: string[] = [];
	let messageCount = 0;
	let hasUser = false;
	let hasAssistant = false;

	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message) continue;
		messageCount++;
		const { role } = entry.message;
		if (role !== "user" && role !== "assistant") continue;
		const text = extractText(entry.message.content).trim();
		if (!text) continue;
		if (role === "user") hasUser = true;
		else hasAssistant = true;
		lines.push(`${role === "user" ? "User" : "Assistant"}: ${clip(text, MESSAGE_MAX_CHARS)}`);
	}
	if (!hasUser || !hasAssistant) return undefined;

	let joined = lines.join("\n");
	if (joined.length > TRANSCRIPT_MAX_CHARS) {
		// Keep the opening (the task) and the end (the outcome).
		const head = Math.floor(TRANSCRIPT_MAX_CHARS * 0.4);
		const tail = TRANSCRIPT_MAX_CHARS - head;
		joined = `${joined.slice(0, head)}\n[… middle of session omitted …]\n${joined.slice(-tail)}`;
	}
	return { text: joined, messageCount };
}

function readFileTranscript(sessionPath: string): Transcript | undefined {
	try {
		const entries = parseSessionEntries(fs.readFileSync(sessionPath, "utf-8"));
		return buildTranscript(entries as unknown as EntryLike[]);
	} catch {
		return undefined;
	}
}

// =============================================================================
// Generation
// =============================================================================

interface Generator {
	model: NonNullable<ExtensionContext["model"]>;
	registry: ExtensionContext["modelRegistry"];
}

async function resolveGenerator(ctx: ExtensionContext): Promise<Generator | undefined> {
	const resolved = await resolveToolModel(TOOL_NAME, ctx, SUMMARY_MODEL_DEFAULTS);
	const model = (resolved && ctx.modelRegistry.find(resolved.provider, resolved.id)) || ctx.model;
	if (!model) return undefined;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return undefined;
	return { model, registry: ctx.modelRegistry };
}

function buildPrompt(transcript: string): string {
	return [
		"Below is a transcript of a coding-agent session (long messages are clipped).",
		`Write ONE line (under ${MAX_SUMMARY_CHARS - 40} characters) saying what the session was about or achieved,`,
		"so the user can recognise it in a list of past sessions.",
		"Be specific: name the feature, bug, file or system involved. Start with a verb or noun phrase, not 'The user'.",
		"Output only the line: no quotes, no markdown, no preamble, no trailing full stop.",
		"",
		"<transcript>",
		transcript,
		"</transcript>",
	].join("\n");
}

function cleanSummary(raw: string): string | undefined {
	const firstLine = raw.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
	const cleaned = firstLine
		.replace(/^summary:\s*/i, "")
		.replace(/^[\s"'`*#>-]+/, "")
		.replace(/[\s"'`*.]+$/, "")
		.trim();
	if (!cleaned) return undefined;
	return cleaned.length > MAX_SUMMARY_CHARS ? `${cleaned.slice(0, MAX_SUMMARY_CHARS - 1)}…` : cleaned;
}

async function generateSummary(gen: Generator, transcript: string, signal?: AbortSignal): Promise<string | undefined> {
	const timeout = AbortSignal.timeout(SUMMARY_TIMEOUT_MS);
	try {
		const response = await gen.registry
			.streamSimple(
				gen.model,
				{
					messages: [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: buildPrompt(transcript) }],
							timestamp: Date.now(),
						},
					],
				},
				{ signal: signal ? AbortSignal.any([signal, timeout]) : timeout },
			)
			.result();
		const text = response.content
			.filter((block) => block.type === "text")
			.map((block) => (block as { text: string }).text)
			.join("");
		return cleanSummary(text);
	} catch {
		return undefined;
	}
}

async function summariseAndStore(
	gen: Generator,
	sessionId: string,
	transcript: Transcript,
	signal?: AbortSignal,
): Promise<boolean> {
	const summary = await generateSummary(gen, transcript.text, signal);
	if (!summary) return false;
	saveSummary(sessionId, {
		summary,
		messageCount: transcript.messageCount,
		generatedAt: new Date().toISOString(),
	});
	return true;
}

// =============================================================================
// /resume picker
// =============================================================================

/** Shared between the loaders (which do the work) and the spinner (which shows it). */
class FillProgress {
	total = 0;
	done = 0;
	get busy(): boolean {
		return this.done < this.total;
	}
}

function sessionNeedsSummary(session: SessionInfo, store: SummaryStore): boolean {
	return !store[session.id] && !session.name && session.messageCount > 0;
}

/** Fill in missing summaries, newest sessions first. Resolves when all are attempted. */
async function fillMissingSummaries(
	sessions: SessionInfo[],
	getGenerator: () => Promise<Generator | undefined>,
	progress: FillProgress,
	signal: AbortSignal,
): Promise<void> {
	const store = readStore();
	const missing = sessions
		.filter((session) => sessionNeedsSummary(session, store))
		.sort((a, b) => b.modified.getTime() - a.modified.getTime())
		.slice(0, MAX_SUMMARIES_PER_LOAD);
	if (missing.length === 0) return;

	progress.total += missing.length;
	const gen = await getGenerator();
	const queue = [...missing];

	const worker = async () => {
		for (let session = queue.shift(); session; session = queue.shift()) {
			try {
				if (gen && !signal.aborted) {
					const transcript = readFileTranscript(session.path);
					if (transcript) await summariseAndStore(gen, session.id, transcript, signal);
				}
			} finally {
				progress.done++;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, worker));
}

/** Show the summary where the picker would show the first message; user-set names win. */
function applySummaries(sessions: SessionInfo[]): SessionInfo[] {
	const store = readStore();
	return sessions.map((session) => {
		const record = store[session.id];
		if (!record || session.name) return session;
		return {
			...session,
			firstMessage: record.summary,
			// Keep summaries searchable.
			allMessagesText: `${record.summary} ${session.allMessagesText}`,
		};
	});
}

function isDefaultSessionDir(sessionDir: string): boolean {
	return path.dirname(sessionDir) === path.join(getAgentDir(), "sessions");
}

/** Wraps the stock selector, adding an animated spinner row while summaries are generated. */
class SelectorWithSpinner implements Component, Focusable {
	private frame = 0;
	private timer: ReturnType<typeof setInterval>;

	constructor(
		private readonly selector: SessionSelectorComponent,
		private readonly progress: FillProgress,
		private readonly requestRender: () => void,
		private readonly colour: (text: string) => string,
	) {
		this.timer = setInterval(() => {
			if (!this.progress.busy) return;
			this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
			this.requestRender();
		}, 80);
		this.timer.unref?.();
	}

	get focused(): boolean {
		return this.selector.focused;
	}

	set focused(value: boolean) {
		this.selector.focused = value;
	}

	render(width: number): string[] {
		const lines = this.selector.render(width);
		if (!this.progress.busy) return lines;
		const { done, total } = this.progress;
		const spinner = `${SPINNER_FRAMES[this.frame]} Summarising sessions ${done}/${total}…`;
		return [` ${this.colour(spinner)}`, ...lines];
	}

	handleInput(data: string): void {
		this.selector.handleInput(data);
	}

	invalidate(): void {
		this.selector.invalidate();
	}

	dispose(): void {
		clearInterval(this.timer);
	}
}

// =============================================================================
// Extension
// =============================================================================

export default function (pi: ExtensionAPI) {
	let unsubscribeInput: (() => void) | undefined;

	pi.registerCommand(COMMAND_NAME, {
		description: "Resume a session (list shows AI-generated summaries)",
		handler: async (_args, ctx) => {
			const sessionManager = ctx.sessionManager;
			const cwd = sessionManager.getCwd();
			const sessionDir = sessionManager.getSessionDir();
			const progress = new FillProgress();
			const lifetime = new AbortController();

			let generatorPromise: Promise<Generator | undefined> | undefined;
			const getGenerator = () => {
				generatorPromise ??= resolveGenerator(ctx).then((gen) => {
					if (!gen) ctx.ui.notify("session-summary: no usable model; showing first messages", "warning");
					return gen;
				});
				return generatorPromise;
			};

			const withSummaries =
				(list: (onProgress: any, signal: AbortSignal) => Promise<SessionInfo[]>) =>
				async (onProgress: any, signal?: AbortSignal) => {
					const loadSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
					const sessions = await list(onProgress, loadSignal);
					await fillMissingSummaries(sessions, getGenerator, progress, loadSignal);
					return applySummaries(sessions);
				};

			const chosen = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
				let wrapper: SelectorWithSpinner | undefined;
				const finish = (result: string | null) => {
					lifetime.abort();
					wrapper?.dispose();
					done(result);
				};

				const selector = new SessionSelectorComponent(
					withSummaries((onProgress, signal) => SessionManager.list(cwd, sessionDir, onProgress, signal)),
					withSummaries((onProgress, signal) =>
						isDefaultSessionDir(sessionDir)
							? SessionManager.listAll(onProgress, signal)
							: SessionManager.listAll(sessionDir, onProgress, signal),
					),
					(sessionPath) => finish(sessionPath),
					() => finish(null),
					() => finish(null),
					() => tui.requestRender(),
					{
						renameSession: async (sessionFilePath, nextName) => {
							const next = (nextName ?? "").trim();
							if (next) SessionManager.open(sessionFilePath).appendSessionInfo(next);
						},
						showRenameHint: true,
						keybindings,
					},
					sessionManager.getSessionFile(),
				);

				wrapper = new SelectorWithSpinner(selector, progress, () => tui.requestRender(), (text) =>
					theme.fg("accent", text),
				);
				return wrapper;
			});

			if (!chosen) return;
			try {
				await ctx.switchSession(chosen);
			} catch (error) {
				ctx.ui.notify(`Failed to resume session: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		// The built-in /resume can't be overridden, so redirect it to our command.
		unsubscribeInput?.();
		unsubscribeInput = ctx.ui.onTerminalInput((data) => {
			if (!matchesKey(data, "enter")) return undefined;
			if (ctx.ui.getEditorText().trim() === "/resume") ctx.ui.setEditorText(`/${COMMAND_NAME}`);
			return undefined;
		});
	});

	pi.on("session_shutdown", async (event, ctx) => {
		unsubscribeInput?.();
		unsubscribeInput = undefined;

		// Skip non-interactive runs (e.g. subagents) and reloads, which don't leave the session.
		if (ctx.mode !== "tui" || event.reason === "reload") return;

		try {
			const sessionManager = ctx.sessionManager;
			if (sessionManager.getSessionName()) return; // user-set names take precedence
			const sessionId = sessionManager.getSessionId();
			const transcript = buildTranscript(sessionManager.getEntries() as unknown as EntryLike[]);
			if (!transcript) return;
			if (readStore()[sessionId]?.messageCount === transcript.messageCount) return;

			const gen = await resolveGenerator(ctx);
			if (!gen) return;

			const job = summariseAndStore(gen, sessionId, transcript);
			if (event.reason === "quit") {
				ctx.ui.setStatus(TOOL_NAME, "Summarising session…");
				await job;
				ctx.ui.setStatus(TOOL_NAME, undefined);
			}
			// Otherwise the process keeps running, so let it finish in the background.
		} catch {
			// Never block shutdown.
		}
	});
}

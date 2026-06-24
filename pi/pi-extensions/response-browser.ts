/**
 * Response Browser — PageUp/PageDown to flip between agent responses.
 *
 * A "response" is the last assistant message before the next user message
 * (i.e., the final reply in each turn before the user typed again).
 *
 * Keybindings:
 *   Shift+Up              — open browser / previous response
 *   Shift+Down            — next response (or close if at latest)
 *   Escape                — close browser
 *
 * Once open:
 *   ↑/↓                   — scroll within the current response
 *   Shift+Up / PageUp     — previous response
 *   Shift+Down / PageDown — next response (close if at latest)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

interface Response {
	index: number; // 1-based response number
	textContent: string; // markdown text of the assistant message
	model: string;
	timestamp: number;
	userPrompt: string; // the user prompt that triggered this response
}

function extractResponses(ctx: ExtensionContext): Response[] {
	const branch = ctx.sessionManager.getBranch();
	const responses: Response[] = [];

	// Walk the branch looking for response boundaries:
	// A "response" = last assistant message before the next user message
	let lastAssistant: {
		text: string;
		model: string;
		timestamp: number;
	} | null = null;
	let currentUserPrompt = "";

	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const msg = entry.message;

		if (msg.role === "user") {
			// If we had a pending assistant message, that was a complete response
			if (lastAssistant) {
				responses.push({
					index: responses.length + 1,
					textContent: lastAssistant.text,
					model: lastAssistant.model,
					timestamp: lastAssistant.timestamp,
					userPrompt: currentUserPrompt,
				});
				lastAssistant = null;
			}
			// Capture the user prompt text
			if (typeof msg.content === "string") {
				currentUserPrompt = msg.content;
			} else if (Array.isArray(msg.content)) {
				currentUserPrompt = msg.content
					.filter((b: any) => b.type === "text")
					.map((b: any) => b.text)
					.join("\n");
			}
		} else if (msg.role === "assistant") {
			// Extract text content from assistant message
			const textParts: string[] = [];
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if ((block as any).type === "text") {
						textParts.push((block as any).text);
					}
				}
			}
			if (textParts.length > 0) {
				lastAssistant = {
					text: textParts.join("\n"),
					model: (msg as any).model || "unknown",
					timestamp: msg.timestamp,
				};
			}
		}
	}

	// Don't forget the last assistant message (the current/latest response)
	if (lastAssistant) {
		responses.push({
			index: responses.length + 1,
			textContent: lastAssistant.text,
			model: lastAssistant.model,
			timestamp: lastAssistant.timestamp,
			userPrompt: currentUserPrompt,
		});
	}

	return responses;
}

function truncatePrompt(prompt: string, maxLen: number): string {
	const oneLine = prompt.replace(/\n/g, " ").trim();
	if (visibleWidth(oneLine) <= maxLen) return oneLine;
	return truncateToWidth(oneLine, maxLen, "…");
}

export default function (pi: ExtensionAPI) {
	// Track if browser is currently open to avoid double-opening
	let browserOpen = false;

	async function openBrowser(ctx: ExtensionContext, direction: "up" | "down") {
		if (browserOpen) return;

		const responses = extractResponses(ctx);
		if (responses.length === 0) {
			ctx.ui.notify("No responses to browse", "warning");
			return;
		}

		browserOpen = true;

		// Start at the end for "up" (then immediately go back), or end for "down"
		let currentIdx = direction === "up" ? responses.length - 2 : responses.length - 1;
		if (currentIdx < 0) currentIdx = 0;

		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				const mdTheme = getMarkdownTheme();
				let scrollOffset = 0;
				let totalContentLines = 0; // track for clamping
				let viewportLines = 0; // how many content lines fit

				function switchResponse(newIdx: number) {
					currentIdx = newIdx;
					scrollOffset = 0; // reset scroll on response change
					tui.requestRender();
				}

				return {
					handleInput(data: string) {
						if (matchesKey(data, "escape") || matchesKey(data, "q")) {
							done();
							return;
						}

						// Shift+Up / PageUp — previous response
						if (matchesKey(data, "shift+up") || matchesKey(data, "pageUp")) {
							if (currentIdx > 0) switchResponse(currentIdx - 1);
							return;
						}

						// Shift+Down / PageDown — next response (or close at end)
						if (matchesKey(data, "shift+down") || matchesKey(data, "pageDown")) {
							if (currentIdx < responses.length - 1) {
								switchResponse(currentIdx + 1);
							} else {
								done();
							}
							return;
						}

						// Up/Down — scroll within response
						if (matchesKey(data, "up")) {
							if (scrollOffset > 0) {
								scrollOffset--;
								tui.requestRender();
							}
							return;
						}
						if (matchesKey(data, "down")) {
							const maxScroll = Math.max(0, totalContentLines - viewportLines);
							if (scrollOffset < maxScroll) {
								scrollOffset++;
								tui.requestRender();
							}
							return;
						}

						// Home/End — jump to top/bottom
						if (matchesKey(data, "home")) {
							scrollOffset = 0;
							tui.requestRender();
							return;
						}
						if (matchesKey(data, "end")) {
							scrollOffset = Math.max(0, totalContentLines - viewportLines);
							tui.requestRender();
							return;
						}
					},

					render(width: number): string[] {
						const resp = responses[currentIdx];
						if (!resp) {
							done();
							return [""];
						}

						const innerW = width - 4; // 2 border + 2 padding
						const lines: string[] = [];

						const border = (s: string) => theme.fg("border", s);
						const pad = (s: string, len: number) => {
							const vis = visibleWidth(s);
							return s + " ".repeat(Math.max(0, len - vis));
						};
						const row = (content: string) => border("│") + " " + pad(content, innerW) + " " + border("│");
						const emptyRow = () => border("│") + " ".repeat(innerW + 2) + border("│");

						// Top border with position indicator
						const posText = ` ${resp.index}/${responses.length} `;
						const topBar = "─".repeat(Math.max(0, innerW + 2 - visibleWidth(posText)));
						lines.push(border("╭") + border(topBar) + theme.fg("dim", posText) + border("╮"));

						// Header: model + timestamp
						const date = new Date(resp.timestamp);
						const timeStr = date.toLocaleTimeString([], {
							hour: "2-digit",
							minute: "2-digit",
						});
						const dateStr = date.toLocaleDateString([], {
							month: "short",
							day: "numeric",
						});
						const header = `${theme.fg("accent", resp.model)}  ${theme.fg("dim", `${dateStr} ${timeStr}`)}`;
						lines.push(row(header));

						// User prompt that triggered this response
						const prompt = truncatePrompt(resp.userPrompt, innerW - 4);
						lines.push(row(theme.fg("dim", "▸ ") + theme.fg("muted", prompt)));

						// Separator
						lines.push(border("├") + border("─".repeat(innerW + 2)) + border("┤"));

						// Response content — render as markdown
						const md = new Markdown(resp.textContent, 0, 0, mdTheme);
						const mdLines = md.render(innerW);

						// Chrome = top border + header + prompt + separator + bottom (empty + help + border) = 8 lines
						const chromeLines = 8;
						const maxContentLines = Math.max(5, (tui as any).height ? (tui as any).height - chromeLines : 40);

						// Update scroll state for input handler
						totalContentLines = mdLines.length;
						viewportLines = maxContentLines;

						// Clamp scroll offset
						const maxScroll = Math.max(0, totalContentLines - viewportLines);
						if (scrollOffset > maxScroll) scrollOffset = maxScroll;

						// Slice the visible window
						const displayLines = mdLines.slice(scrollOffset, scrollOffset + maxContentLines);

						for (const line of displayLines) {
							lines.push(border("│") + " " + pad(line, innerW) + " " + border("│"));
						}

						// Bottom border with help + scroll position
						lines.push(emptyRow());
						const canScroll = totalContentLines > viewportLines;
						const scrollHint = canScroll
							? theme.fg("dim", ` [${scrollOffset + 1}–${Math.min(scrollOffset + viewportLines, totalContentLines)}/${totalContentLines}]`)
							: "";
						const help = theme.fg("dim", "↑↓ scroll • ⇧↑↓ prev/next • esc close") + scrollHint;
						lines.push(row(help));
						lines.push(border("╰") + border("─".repeat(innerW + 2)) + border("╯"));

						return lines;
					},

					invalidate() {},
				};
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "90%",
					maxHeight: "90%",
					minWidth: 60,
				},
			},
		);

		browserOpen = false;
	}

	// Register shortcuts — only Shift+Up/Down to avoid stealing editor PageUp/PageDown
	pi.registerShortcut("shift+up", {
		description: "Browse previous responses",
		handler: (ctx) => openBrowser(ctx, "up"),
	});

	pi.registerShortcut("shift+down", {
		description: "Browse next responses",
		handler: (ctx) => openBrowser(ctx, "down"),
	});
}

/**
 * Auto-Commit Extension
 *
 * After every agent response, checks if any files were written/edited,
 * finds which git repos they belong to, and auto-commits with an "AI:" prefix.
 *
 * When the same repo is touched in consecutive agent responses, asks the user
 * whether to amend the previous commit (fix) or create a new one (build on it).
 *
 * Provides /scrap command to undo the last auto-commit and stash changes.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolve, dirname } from "node:path";

export default function (pi: ExtensionAPI) {
	// Track last auto-commit per repo: repoRoot -> { sha, message }
	const lastAutoCommit = new Map<string, { sha: string; message: string }>();

	pi.on("agent_end", async (event, ctx) => {
		// Collect file paths from write/edit tool calls in this agent run
		const editedFiles = new Set<string>();

		for (const msg of event.messages) {
			if (msg.role === "assistant" && Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === "tool_use") {
						if (block.name === "write" || block.name === "edit") {
							const filePath = block.input?.path;
							if (typeof filePath === "string") {
								editedFiles.add(resolve(ctx.cwd, filePath));
							}
						}
					}
				}
			}
		}

		if (editedFiles.size === 0) return;

		// Group files by git repo root
		const repoFiles = new Map<string, string[]>();

		for (const file of editedFiles) {
			const { stdout, code } = await pi.exec("git", ["-C", dirname(file), "rev-parse", "--show-toplevel"], {
				timeout: 5000,
			});
			if (code !== 0) continue;

			const root = stdout.trim();
			if (!repoFiles.has(root)) repoFiles.set(root, []);
			repoFiles.get(root)!.push(file);
		}

		if (repoFiles.size === 0) return;

		for (const [repoRoot, files] of repoFiles) {
			// Stage only the files we touched
			for (const file of files) {
				await pi.exec("git", ["-C", repoRoot, "add", file], { timeout: 5000 });
			}

			// Check if there's anything staged
			const { stdout: diff } = await pi.exec("git", ["-C", repoRoot, "diff", "--cached", "--stat"], {
				timeout: 5000,
			});
			if (!diff.trim()) continue;

			// Build commit message from last assistant text
			const commitMessage = buildCommitMessage(event.messages);

			// Check if we have a previous auto-commit for this repo
			const prev = lastAutoCommit.get(repoRoot);
			let amend = false;

			if (prev && ctx.hasUI) {
				// Verify the previous auto-commit is still HEAD
				const { stdout: headSha } = await pi.exec("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
					timeout: 5000,
				});
				if (headSha.trim() === prev.sha) {
					const choice = await ctx.ui.select("Previous auto-commit exists for this repo", [
						"Amend — fold into previous commit (fix)",
						"New commit — keep previous, add another (build on it)",
					]);
					amend = choice?.startsWith("Amend") ?? false;
				}
			}

			let commitArgs: string[];
			if (amend) {
				commitArgs = ["-C", repoRoot, "commit", "--amend", "-m", commitMessage];
			} else {
				commitArgs = ["-C", repoRoot, "commit", "-m", commitMessage];
			}

			const { code, stdout: commitOut } = await pi.exec("git", commitArgs, { timeout: 10000 });

			if (code === 0) {
				// Record this auto-commit
				const { stdout: newSha } = await pi.exec("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
					timeout: 5000,
				});
				lastAutoCommit.set(repoRoot, { sha: newSha.trim(), message: commitMessage });

				if (ctx.hasUI) {
					const fileCount = files.length;
					const verb = amend ? "Amended" : "Auto-committed";
					ctx.ui.notify(
						`${verb} ${fileCount} file${fileCount > 1 ? "s" : ""} in ${repoRoot}: ${commitMessage}`,
						"info",
					);
				}
			}
		}
	});

	// /scrap command: undo last auto-commit, stash changes
	pi.registerCommand("scrap", {
		description: "Undo the last auto-commit: reset the commit and stash changes",
		handler: async (args, ctx) => {
			if (lastAutoCommit.size === 0) {
				ctx.ui.notify("No auto-commits to scrap", "warning");
				return;
			}

			// If multiple repos, let user pick; otherwise use the only one
			let repoRoot: string;
			if (lastAutoCommit.size === 1) {
				repoRoot = lastAutoCommit.keys().next().value!;
			} else {
				const choice = await ctx.ui.select(
					"Which repo to scrap?",
					[...lastAutoCommit.entries()].map(([root, { message }]) => `${root} — ${message}`),
				);
				if (!choice) return;
				repoRoot = choice.split(" — ")[0];
			}

			const prev = lastAutoCommit.get(repoRoot);
			if (!prev) return;

			// Verify it's still HEAD
			const { stdout: headSha } = await pi.exec("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
				timeout: 5000,
			});
			if (headSha.trim() !== prev.sha) {
				ctx.ui.notify("HEAD has moved since the auto-commit — can't scrap safely", "error");
				return;
			}

			// Reset the commit, keep changes in working tree
			await pi.exec("git", ["-C", repoRoot, "reset", "--soft", "HEAD~1"], { timeout: 5000 });

			// Stash the changes
			const stashMsg = `pi: scrapped auto-commit — ${prev.message}`;
			await pi.exec("git", ["-C", repoRoot, "stash", "push", "-m", stashMsg], { timeout: 5000 });

			lastAutoCommit.delete(repoRoot);
			ctx.ui.notify(`Scrapped and stashed: ${stashMsg}`, "info");
		},
	});

	// Clear tracking on new session
	pi.on("session_start", async () => {
		lastAutoCommit.clear();
	});
}

function buildCommitMessage(messages: Array<{ role: string; content: unknown }>): string {
	let summary = "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (
					typeof block === "object" &&
					block !== null &&
					"type" in block &&
					block.type === "text" &&
					"text" in block &&
					typeof block.text === "string" &&
					block.text.trim()
				) {
					summary = block.text.trim().split("\n")[0];
					break;
				}
			}
			if (summary) break;
		}
	}

	if (!summary || summary.length > 72) {
		summary = summary ? summary.slice(0, 69) + "..." : "Update files";
	}
	return `AI: ${summary}`;
}

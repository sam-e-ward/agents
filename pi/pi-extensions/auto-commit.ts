/**
 * Auto-Commit Extension
 *
 * After every agent response, checks if any files were written/edited,
 * finds which git repos they belong to, and auto-commits with an "AI:" prefix.
 *
 * Uses a lightweight LLM call (via `pi -p`) to generate a proper commit message
 * from the staged diff.
 *
 * When the same repo is touched in consecutive agent responses, asks the user
 * whether to amend the previous commit (fix) or create a new one (build on it).
 *
 * Provides /scrap command to undo the last auto-commit and stash changes.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolve, dirname } from "node:path";

const COMMIT_MSG_PROMPT = `You are a commit message generator. Given a git diff, write a single-line commit message.

Rules:
- Output ONLY the commit message, nothing else
- Max 60 characters
- Use imperative mood ("Add feature" not "Added feature")
- Be specific about what changed, not why
- No quotes, no period at the end
- No conventional commit prefixes (no feat:, fix:, etc.)
- If multiple things changed, summarize the overall intent`;

export default function (pi: ExtensionAPI) {
	// Track last auto-commit per repo: repoRoot -> { sha, message }
	const lastAutoCommit = new Map<string, { sha: string; message: string }>();

	pi.on("agent_end", async (event, ctx) => {
		// Collect file paths from write/edit tool calls in this agent run
		const editedFiles = new Set<string>();

		for (const msg of event.messages) {
			if (msg.role === "assistant" && Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === "tool_use" || block.type === "toolCall") {
						if (block.name === "write" || block.name === "edit") {
							const filePath = block.input?.path ?? block.arguments?.path;
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

			// Generate commit message from the diff using an LLM
			const currentModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
			const commitMessage = await generateCommitMessage(pi, repoRoot, currentModel);

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

async function generateCommitMessage(
	pi: ExtensionAPI,
	repoRoot: string,
	currentModel: { provider: string; id: string } | undefined,
): Promise<string> {
	// Get the staged diff (truncated to avoid overwhelming the model)
	const { stdout: fullDiff } = await pi.exec("git", ["-C", repoRoot, "diff", "--cached"], {
		timeout: 5000,
	});

	// Truncate diff to ~4KB to keep token usage minimal
	const maxDiffLen = 4096;
	let diff = fullDiff;
	if (diff.length > maxDiffLen) {
		diff = diff.slice(0, maxDiffLen) + "\n... (diff truncated)";
	}

	// Also get the stat summary for context
	const { stdout: stat } = await pi.exec("git", ["-C", repoRoot, "diff", "--cached", "--stat"], {
		timeout: 5000,
	});

	const prompt = `${stat.trim()}\n\n${diff}`;

	// Build args for pi in print mode
	const args = [
		"-p",
		"--no-tools",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--system-prompt", COMMIT_MSG_PROMPT,
	];

	// Use the current session's model so we don't assume any provider is configured
	if (currentModel) {
		args.push("--model", `${currentModel.provider}/${currentModel.id}`);
	}

	args.push(prompt);

	try {
		const { stdout, code } = await pi.exec("pi", args, { timeout: 15000 });

		if (code === 0 && stdout.trim()) {
			let msg = stdout.trim();
			// Strip any quotes the model might have added
			msg = msg.replace(/^["']|["']$/g, "");
			// Take first line only, just in case
			msg = msg.split("\n")[0].trim();
			// Enforce length limit
			if (msg.length > 60) {
				msg = msg.slice(0, 57) + "...";
			}
			if (msg) {
				return `AI: ${msg}`;
			}
		}
	} catch {
		// Fall through to fallback
	}

	// Fallback: use file names from the stat
	return buildFallbackMessage(stat);
}

function buildFallbackMessage(stat: string): string {
	// Extract file names from stat output
	const files = stat
		.split("\n")
		.map((line) => line.trim().split("|")[0]?.trim())
		.filter((f) => f && !f.includes("changed") && !f.includes("insertion") && !f.includes("deletion"));

	if (files.length === 0) return "AI: Update files";

	const fileNames = files.map((f) => f.split("/").pop()!);
	let msg = `AI: Update ${fileNames.join(", ")}`;
	if (msg.length > 72) {
		msg = msg.slice(0, 69) + "...";
	}
	return msg;
}

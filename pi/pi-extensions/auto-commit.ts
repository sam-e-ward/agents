/**
 * Auto-Commit Extension
 *
 * After every agent response, checks for uncommitted changes in the cwd's
 * git repo and auto-commits them with an "AI:" prefix.
 *
 * Uses a lightweight LLM call (via `pi -p`) to generate a proper commit message
 * from the staged diff.
 *
 * When the same repo is touched in consecutive agent responses, asks the user
 * whether to amend the previous commit (fix) or create a new one (build on it).
 *
 * Provides /scrap command to undo the last auto-commit and stash changes.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const LIGHT_MODEL_CANDIDATES = [
	["anthropic", "claude-haiku-4-5"],
	["openai-codex", "gpt-5.4-mini"],
	["openai-codex", "gpt-5.3-codex-spark"],
	["anthropic", "claude-3-5-haiku-latest"],
] as const;

const COMMIT_MSG_PROMPT = `You are a commit message generator. Given a git diff, write a single-line commit message.

Rules:
- Output ONLY the commit message, nothing else
- Max 60 characters
- Use imperative mood ("Add feature" not "Added feature")
- Be specific about what changed, not why
- No quotes, no period at the end
- No conventional commit prefixes (no feat:, fix:, etc.)
- If multiple things changed, summarize the overall intent`;

const CLASSIFY_PROMPT = `You decide whether newly staged code changes should AMEND the previous commit or become a NEW commit.

You'll receive:
- The previous commit message
- The diff of the previous commit
- The currently staged changes
- The combined diff (previous commit + staged changes together)

Answer TWO questions. For each, reply with exactly Y, N, or UNSURE.

Q1: Do the staged changes touch only the same files / functions / components as the previous commit? (i.e. they refine or continue the same work rather than adding something separate)
Q2: Does the previous commit message still accurately describe the combined changes?

Output format — exactly two lines, nothing else:
Q1: <Y|N|UNSURE>
Q2: <Y|N|UNSURE>`;

export default function (pi: ExtensionAPI) {
	// Track last auto-commit per repo: repoRoot -> { sha, message }
	const lastAutoCommit = new Map<string, { sha: string; message: string }>();
	let autoCommitEnabled = true;

	pi.on("agent_end", async (_event, ctx) => {
		if (!autoCommitEnabled) return;

		// Find the git repo root for the cwd
		const { stdout: repoRootRaw, code: repoCode } = await pi.exec(
			"git", ["-C", ctx.cwd, "rev-parse", "--show-toplevel"],
			{ timeout: 5000 },
		);
		if (repoCode !== 0) return; // not a git repo

		const repoRoot = repoRootRaw.trim();

		// Check for any uncommitted changes (untracked, modified, staged)
		const { stdout: status } = await pi.exec(
			"git", ["-C", repoRoot, "status", "--porcelain"],
			{ timeout: 5000 },
		);
		if (!status.trim()) return; // nothing to commit

		// Stage everything
		await pi.exec("git", ["-C", repoRoot, "add", "-A"], { timeout: 5000 });

		// Verify there's actually something staged (in case .gitignore filtered it all)
		const { stdout: stagedStat } = await pi.exec(
			"git", ["-C", repoRoot, "diff", "--cached", "--stat"],
			{ timeout: 5000 },
		);
		if (!stagedStat.trim()) return;

		// Count files for the notification
		const fileCount = stagedStat.split("\n").filter((l) => l.includes("|")).length;

		const lightModel = await findLightModel(ctx);

		// Check if we have a previous auto-commit for this repo that is still HEAD
		const prev = lastAutoCommit.get(repoRoot);
		let amend = false;

		if (prev) {
			const { stdout: headSha } = await pi.exec(
				"git", ["-C", repoRoot, "rev-parse", "HEAD"],
				{ timeout: 5000 },
			);
			if (headSha.trim() === prev.sha) {
				amend = await decideAmend(pi, repoRoot, prev.message, lightModel, ctx);
			}
		}

		// Generate the commit message. When amending, base it on the COMBINED diff
		// (previous commit + staged changes) so the message reflects the whole change,
		// not just the latest tweak.
		const diffArgs = amend
			? ["diff", "--cached", "HEAD~1"]
			: ["diff", "--cached"];
		const commitMessage = await generateCommitMessage(pi, repoRoot, diffArgs, lightModel);

		const commitArgs = ["-C", repoRoot, "commit"];
		if (amend) commitArgs.push("--amend");
		commitArgs.push("-m", commitMessage);

		const { code } = await pi.exec("git", commitArgs, { timeout: 10000 });

		if (code === 0) {
			// Record this auto-commit
			const { stdout: newSha } = await pi.exec(
				"git", ["-C", repoRoot, "rev-parse", "HEAD"],
				{ timeout: 5000 },
			);
			lastAutoCommit.set(repoRoot, { sha: newSha.trim(), message: commitMessage });

			if (ctx.hasUI) {
				const verb = amend ? "Amended" : "Auto-committed";
				ctx.ui.notify(
					`${verb} ${fileCount} file${fileCount > 1 ? "s" : ""} in ${repoRoot}: ${commitMessage}`,
					"info",
				);
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

	// /autocommit command: toggle auto-commit for this session
	pi.registerCommand("autocommit", {
		description: "Toggle auto-commit on/off for this session",
		handler: async (_args, ctx) => {
			autoCommitEnabled = !autoCommitEnabled;
			ctx.ui.notify(
				`Auto-commit ${autoCommitEnabled ? "enabled" : "disabled"} for this session`,
				"info",
			);
		},
	});

	// Clear tracking on new session
	pi.on("session_start", async () => {
		lastAutoCommit.clear();
		autoCommitEnabled = true;
	});
}

async function findLightModel(
	ctx: ExtensionContext,
): Promise<{ provider: string; id: string } | undefined> {
	for (const [provider, id] of LIGHT_MODEL_CANDIDATES) {
		const model = ctx.modelRegistry.find(provider, id);
		if (!model) continue;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok) return { provider, id };
	}
	// Fall back to session model if no light model available
	return ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
}

type YNU = "Y" | "N" | "UNSURE";

/**
 * Decide whether to amend the previous auto-commit or create a new one.
 *
 * Asks a lightweight LLM two questions about the change (given the previous
 * commit, the staged changes, and the combined diff):
 *   Q1: do the staged changes touch only the same files/functions as before?
 *   Q2: does the previous commit message still describe the combined changes?
 *
 * - Both Y  -> amend
 * - Both N  -> new commit
 * - Anything else -> prompt the user, defaulting to amend when there's a Y and
 *   no N, otherwise defaulting to new.
 */
async function decideAmend(
	pi: ExtensionAPI,
	repoRoot: string,
	prevCommitMessage: string,
	currentModel: { provider: string; id: string } | undefined,
	ctx: ExtensionContext,
): Promise<boolean> {
	const { q1, q2 } = await classifyAmendQuestions(pi, repoRoot, prevCommitMessage, currentModel);

	if (q1 === "Y" && q2 === "Y") return true;
	if (q1 === "N" && q2 === "N") return false;

	// Ambiguous — pick a sensible default, then confirm with the user if we can.
	const hasN = q1 === "N" || q2 === "N";
	const hasY = q1 === "Y" || q2 === "Y";
	const defaultAmend = hasY && !hasN;

	if (!ctx.hasUI) return defaultAmend;

	const amendOption = "Amend — fold into previous commit (fix)";
	const newOption = "New commit — keep previous, add another (build on it)";
	const options = defaultAmend ? [amendOption, newOption] : [newOption, amendOption];

	const choice = await ctx.ui.select(
		`Previous auto-commit exists. Same scope? ${q1}. Message still fits? ${q2}.`,
		options,
	);
	return choice?.startsWith("Amend") ?? defaultAmend;
}

async function classifyAmendQuestions(
	pi: ExtensionAPI,
	repoRoot: string,
	prevCommitMessage: string,
	currentModel: { provider: string; id: string } | undefined,
): Promise<{ q1: YNU; q2: YNU }> {
	const prevDiff = await gitDiff(pi, repoRoot, ["diff", "HEAD~1", "HEAD"]);
	const stagedDiff = await gitDiff(pi, repoRoot, ["diff", "--cached"]);
	const combinedDiff = await gitDiff(pi, repoRoot, ["diff", "--cached", "HEAD~1"]);

	const prompt = [
		`Previous commit message: ${prevCommitMessage}`,
		"",
		"=== Previous commit diff ===",
		prevDiff,
		"",
		"=== Staged changes ===",
		stagedDiff,
		"",
		"=== Combined diff (previous commit + staged) ===",
		combinedDiff,
	].join("\n");

	const args = [
		"-p",
		"--no-tools",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--system-prompt", CLASSIFY_PROMPT,
	];

	if (currentModel) {
		args.push("--model", `${currentModel.provider}/${currentModel.id}`);
	}

	args.push(prompt);

	try {
		const { stdout, code } = await pi.exec("pi", args, { timeout: 15000 });
		if (code === 0) {
			return {
				q1: parseAnswer(stdout, "Q1"),
				q2: parseAnswer(stdout, "Q2"),
			};
		}
	} catch {
		// Fall through
	}

	return { q1: "UNSURE", q2: "UNSURE" };
}

function parseAnswer(output: string, label: string): YNU {
	const line = output
		.split("\n")
		.find((l) => l.trim().toUpperCase().startsWith(`${label}:`));
	const value = line?.split(":")[1]?.trim().toUpperCase() ?? "";
	if (value.startsWith("Y")) return "Y";
	if (value.startsWith("N")) return "N";
	return "UNSURE";
}

async function gitDiff(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string> {
	const { stdout } = await pi.exec("git", ["-C", repoRoot, ...args], { timeout: 5000 });
	const maxLen = 4096;
	const diff = stdout.trim();
	return diff.length > maxLen ? `${diff.slice(0, maxLen)}\n... (diff truncated)` : diff;
}

async function generateCommitMessage(
	pi: ExtensionAPI,
	repoRoot: string,
	diffArgs: string[],
	currentModel: { provider: string; id: string } | undefined,
): Promise<string> {
	// Get the diff (truncated to avoid overwhelming the model)
	const diff = await gitDiff(pi, repoRoot, diffArgs);

	// Also get the stat summary for context
	const { stdout: stat } = await pi.exec("git", ["-C", repoRoot, ...diffArgs, "--stat"], {
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

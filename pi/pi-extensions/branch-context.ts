import { complete, getModel } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const MAX_DIFF_BYTES = 40000; // keep diff under context limits

interface ContextInfo {
	currentBranch: string;
	parentBranch: string | null;
	base: string | null;
	commitCount: number;
	diff: string;
	hasUncommitted: boolean;
	isTrunk: boolean;
}

export default function (pi: ExtensionAPI) {
	let contextInfo: ContextInfo | null = null;
	let summary: string | null = null;
	let injected = false;

	async function git(...args: string[]): Promise<{ stdout: string; code: number }> {
		const result = await pi.exec("git", args, { timeout: 10000 });
		return { stdout: result.stdout.trim(), code: result.code ?? 1 };
	}

	/** Get a combined diff of all uncommitted changes: staged, unstaged, and untracked files. */
	async function getUncommittedDiff(): Promise<string> {
		const parts: string[] = [];

		// Staged + unstaged changes to tracked files
		const { stdout: trackedDiff } = await git("diff", "HEAD");
		if (trackedDiff) parts.push(trackedDiff);

		// Untracked files — show their full content as a pseudo-diff
		const { stdout: untrackedList } = await git("ls-files", "--others", "--exclude-standard");
		if (untrackedList) {
			for (const file of untrackedList.split("\n")) {
				const f = file.trim();
				if (!f) continue;
				// Read file content; skip binary files
				const result = await pi.exec("file", ["--brief", "--mime-encoding", f], { timeout: 5000 });
				const encoding = result.stdout.trim();
				if (encoding === "binary") {
					parts.push(`diff --git a/${f} b/${f}\nnew file (binary)`);
					continue;
				}
				const cat = await pi.exec("cat", [f], { timeout: 5000 });
				const content = cat.stdout;
				if (!content) continue;
				const lines = content.split("\n");
				const patch = lines.map((l) => `+${l}`).join("\n");
				parts.push(`diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,${lines.length} @@\n${patch}`);
			}
		}

		return parts.join("\n");
	}

	async function computeContextInfo(): Promise<ContextInfo | null> {
		const { code } = await git("rev-parse", "--is-inside-work-tree");
		if (code !== 0) return null;

		const { stdout: currentBranch, code: branchCode } = await git("rev-parse", "--abbrev-ref", "HEAD");
		if (branchCode !== 0 || !currentBranch || currentBranch === "HEAD") return null;

		const isTrunk = currentBranch === "main" || currentBranch === "master";

		const uncommittedDiff = await getUncommittedDiff();

		// Find the parent branch — check common trunks first, then all local branches
		const candidates = ["main", "master", "develop", "dev"];
		const { stdout: allBranches } = await git("branch", "--format=%(refname:short)");
		if (allBranches) {
			for (const b of allBranches.split("\n")) {
				const name = b.trim();
				if (name && name !== currentBranch && !candidates.includes(name)) {
					candidates.push(name);
				}
			}
		}

		let bestBase: string | null = null;
		let bestCount = Infinity;
		let parentBranch: string | null = null;

		for (const candidate of candidates) {
			if (candidate === currentBranch) continue;
			const { stdout: mergeBase, code: mbCode } = await git("merge-base", currentBranch, candidate);
			if (mbCode !== 0 || !mergeBase) continue;

			const { stdout: countStr } = await git("rev-list", "--count", `${mergeBase}..HEAD`);
			const count = parseInt(countStr, 10);
			if (!isNaN(count) && count < bestCount) {
				bestCount = count;
				bestBase = mergeBase;
				parentBranch = candidate;
			}
		}

		// On a feature branch: diff from branch point (includes uncommitted tracked changes)
		//   plus any untracked files
		// On trunk: only uncommitted changes matter
		let diff = "";
		let commitCount = 0;

		if (bestBase && !isTrunk) {
			// Feature branch — committed diff from branch point + untracked files
			const { stdout: branchDiff } = await git("diff", bestBase);
			const untrackedPart = await getUntrackedDiff();
			diff = [branchDiff, untrackedPart].filter(Boolean).join("\n");
			commitCount = bestCount;
		} else {
			// Trunk or no parent — use uncommitted changes only (including untracked)
			diff = uncommittedDiff;
			commitCount = 0;
		}

		if (!diff) return null;

		return {
			currentBranch,
			parentBranch,
			base: bestBase,
			commitCount,
			diff: diff.length > MAX_DIFF_BYTES ? diff.slice(0, MAX_DIFF_BYTES) + "\n\n[diff truncated]" : diff,
			hasUncommitted: !!uncommittedDiff,
			isTrunk,
		};
	}

	/** Get just the untracked file pseudo-diffs (used for feature branch mode). */
	async function getUntrackedDiff(): Promise<string> {
		const parts: string[] = [];
		const { stdout: untrackedList } = await git("ls-files", "--others", "--exclude-standard");
		if (!untrackedList) return "";

		for (const file of untrackedList.split("\n")) {
			const f = file.trim();
			if (!f) continue;
			const result = await pi.exec("file", ["--brief", "--mime-encoding", f], { timeout: 5000 });
			const encoding = result.stdout.trim();
			if (encoding === "binary") {
				parts.push(`diff --git a/${f} b/${f}\nnew file (binary)`);
				continue;
			}
			const cat = await pi.exec("cat", [f], { timeout: 5000 });
			const content = cat.stdout;
			if (!content) continue;
			const lines = content.split("\n");
			const patch = lines.map((l) => `+${l}`).join("\n");
			parts.push(`diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,${lines.length} @@\n${patch}`);
		}

		return parts.join("\n");
	}

	async function summariseDiff(info: ContextInfo, ctx: ExtensionContext): Promise<string | null> {
		const modelCandidates = [
			["anthropic", "claude-sonnet-4-20250514"],
			["openai", "gpt-4.1-mini"],
			["anthropic", "claude-haiku-4-20250414"],
			["google", "gemini-2.5-flash"],
		];

		let prompt: string;
		if (info.isTrunk) {
			prompt = [
				`This is a git diff of uncommitted changes on \`${info.currentBranch}\`.`,
				"Write ONE short sentence (under 120 chars) summarising what these uncommitted changes do. Be specific about what's being built/changed, not vague. No preamble.",
				"",
				"<diff>",
				info.diff,
				"</diff>",
			].join("\n");
		} else {
			prompt = [
				`This is a git diff for branch \`${info.currentBranch}\` (branched from \`${info.parentBranch}\`, ${info.commitCount} commits ahead${info.hasUncommitted ? " + uncommitted changes" : ""}).`,
				"Write ONE short sentence (under 120 chars) summarising what this branch is doing. Be specific about what's being built/changed, not vague. No preamble.",
				"",
				"<diff>",
				info.diff,
				"</diff>",
			].join("\n");
		}

		for (const [provider, id] of modelCandidates) {
			const model = getModel(provider, id);
			if (!model) continue;
			const apiKey = await ctx.modelRegistry.getApiKey(model);
			if (!apiKey) continue;

			const response = await complete(
				model,
				{
					messages: [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: prompt }],
							timestamp: Date.now(),
						},
					],
				},
				{ apiKey, reasoningEffort: "low" },
			);

			const text = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("")
				.trim();

			return text || null;
		}

		return null;
	}

	pi.on("session_start", async (_event, ctx) => {
		contextInfo = null;
		summary = null;
		injected = false;

		try {
			contextInfo = await computeContextInfo();
			if (!contextInfo) return;

			const label = contextInfo.isTrunk
				? `📍 ${contextInfo.currentBranch} (uncommitted) — summarising changes...`
				: `📍 ${contextInfo.currentBranch} — summarising changes...`;
			ctx.ui.setWidget("branch-context", [label]);

			summary = await summariseDiff(contextInfo, ctx);

			if (summary) {
				ctx.ui.setWidget("branch-context", [`📍 ${contextInfo.currentBranch} — ${summary}`]);
			} else {
				const detail = contextInfo.isTrunk
					? "uncommitted changes"
					: `${contextInfo.commitCount} commits from ${contextInfo.parentBranch}`;
				ctx.ui.setWidget("branch-context", [`📍 ${contextInfo.currentBranch} (${detail})`]);
			}
		} catch {
			// Silently ignore
		}
	});

	pi.on("before_agent_start", async (_event, _ctx) => {
		if (injected || !contextInfo) return;
		injected = true;

		// Clear the widget so it only shows before the first prompt
		_ctx.ui.setWidget("branch-context", []);

		const parts: string[] = [];
		if (contextInfo.isTrunk) {
			parts.push(`On \`${contextInfo.currentBranch}\` with uncommitted changes.`);
		} else {
			parts.push(`Branch \`${contextInfo.currentBranch}\` (from \`${contextInfo.parentBranch}\`, ${contextInfo.commitCount} commits ahead${contextInfo.hasUncommitted ? " + uncommitted changes" : ""}).`);
		}
		if (summary) parts.push(`Summary: ${summary}`);
		parts.push("");
		parts.push(contextInfo.isTrunk ? "Uncommitted diff:" : "Diff from branch point to current working state:");
		parts.push(contextInfo.diff);

		return {
			message: {
				customType: "branch-context",
				content: [
					`Here's what's been done${contextInfo.isTrunk ? " (uncommitted)" : " on this branch"} so far:\n\n${parts.join("\n")}`,
					"\nUse this as background context for where the work stands. Don't comment on it unless asked.",
				].join(""),
				display: false,
			},
		};
	});
}

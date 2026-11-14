import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CloudClient, canonicalSessionFile, isWithin } from "./client/index.ts";
import type { Binding, ResumePlan, SyncResult } from "./client/index.ts";
import { CONTINUATION_TYPE, continuationContext } from "./resume.ts";

function summary(result: SyncResult): string {
	return `${result.uploaded} uploaded, ${result.downloaded} downloaded, ${result.deleted} deleted`;
}

export default function cloudExtension(pi: ExtensionAPI) {
	const client = new CloudClient();
	let active = false;
	let allowAutoSync = true;
	let pending: Promise<void> | undefined;
	let queued: ExtensionContext | undefined;

	function status(ctx: ExtensionContext, message: string): void {
		if (active && ctx.hasUI) ctx.ui.setStatus("pi-cloud", `cloud: ${message}`);
	}

	async function currentBinding(ctx: ExtensionContext): Promise<Binding | undefined> {
		const file = ctx.sessionManager.getSessionFile();
		if (!file) return undefined;
		let canonical: string;
		try { canonical = await canonicalSessionFile(file); }
		catch { return undefined; } // Empty sessions are not on disk yet.
		return (await client.bindings()).find((binding) => binding.sessionFile === canonical && binding.enabled);
	}

	async function checkpoint(ctx: ExtensionContext): Promise<boolean> {
		const binding = await currentBinding(ctx);
		if (!binding) return false;
		await client.track(binding.sessionFile, binding.projectId, ctx.sessionManager.getLeafId());
		return true;
	}

	function autoSync(ctx: ExtensionContext): void {
		if (!active || !allowAutoSync) return;
		if (pending) { queued = ctx; return; }
		pending = (async () => {
			if (!await checkpoint(ctx)) return;
			status(ctx, "syncing");
			const result = await client.sync();
			status(ctx, result.errors.length ? "pending — /cloud sync to retry" : "synced");
		})().catch(() => status(ctx, "pending — /cloud sync to retry")).finally(() => {
			pending = undefined;
			const next = queued;
			queued = undefined;
			if (next) autoSync(next);
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		active = true;
		const expectedSession = process.env.PI_CLOUD_RESUME_SESSION_ID;
		const revision = process.env.PI_CLOUD_RESUME_REVISION;
		if (expectedSession === ctx.sessionManager.getSessionId() && revision) {
			const file = ctx.sessionManager.getSessionFile();
			if (file) {
				try {
					await client.recordResume(file, revision);
					// Consume the CLI handoff once; reloads must not reset advanced ancestry.
					delete process.env.PI_CLOUD_RESUME_SESSION_ID;
					delete process.env.PI_CLOUD_RESUME_REVISION;
				} catch (error) {
					if (ctx.hasUI) ctx.ui.notify(`Cloud continuation is local only: ${error instanceof Error ? error.message : error}`, "error");
				}
			}
		}
		try { status(ctx, await currentBinding(ctx) ? "enabled" : "off"); }
		catch { status(ctx, "unavailable — /cloud status"); }
	});
	pi.on("agent_settled", (_event, ctx) => autoSync(ctx));
	pi.on("session_tree", (_event, ctx) => autoSync(ctx));
	pi.on("session_info_changed", (_event, ctx) => autoSync(ctx));
	pi.on("session_compact", (_event, ctx) => autoSync(ctx));
	pi.on("session_shutdown", () => { active = false; queued = undefined; });

	async function choosePlan(ctx: ExtensionCommandContext, id?: string): Promise<ResumePlan | undefined> {
		let revisionId = id;
		if (!revisionId) {
			const conversations = await client.conversations();
			const options = conversations.map((conversation) => `${conversation.project.name}: ${conversation.title} [${conversation.heads.length} continuation(s)] — ${conversation.id}`);
			const selected = await ctx.ui.select("Cached cloud conversations (/cloud sync refreshes)", options);
			if (!selected) return;
			const conversation = conversations[options.indexOf(selected)];
			if (conversation.heads.length === 1) revisionId = conversation.heads[0];
			else revisionId = await ctx.ui.select("Choose a continuation (no histories are merged)", conversation.heads);
			if (!revisionId) return;
		}
		const revision = await client.getRevision(revisionId);
		const mappings = (await client.projects()).filter((project) => project.id === revision.project.id);
		if (!mappings.length) throw new Error(`Map this project first: pi-cloud project add ${JSON.stringify(revision.project.name)} <local-root> --id ${revision.project.id}`);
		const root = mappings.length === 1 ? mappings[0].root : await ctx.ui.select("Choose a local workspace", mappings.map((mapping) => mapping.root));
		if (!root) return;
		return client.prepareResume(revisionId, root);
	}

	async function resume(ctx: ExtensionCommandContext, id?: string): Promise<void> {
		await ctx.waitForIdle();
		if (pending) await pending;
		const plan = await choosePlan(ctx, id);
		if (!plan) return;
		const confirmed = await ctx.ui.confirm("Continue cloud conversation here?", [
			`Target: ${plan.targetCwd}`,
			...plan.warnings,
			"History only: files and Git state have not been synced. A new local session will be created.",
		].join("\n"));
		if (!confirmed) return;
		const forked = SessionManager.forkFrom(plan.snapshotPath, plan.targetCwd);
		if (plan.revision.leafId === null) forked.resetLeaf();
		else forked.branch(plan.revision.leafId);
		forked.appendCustomMessageEntry(CONTINUATION_TYPE, continuationContext(plan), true, { revisionId: plan.revision.id });
		const file = forked.getSessionFile();
		if (!file) throw new Error("Pi did not create a persistent local session");
		const result = await ctx.switchSession(file, {
			withSession: async (replacement) => {
				await client.recordResume(file, plan.revision.id);
				replacement.ui.setStatus("pi-cloud", "cloud: enabled");
				replacement.ui.notify(`Cloud conversation continued in ${plan.targetCwd}`, "info");
			},
		});
		if (result.cancelled) ctx.ui.notify(`Switch cancelled; unused local fork retained at ${file}`, "warning");
	}

	pi.registerCommand("cloud", {
		description: "Opt-in conversation sync: status, track, off, sync, sessions, resume <revision>",
		getArgumentCompletions: (prefix) => ["status", "track", "off", "sync", "sessions", "resume"]
			.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			if (!ctx.hasUI) throw new Error("Use the standalone pi-cloud CLI in non-interactive mode");
			const [command = "status", argument, ...extra] = args.trim().split(/\s+/).filter(Boolean);
			try {
				if (extra.length || argument && command !== "resume") throw new Error("Usage: /cloud status|track|off|sync|sessions|resume [revision]");
				if (command === "resume" || command === "sessions") { await resume(ctx, argument); return; }
				if (command === "status") {
					const state = await client.status();
					const binding = await currentBinding(ctx);
					ctx.ui.notify([
						`Server: ${state.serverUrl ?? "not configured (use pi-cloud login)"}`,
						`Logged in: ${state.authenticated}; this session: ${binding ? "sync enabled" : "local only"}`,
						`Projects: ${state.projects}; tracked sessions: ${state.trackedSessions}`,
					].join("\n"), "info");
				} else if (command === "track") {
					await ctx.waitForIdle();
					const file = ctx.sessionManager.getSessionFile();
					if (!file) throw new Error("Send a message first so pi saves this session");
					const mappings = (await client.projects()).filter((project) => isWithin(project.root, ctx.cwd));
					if (mappings.length !== 1) throw new Error("Register this workspace first with pi-cloud project add <name> <root>");
					if (!await ctx.ui.confirm("Enable conversation sync?", "The complete history, including file contents, tool output and possible secrets, will be sent to your cloud server.")) return;
					await client.track(file, mappings[0].id, ctx.sessionManager.getLeafId());
					allowAutoSync = true;
					status(ctx, "enabled");
					ctx.ui.notify("Sync enabled. /cloud sync sends now; later settled runs sync automatically.", "info");
				} else if (command === "off") {
					allowAutoSync = false;
					queued = undefined;
					if (pending) await pending;
					const file = ctx.sessionManager.getSessionFile();
					if (file) await client.untrack(file);
					status(ctx, "off");
					ctx.ui.notify("Sync disabled for this session. Existing cloud history was not deleted.", "info");
				} else if (command === "sync") {
					await ctx.waitForIdle();
					if (pending) await pending;
					await checkpoint(ctx);
					status(ctx, "syncing");
					const result = await client.sync();
					status(ctx, result.errors.length ? "pending" : "synced");
					ctx.ui.notify([summary(result), ...result.errors.map((error) => `${error.phase}: ${error.message}`)].join("\n"), result.errors.length ? "warning" : "info");
				} else throw new Error("Usage: /cloud status|track|off|sync|sessions|resume [revision]");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

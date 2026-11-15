import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	UNFILED_PROJECT, object, parseDraft, parseRevision, parseSnapshot, revisionId, revisionKey, text, uuid,
} from "../protocol.ts";
import type { Change, ChangePage, ConversationSummary, Revision, SessionSnapshot } from "../protocol.ts";
import {
	assertAvailable, cacheRevision, catalogue, isMissing, purgeDeletedCache, readCachedRevision, snapshotPath,
} from "./cache.ts";
import { atomicWrite, canonicalSessionFile, privateDirectory, readPrivate, stableSnapshot, withProfileLock } from "./filesystem.ts";
import { CloudHttpError, request, validateServerUrl } from "./http.ts";
import { emptyState, parseState } from "./state.ts";
import type { Binding, CloudStatus, DeviceInfo, ProfileState, ProjectMapping, ResumePlan, StoredBinding, SyncResult, WorkspaceMode } from "./types.ts";
import { canonicalDirectory, isWithin, readGitState, resolveProjectCwd, resolveRevisionCwd, resumeWarnings } from "./workspace.ts";

export type { Binding, CloudStatus, DeviceInfo, ProjectMapping, ResumePlan, SyncIssue, SyncResult, WorkspaceMode } from "./types.ts";
export type { Change, ChangePage, ConversationSummary, GitState, Project, Revision, RevisionDraft, SessionSnapshot } from "../protocol.ts";
export { atomicWrite, canonicalSessionFile, privateDirectory, readPrivate, stableSnapshot, withProfileLock } from "./filesystem.ts";
export { canonicalDirectory, isWithin, readGitState, resolveProjectCwd, resolveRevisionCwd, resumeWarnings } from "./workspace.ts";
export { CloudHttpError, validateServerUrl } from "./http.ts";

function publicBinding(binding: StoredBinding): Binding {
	const { sessionFile, conversationId, projectId, workspaceMode, headRevisionId, enabled, leafId } = binding;
	return { sessionFile, conversationId, projectId, workspaceMode, headRevisionId, enabled, ...(leafId === undefined ? {} : { leafId }) };
}

function activeLeaf(session: SessionSnapshot, requested?: string | null): string | null {
	const leaf = requested === undefined ? (session.entries.at(-1)?.id as string | undefined) ?? null : requested;
	if (leaf !== null && !session.entries.some((entry) => entry.id === leaf)) throw new Error("Active leaf is not in the session");
	return leaf;
}

function fingerprint(snapshot: string, leaf: string | null): string {
	return createHash("sha256").update(snapshot).update("\0").update(JSON.stringify(leaf)).digest("hex");
}

function sessionTitle(session: SessionSnapshot): string {
	for (const entry of session.entries.toReversed()) {
		if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) return entry.name.trim().slice(0, 512);
	}
	for (const entry of session.entries) {
		if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
		const message = entry.message as Record<string, unknown>;
		if (message.role !== "user") continue;
		const content = typeof message.content === "string" ? message.content : Array.isArray(message.content)
			? message.content.filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string").map((part) => part.text).join(" ") : "";
		if (content.trim()) return content.replace(/\s+/g, " ").trim().slice(0, 512).replaceAll("\0", "");
	}
	return "Untitled conversation";
}

function parseChanges(value: unknown, after: number): ChangePage {
	const page = object(value, "change page");
	if (!Array.isArray(page.changes) || typeof page.more !== "boolean" || !Number.isSafeInteger(page.cursor)) throw new Error("Invalid change page");
	let previous = after;
	const changes = page.changes.map((value): Change => {
		const change = object(value, "change");
		if (!Number.isSafeInteger(change.seq) || Number(change.seq) <= previous) throw new Error("Invalid change sequence");
		previous = Number(change.seq);
		if (change.kind !== "revision" && change.kind !== "deleted") throw new Error("Invalid change kind");
		const conversationId = uuid(change.conversationId);
		const revisionId = change.kind === "revision" ? revisionKey(change.revisionId) : null;
		if (change.kind === "deleted" && change.revisionId !== null) throw new Error("Invalid tombstone");
		return { seq: previous, kind: change.kind, conversationId, revisionId };
	});
	if (page.cursor !== previous || page.more && changes.length === 0) throw new Error("Invalid change cursor");
	return { changes, cursor: previous, more: page.more };
}

/** One profile per home. Every operation reloads state while holding the cross-process lock. */
export class CloudClient {
	readonly home: string;

	constructor(home?: string) {
		const directory = home ?? (process.env.PI_CLOUD_HOME || join(homedir(), ".pi", "cloud"));
		this.home = resolve(text(directory, "cloud home"));
	}

	async #withState<T>(operation: (state: ProfileState) => Promise<T>): Promise<T> {
		return withProfileLock(this.home, async () => {
			await privateDirectory(join(this.home, "revisions"));
			await privateDirectory(join(this.home, "snapshots"));
			let state: ProfileState;
			try {
				state = parseState(JSON.parse(await readPrivate(join(this.home, "state.json"))));
			} catch (error) {
				if (!isMissing(error)) throw error;
				state = emptyState();
			}
			await purgeDeletedCache(this.home, state);
			return operation(state);
		});
	}

	async #save(state: ProfileState): Promise<void> {
		await atomicWrite(join(this.home, "state.json"), JSON.stringify(state));
	}

	#auth(state: ProfileState): { serverUrl: string; token: string; deviceId: string } {
		if (!state.serverUrl || !state.credential) throw new Error("Not logged in to pi-cloud");
		return { serverUrl: state.serverUrl, token: state.credential.token, deviceId: state.credential.deviceId };
	}

	async login(serverUrl: string, enrollmentToken: string, deviceName: string): Promise<DeviceInfo> {
		const server = validateServerUrl(serverUrl);
		const token = revisionKey(enrollmentToken);
		const name = text(deviceName, "device name", 256);
		return this.#withState(async (state) => {
			if (state.serverUrl && state.serverUrl !== server) throw new Error("This profile belongs to another server; use another PI_CLOUD_HOME");
			if (state.credential) throw new Error("Already logged in; logout before enrolling another device");
			// Pin before enrollment: even a lost response must not let this profile switch servers.
			state.serverUrl = server;
			await this.#save(state);
			const result = object(await request(server, "/v1/enroll", { method: "POST", body: { token, name } }), "enrollment response");
			const deviceId = uuid(result.deviceId, "device ID");
			const credential = revisionKey(result.credential);
			state.credential = { deviceId, token: credential, name };
			await this.#save(state);
			return { deviceId, name, serverUrl: server };
		});
	}

	async logout(): Promise<void> {
		return this.#withState(async (state) => {
			if (!state.credential) return;
			const auth = this.#auth(state);
			try {
				await request(auth.serverUrl, "/v1/device", { method: "DELETE", token: auth.token, expectedStatus: 204 });
			} catch (error) {
				// An administrator may already have revoked this credential.
				if (!(error instanceof CloudHttpError && error.status === 401)) throw error;
			}
			state.credential = null;
			// An explicitly revoked device can no longer submit its drafts. Keep acknowledged ancestry.
			for (const binding of state.bindings) delete binding.outbox;
			await this.#save(state);
		});
	}

	async status(): Promise<CloudStatus> {
		return this.#withState(async (state) => ({
			home: this.home, serverUrl: state.serverUrl, authenticated: state.credential !== null,
			device: state.credential && state.serverUrl ? { deviceId: state.credential.deviceId, name: state.credential.name, serverUrl: state.serverUrl } : null,
			projects: state.projects.length, trackedSessions: state.bindings.filter((binding) => binding.enabled).length, cursor: state.cursor,
		}));
	}

	async registerProject(name: string, root: string, id?: string): Promise<ProjectMapping> {
		text(name, "project name", 256);
		if (id !== undefined) uuid(id, "project ID");
		return this.#withState(async (state) => {
			const canonical = await canonicalDirectory(root);
			const existing = state.projects.find((project) => project.root === canonical);
			for (const project of state.projects) {
				if (project.root !== canonical && (isWithin(project.root, canonical) || isWithin(canonical, project.root))) {
					throw new Error("Nested project mappings are ambiguous; register non-overlapping roots");
				}
			}
			if (existing && id && existing.id !== id && state.bindings.some((binding) => binding.projectId === existing.id)) {
				throw new Error("Cannot change the cloud project ID of an existing session binding");
			}
			const mapping = { id: id ?? existing?.id ?? randomUUID(), name, root: canonical };
			if (existing) Object.assign(existing, mapping);
			else state.projects.push(mapping);
			await this.#save(state);
			return { ...mapping };
		});
	}

	async projects(): Promise<ProjectMapping[]> {
		return this.#withState(async (state) => structuredClone(state.projects));
	}

	async bindings(): Promise<Binding[]> {
		return this.#withState(async (state) => state.bindings.map(publicBinding));
	}

	async deleteConversation(id: string): Promise<void> {
		uuid(id, "conversation ID");
		return this.#withState(async (state) => {
			const auth = this.#auth(state);
			await request(auth.serverUrl, `/v1/conversations/${id}`, { method: "DELETE", token: auth.token, expectedStatus: 204 });
			await this.#block(state, id);
		});
	}

	async #sessionMapping(state: ProfileState, projectId: string, cwd: string): Promise<ProjectMapping> {
		const canonical = await canonicalDirectory(cwd);
		const candidates = state.projects.filter((mapping) => mapping.id === projectId && isWithin(mapping.root, canonical));
		if (candidates.length !== 1) throw new Error("Session cwd needs an unambiguous registered mapping for this project");
		await resolveProjectCwd(candidates[0], cwd);
		return candidates[0];
	}

	async track(sessionFile: string, projectId?: string, leafId?: string | null, workspaceMode?: WorkspaceMode): Promise<Binding> {
		if (projectId !== undefined) uuid(projectId, "project ID");
		if (workspaceMode !== undefined && workspaceMode !== "mapped" && workspaceMode !== "anywhere") throw new Error("Invalid workspace mode");
		if (leafId !== undefined && leafId !== null) text(leafId, "active leaf", 256);
		return this.#withState(async (state) => {
			const file = await canonicalSessionFile(sessionFile);
			const snapshot = await stableSnapshot(file);
			const session = parseSnapshot(snapshot);
			activeLeaf(session, leafId);
			let binding = state.bindings.find((binding) => binding.sessionFile === file);
			const effectiveProject = projectId ?? binding?.projectId ?? UNFILED_PROJECT.id;
			const mode = workspaceMode ?? (projectId ? "mapped" : binding?.workspaceMode ?? "anywhere");
			if (mode === "mapped") await this.#sessionMapping(state, effectiveProject, session.header.cwd);
			if (binding) {
				if (binding.projectId !== effectiveProject) throw new Error("Session is already bound to another cloud project");
				if (state.tombstones.includes(binding.conversationId)) throw new Error("Conversation has been deleted; this binding cannot be re-enabled");
				binding.enabled = true;
				binding.workspaceMode = mode;
			} else {
				binding = { sessionFile: file, conversationId: randomUUID(), projectId: effectiveProject, workspaceMode: mode, headRevisionId: null, enabled: true };
				state.bindings.push(binding);
			}
			if (leafId === undefined) {
				delete binding.leafId;
				delete binding.leafSnapshotHash;
			} else {
				binding.leafId = leafId;
				binding.leafSnapshotHash = createHash("sha256").update(snapshot).digest("hex");
			}
			await this.#save(state);
			return publicBinding(binding);
		});
	}

	async untrack(sessionFile: string): Promise<void> {
		return this.#withState(async (state) => {
			let file: string;
			try { file = await canonicalSessionFile(sessionFile); }
			catch (error) { if (!isMissing(error)) throw error; file = resolve(sessionFile); }
			const binding = state.bindings.find((binding) => binding.sessionFile === file);
			if (binding) {
				binding.enabled = false;
				delete binding.outbox;
				await this.#save(state);
			}
		});
	}

	async #block(state: ProfileState, conversationId: string): Promise<void> {
		if (!state.tombstones.includes(conversationId)) state.tombstones.push(conversationId);
		for (const binding of state.bindings) {
			if (binding.conversationId === conversationId) {
				binding.enabled = false;
				delete binding.outbox;
			}
		}
		// Persist the tombstone before unlinking cache content, including on crash recovery.
		await this.#save(state);
		await purgeDeletedCache(this.home, state);
	}

	async #revision(state: ProfileState, id: string, expectedConversation?: string): Promise<Revision> {
		revisionKey(id);
		assertAvailable(state, id, expectedConversation);
		let revision = await readCachedRevision(this.home, state, id);
		if (!revision) {
			const auth = this.#auth(state);
			try {
				revision = parseRevision(await request(auth.serverUrl, `/v1/revisions/${id}`, { token: auth.token }));
			} catch (error) {
				if (error instanceof CloudHttpError && error.status === 410) {
					if (!state.unavailableRevisions.includes(id)) state.unavailableRevisions.push(id);
					const conversation = expectedConversation ?? state.revisions.find((revision) => revision.id === id)?.conversationId
						?? state.bindings.find((binding) => binding.headRevisionId === id || binding.outbox?.id === id)?.conversationId;
					if (conversation) await this.#block(state, conversation);
					else await this.#save(state);
				}
				throw error;
			}
		}
		if (revision.id !== id || expectedConversation && revision.conversationId !== expectedConversation) throw new Error("Revision response does not match the requested revision");
		await cacheRevision(this.home, state, revision);
		await this.#save(state);
		return revision;
	}

	async #pull(state: ProfileState, result: SyncResult): Promise<void> {
		const auth = this.#auth(state);
		let more = true;
		while (more) {
			const page = parseChanges(await request(auth.serverUrl, `/v1/changes?after=${state.cursor}`, { token: auth.token }), state.cursor);
			// Apply deletions first: older revisions on this page may already return 410.
			for (const change of page.changes) {
				if (change.kind === "deleted") {
					if (!state.tombstones.includes(change.conversationId)) result.deleted++;
					await this.#block(state, change.conversationId);
				}
			}
			for (const change of page.changes) {
				if (change.kind !== "revision" || state.tombstones.includes(change.conversationId)) continue;
				const id = change.revisionId!;
				if (state.unavailableRevisions.includes(id)) {
					await this.#block(state, change.conversationId);
					result.deleted++;
					continue;
				}
				const known = state.revisions.some((revision) => revision.id === id);
				try {
					await this.#revision(state, id, change.conversationId);
					if (!known) result.downloaded++;
				} catch (error) {
					if (!(error instanceof CloudHttpError && error.status === 410)) throw error;
					result.deleted++;
				}
			}
			state.cursor = page.cursor;
			await this.#save(state);
			more = page.more;
		}
	}

	async #uploadWorkspace(state: ProfileState, binding: StoredBinding, cwd: string) {
		if (binding.workspaceMode === "mapped") {
			const mapping = await this.#sessionMapping(state, binding.projectId, cwd);
			const resolved = await resolveProjectCwd(mapping, cwd);
			return { project: { id: mapping.id, name: mapping.name }, root: mapping.root, relativeCwd: resolved.relativeCwd };
		}
		const project = state.revisions.find((revision) => revision.id === binding.headRevisionId)?.project
			?? state.projects.find((project) => project.id === binding.projectId)
			?? (binding.projectId === UNFILED_PROJECT.id ? UNFILED_PROJECT : undefined);
		if (!project) throw new Error("Cloud project metadata is unavailable for this conversation");
		// Cwd is descriptive only in anywhere mode; the original folder need not still exist.
		return { project: { id: project.id, name: project.name }, root: cwd, relativeCwd: "." };
	}

	async #upload(state: ProfileState, binding: StoredBinding, result: SyncResult): Promise<void> {
		const auth = this.#auth(state);
		const retrying = binding.outbox !== undefined;
		if (!binding.outbox) {
			const snapshot = await stableSnapshot(binding.sessionFile);
			const session = parseSnapshot(snapshot);
			const workspace = await this.#uploadWorkspace(state, binding, session.header.cwd);
			// A saved leaf is authoritative only for the snapshot observed by the extension.
			// After a crash, newer on-disk entries must not resume at a stale checkpoint.
			const snapshotHash = createHash("sha256").update(snapshot).digest("hex");
			const leafId = activeLeaf(session, binding.leafSnapshotHash === snapshotHash ? binding.leafId : undefined);
			const digest = fingerprint(snapshot, leafId);
			if (binding.lastFingerprint === digest) { result.skipped++; return; }
			const draft = parseDraft({
				conversationId: binding.conversationId, parentRevisionId: binding.headRevisionId, deviceId: auth.deviceId,
				project: workspace.project, relativeCwd: workspace.relativeCwd, sourceRoot: workspace.root,
				sourceCwd: session.header.cwd, nativeSessionId: session.header.id, title: sessionTitle(session), leafId,
				git: await readGitState(session.header.cwd), snapshot,
			});
			binding.outbox = { id: revisionId(draft), draft, fingerprint: digest };
			await this.#save(state);
		}
		const pending = binding.outbox;
		let revision: Revision;
		try {
			revision = parseRevision(await request(auth.serverUrl, "/v1/revisions", { method: "POST", token: auth.token, body: pending.draft }));
		} catch (error) {
			if (error instanceof CloudHttpError && error.status === 410) await this.#block(state, binding.conversationId);
			throw error;
		}
		if (revision.id !== pending.id) throw new Error("Upload acknowledgement does not match the durable draft");
		await cacheRevision(this.home, state, revision);
		binding.headRevisionId = revision.id;
		binding.lastFingerprint = pending.fingerprint;
		delete binding.outbox;
		await this.#save(state);
		result.uploaded++;
		// A retry may acknowledge an older snapshot. Capture the current settled file too,
		// continuing from that acknowledgement rather than leaving it for another trigger.
		if (retrying) await this.#upload(state, binding, result);
	}

	async sync(): Promise<SyncResult> {
		return this.#withState(async (state) => {
			this.#auth(state);
			const result: SyncResult = { uploaded: 0, downloaded: 0, skipped: 0, deleted: 0, cursor: state.cursor, errors: [] };
			const pull = async () => {
				try { await this.#pull(state, result); }
				catch (error) { result.errors.push({ phase: "pull", message: error instanceof Error ? error.message : "Pull failed" }); }
			};
			await pull();
			for (const binding of state.bindings) {
				if (!binding.enabled || state.tombstones.includes(binding.conversationId)) continue;
				try { await this.#upload(state, binding, result); }
				catch (error) {
					result.errors.push({ phase: "upload", sessionFile: binding.sessionFile, message: error instanceof Error ? error.message : "Upload failed" });
				}
			}
			await pull();
			result.cursor = state.cursor;
			return result;
		});
	}

	async conversations(): Promise<ConversationSummary[]> {
		return this.#withState(async (state) => structuredClone(catalogue(state)));
	}

	async getRevision(id: string): Promise<Revision> {
		revisionKey(id);
		return this.#withState((state) => this.#revision(state, id));
	}

	async prepareResume(revisionId: string, workspaceRoot?: string): Promise<ResumePlan> {
		revisionKey(revisionId);
		return this.#withState(async (state) => {
			const revision = await this.#revision(state, revisionId);
			const root = workspaceRoot === undefined ? undefined : await canonicalDirectory(workspaceRoot);
			const mappings = state.projects.filter((mapping) => mapping.id === revision.project.id && (root === undefined || mapping.root === root));
			if (mappings.length !== 1) throw new Error("Register the target workspace for this cloud project first; specify workspaceRoot when multiple mappings exist");
			const mapping = mappings[0];
			const targetCwd = await resolveRevisionCwd(revision, mapping);
			return { revision, snapshotPath: snapshotPath(this.home, revision.id), targetCwd, projectRoot: mapping.root, workspaceMode: "mapped", warnings: await resumeWarnings(revision, targetCwd) };
		});
	}

	async prepareResumeInDirectory(revisionId: string, directory: string): Promise<ResumePlan> {
		revisionKey(revisionId);
		return this.#withState(async (state) => {
			const revision = await this.#revision(state, revisionId);
			const targetCwd = await canonicalDirectory(directory);
			return {
				revision, snapshotPath: snapshotPath(this.home, revision.id), targetCwd,
				projectRoot: null, workspaceMode: "anywhere",
				warnings: ["Project matching was explicitly bypassed; historical paths may refer to unrelated files.", ...await resumeWarnings(revision, targetCwd)],
			};
		});
	}

	async recordResume(sessionFile: string, revisionId: string, workspaceMode: WorkspaceMode = "mapped"): Promise<Binding> {
		revisionKey(revisionId);
		if (workspaceMode !== "mapped" && workspaceMode !== "anywhere") throw new Error("Invalid workspace mode");
		return this.#withState(async (state) => {
			const revision = await this.#revision(state, revisionId);
			const file = await canonicalSessionFile(sessionFile);
			const snapshotDirectory = await canonicalDirectory(join(this.home, "snapshots"));
			const revisionDirectory = await canonicalDirectory(join(this.home, "revisions"));
			if (isWithin(snapshotDirectory, file) || isWithin(revisionDirectory, file)) throw new Error("Resume must be a new native pi session, not a cached cloud snapshot");
			const snapshot = await stableSnapshot(file);
			const session = parseSnapshot(snapshot);
			if (workspaceMode === "mapped") {
				const mapping = await this.#sessionMapping(state, revision.project.id, session.header.cwd);
				const current = await resolveProjectCwd(mapping, session.header.cwd);
				if (current.cwd !== await resolveRevisionCwd(revision, mapping)) throw new Error("Resumed session header cwd does not match the revision's mapped working directory");
			} else {
				await canonicalDirectory(session.header.cwd);
			}
			const existing = state.bindings.find((binding) => binding.sessionFile === file);
			if (existing) {
				if (existing.conversationId !== revision.conversationId || existing.projectId !== revision.project.id || existing.headRevisionId !== revision.id) {
					throw new Error("Session is already bound; refusing to replace its cloud identity or ancestry");
				}
				return publicBinding(existing);
			}
			const binding: StoredBinding = {
				sessionFile: file, conversationId: revision.conversationId, projectId: revision.project.id, workspaceMode,
				headRevisionId: revision.id, enabled: true,
			};
			state.bindings.push(binding);
			await this.#save(state);
			return publicBinding(binding);
		});
	}
}

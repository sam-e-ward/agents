import { isAbsolute } from "node:path";
import { object, parseDraft, revisionId, revisionKey, text, uuid } from "../protocol.ts";
import type { CachedRevision, ProfileState, StoredBinding } from "./types.ts";
import { validateServerUrl } from "./http.ts";

export function emptyState(): ProfileState {
	return { version: 1, serverUrl: null, credential: null, projects: [], bindings: [], revisions: [], tombstones: [], unavailableRevisions: [], cursor: 0 };
}

function array(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new Error("Invalid profile array");
	return value;
}

function absolutePath(value: unknown): string {
	const path = text(value, "profile path");
	if (!isAbsolute(path)) throw new Error("Profile paths must be absolute");
	return path;
}

export function parseState(value: unknown): ProfileState {
	const data = object(value, "profile state");
	if (data.version !== 1) throw new Error("Unsupported cloud profile version");
	if (!Number.isSafeInteger(data.cursor) || Number(data.cursor) < 0) throw new Error("Invalid profile cursor");
	const state = emptyState();
	state.cursor = Number(data.cursor);
	state.serverUrl = data.serverUrl === null ? null : validateServerUrl(text(data.serverUrl, "server URL"));
	if (data.credential !== null) {
		const auth = object(data.credential, "credential");
		const token = revisionKey(auth.token);
		state.credential = { deviceId: uuid(auth.deviceId), name: text(auth.name, "device name", 256), token };
		if (!state.serverUrl) throw new Error("Credential has no pinned server");
	}
	state.projects = array(data.projects).map((value) => {
		const project = object(value, "project mapping");
		return { id: uuid(project.id), name: text(project.name, "project name", 256), root: absolutePath(project.root) };
	});
	state.bindings = array(data.bindings).map((value): StoredBinding => {
		const binding = object(value, "binding");
		if (typeof binding.enabled !== "boolean") throw new Error("Invalid binding enabled flag");
		const parsed: StoredBinding = {
			sessionFile: absolutePath(binding.sessionFile), conversationId: uuid(binding.conversationId), projectId: uuid(binding.projectId),
			headRevisionId: binding.headRevisionId === null ? null : revisionKey(binding.headRevisionId), enabled: binding.enabled,
		};
		if (binding.leafId !== undefined) parsed.leafId = binding.leafId === null ? null : text(binding.leafId, "active leaf", 256);
		if (binding.leafSnapshotHash !== undefined) parsed.leafSnapshotHash = revisionKey(binding.leafSnapshotHash);
		if (binding.lastFingerprint !== undefined) parsed.lastFingerprint = revisionKey(binding.lastFingerprint);
		if (binding.outbox !== undefined) {
			const pending = object(binding.outbox, "outbox");
			const draft = parseDraft(pending.draft);
			const id = revisionKey(pending.id);
			if (revisionId(draft) !== id || draft.conversationId !== parsed.conversationId || draft.project.id !== parsed.projectId
				|| draft.parentRevisionId !== parsed.headRevisionId) throw new Error("Outbox does not match its binding");
			parsed.outbox = { id, draft, fingerprint: revisionKey(pending.fingerprint) };
		}
		return parsed;
	});
	state.revisions = array(data.revisions).map((value): CachedRevision => {
		const entry = object(value, "cached revision");
		const project = object(entry.project, "cached project");
		const createdAt = text(entry.createdAt, "revision timestamp", 64);
		if (!Number.isFinite(Date.parse(createdAt))) throw new Error("Invalid revision timestamp");
		return {
			id: revisionKey(entry.id), conversationId: uuid(entry.conversationId),
			parentRevisionId: entry.parentRevisionId === null ? null : revisionKey(entry.parentRevisionId),
			project: { id: uuid(project.id), name: text(project.name, "project name", 256) },
			title: text(entry.title, "revision title", 512), createdAt,
		};
	});
	state.tombstones = array(data.tombstones).map((value) => uuid(value));
	state.unavailableRevisions = array(data.unavailableRevisions).map((value) => revisionKey(value));
	if (new Set(state.bindings.map((binding) => binding.sessionFile)).size !== state.bindings.length
		|| new Set(state.revisions.map((revision) => revision.id)).size !== state.revisions.length
		|| new Set(state.projects.map((project) => project.root)).size !== state.projects.length) throw new Error("Duplicate profile records");
	return state;
}

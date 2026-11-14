import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

export const PROTOCOL_VERSION = 1;
export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
export const MAX_REQUEST_BYTES = MAX_SNAPSHOT_BYTES * 2 + 64 * 1024;
export const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const REVISION_PATTERN = /^[0-9a-f]{64}$/;

export interface Project {
	id: string;
	name: string;
}

export interface GitState {
	branch: string;
	commit: string;
	dirty: boolean;
}

export interface RevisionDraft {
	conversationId: string;
	parentRevisionId: string | null;
	deviceId: string;
	project: Project;
	relativeCwd: string;
	sourceRoot: string;
	sourceCwd: string;
	nativeSessionId: string;
	title: string;
	leafId: string | null;
	git: GitState | null;
	snapshot: string;
}

export interface Revision extends RevisionDraft {
	id: string;
	createdAt: string;
}

export interface ConversationSummary {
	id: string;
	project: Project;
	title: string;
	heads: string[];
	updatedAt: string;
}

export interface Change {
	seq: number;
	kind: "revision" | "deleted";
	conversationId: string;
	revisionId: string | null;
}

export interface ChangePage {
	changes: Change[];
	cursor: number;
	more: boolean;
}

export interface SessionSnapshot {
	header: Record<string, unknown> & { type: "session"; id: string; cwd: string; version: number };
	entries: Record<string, unknown>[];
}

export function object(value: unknown, label = "object"): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
	return value as Record<string, unknown>;
}

export function text(value: unknown, label: string, max = 4096): string {
	if (typeof value !== "string" || !value || value.length > max || value.includes("\0")) {
		throw new Error(`Invalid ${label}`);
	}
	return value;
}

export function uuid(value: unknown, label = "ID"): string {
	const result = text(value, label, 36);
	if (!ID_PATTERN.test(result)) throw new Error(`Invalid ${label}`);
	return result;
}

export function revisionKey(value: unknown): string {
	const result = text(value, "revision ID", 64);
	if (!REVISION_PATTERN.test(result)) throw new Error("Invalid revision ID");
	return result;
}

export function relativeDirectory(value: unknown): string {
	const result = text(value, "relative working directory");
	if (result.includes("\\") || posix.isAbsolute(result) || win32.isAbsolute(result)
		|| result.split("/").some((part) => part === ".." || part === "" || part === "." && result !== ".")
		|| /^[a-z]:/i.test(result)) throw new Error("Working directory must stay within the mapped project");
	return result;
}

export function parseSnapshot(snapshot: string): SessionSnapshot {
	if (Buffer.byteLength(snapshot) > MAX_SNAPSHOT_BYTES) throw new Error("Session exceeds the 16 MiB snapshot limit");
	if (!snapshot.endsWith("\n")) throw new Error("Session has an incomplete final line; retry after pi has saved it");
	const lines = snapshot.slice(0, -1).split("\n");
	const entries = lines.map((line) => object(JSON.parse(line), "session entry"));
	const header = entries.shift();
	if (!header || header.type !== "session" || header.version !== 3) {
		throw new Error("Expected a pi v3 session header (open older sessions in pi to migrate them first)");
	}
	text(header.id, "native session ID", 256);
	text(header.cwd, "session working directory");
	const ids = new Set<string>();
	for (const entry of entries) {
		text(entry.type, "entry type", 256);
		const id = text(entry.id, "entry ID", 256);
		if (ids.has(id) || entry.type === "session") throw new Error("Duplicate session entry");
		if (entry.parentId !== null && (typeof entry.parentId !== "string" || !ids.has(entry.parentId))) {
			throw new Error("Session contains an unresolved parent entry");
		}
		ids.add(id);
	}
	return { header: header as SessionSnapshot["header"], entries };
}

export function parseDraft(value: unknown): RevisionDraft {
	const data = object(value, "revision");
	const project = object(data.project, "project");
	let git: GitState | null = null;
	if (data.git !== null) {
		const state = object(data.git, "Git state");
		if (typeof state.dirty !== "boolean") throw new Error("Invalid Git dirty flag");
		git = { branch: text(state.branch, "branch", 1024), commit: text(state.commit, "commit", 128), dirty: state.dirty };
	}
	if (typeof data.snapshot !== "string") throw new Error("Invalid snapshot");
	const session = parseSnapshot(data.snapshot);
	const draft: RevisionDraft = {
		conversationId: uuid(data.conversationId, "conversation ID"),
		parentRevisionId: data.parentRevisionId === null ? null : revisionKey(data.parentRevisionId),
		deviceId: uuid(data.deviceId, "device ID"),
		project: { id: uuid(project.id, "project ID"), name: text(project.name, "project name", 256) },
		relativeCwd: relativeDirectory(data.relativeCwd),
		sourceRoot: text(data.sourceRoot, "source root"),
		sourceCwd: text(data.sourceCwd, "source working directory"),
		nativeSessionId: text(data.nativeSessionId, "native session ID", 256),
		title: text(data.title, "title", 512),
		leafId: data.leafId === null ? null : text(data.leafId, "active leaf", 256),
		git,
		snapshot: data.snapshot,
	};
	if (session.header.id !== draft.nativeSessionId || session.header.cwd !== draft.sourceCwd) {
		throw new Error("Snapshot header does not match its revision metadata");
	}
	if (draft.leafId !== null && !session.entries.some((entry) => entry.id === draft.leafId)) {
		throw new Error("Active leaf is not in the session");
	}
	return draft;
}

export function revisionId(draft: RevisionDraft): string {
	// Parsing also fixes property order, so equivalent requests have the same digest.
	return createHash("sha256").update(JSON.stringify(parseDraft(draft))).digest("hex");
}

export function parseRevision(value: unknown): Revision {
	const data = object(value, "revision");
	const draft = parseDraft(data);
	const id = revisionKey(data.id);
	if (revisionId(draft) !== id) throw new Error("Revision integrity check failed");
	const createdAt = text(data.createdAt, "revision timestamp", 64);
	if (!Number.isFinite(Date.parse(createdAt))) throw new Error("Invalid revision timestamp");
	return { ...draft, id, createdAt };
}

import type { ConversationSummary, Revision, RevisionDraft } from "../protocol.ts";

export interface ProjectMapping {
	id: string;
	name: string;
	root: string;
}

export interface Binding {
	sessionFile: string;
	conversationId: string;
	projectId: string;
	headRevisionId: string | null;
	enabled: boolean;
	/** Omitted: derive the last entry. Null: explicitly select the session root. */
	leafId?: string | null;
}

export interface DeviceInfo {
	deviceId: string;
	name: string;
	serverUrl: string;
}

export interface CloudStatus {
	home: string;
	serverUrl: string | null;
	authenticated: boolean;
	device: DeviceInfo | null;
	projects: number;
	trackedSessions: number;
	cursor: number;
}

export interface SyncIssue {
	sessionFile?: string;
	phase: "upload" | "pull";
	message: string;
}

export interface SyncResult {
	uploaded: number;
	downloaded: number;
	skipped: number;
	deleted: number;
	cursor: number;
	errors: SyncIssue[];
}

export interface ResumePlan {
	revision: Revision;
	snapshotPath: string;
	targetCwd: string;
	projectRoot: string;
	warnings: string[];
}

export interface PendingUpload {
	id: string;
	draft: RevisionDraft;
	fingerprint: string;
}

export interface StoredBinding extends Binding {
	leafSnapshotHash?: string;
	lastFingerprint?: string;
	outbox?: PendingUpload;
}

export interface CachedRevision {
	id: string;
	conversationId: string;
	parentRevisionId: string | null;
	project: { id: string; name: string };
	title: string;
	createdAt: string;
}

export interface ProfileState {
	version: 1;
	serverUrl: string | null;
	credential: { deviceId: string; name: string; token: string } | null;
	projects: ProjectMapping[];
	bindings: StoredBinding[];
	revisions: CachedRevision[];
	tombstones: string[];
	unavailableRevisions: string[];
	cursor: number;
}

export type { ConversationSummary, Revision };

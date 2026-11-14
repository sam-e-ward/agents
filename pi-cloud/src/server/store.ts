import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	chmodSync, closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync,
	mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	parseDraft, parseRevision, revisionId, revisionKey, text, uuid,
} from "../protocol.ts";
import type { Change, ChangePage, ConversationSummary, Revision } from "../protocol.ts";
import { CloudError, validate } from "./errors.ts";

export interface Device {
	id: string;
	name: string;
	createdAt: string;
	revoked: boolean;
}

export interface Enrollment {
	token: string;
	expiresAt: string;
}

interface RevisionRow {
	id: string;
	conversation_id: string;
	created_at: string;
}

const ENROLLMENT_LIFETIME_MS = 10 * 60 * 1000;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

function tokenHash(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function privateDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	if (!lstatSync(path).isDirectory()) throw new Error("Data path must be a directory, not a symlink");
	chmodSync(path, 0o700);
}

function isAlreadyPresent(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EEXIST";
}

export class CloudStore {
	readonly #db: DatabaseSync;
	readonly #blobDirectory: string;
	#closed = false;

	constructor(dataDir: string) {
		const directory = resolve(dataDir);
		privateDirectory(directory);
		this.#blobDirectory = join(directory, "blobs");
		privateDirectory(this.#blobDirectory);
		const databasePath = join(directory, "cloud.sqlite");
		const descriptor = openSync(databasePath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
		try {
			if (!fstatSync(descriptor).isFile()) throw new Error("Database must be a regular file");
			chmodSync(databasePath, 0o600);
		} finally {
			closeSync(descriptor);
		}
		this.#db = new DatabaseSync(databasePath);
		try {
			this.#db.exec(`
				pragma busy_timeout = 5000;
				pragma foreign_keys = on;
				pragma journal_mode = delete;
				pragma synchronous = full;
			`);
			const version = this.#db.prepare("pragma user_version").get() as { user_version: number };
			if (version.user_version !== 0 && version.user_version !== 1) {
				throw new Error("Unsupported cloud database version");
			}
			this.#transaction(() => {
				this.#db.exec(`
					create table if not exists enrollments (
					    token_hash text primary key,
					    name text not null,
					    expires_at text not null
					);
					create table if not exists devices (
					    id text primary key,
					    name text not null,
					    created_at text not null,
					    credential_hash text not null unique,
					    revoked integer not null default 0
					);
					create table if not exists conversations (
					    id text primary key,
					    project_id text not null,
					    project_name text not null,
					    title text not null,
					    updated_at text not null
					);
					create table if not exists revisions (
					    id text primary key,
					    conversation_id text not null references conversations (id),
					    parent_revision_id text references revisions (id),
					    device_id text not null references devices (id),
					    created_at text not null
					);
					create index if not exists revisions_conversation on revisions (conversation_id);
					create table if not exists heads (
					    conversation_id text not null references conversations (id),
					    revision_id text not null references revisions (id),
					    primary key (conversation_id, revision_id)
					);
					create table if not exists tombstones (
					    conversation_id text primary key,
					    deleted_at text not null
					);
					create table if not exists changes (
					    seq integer primary key autoincrement,
					    kind text not null check (kind in ('revision', 'deleted')),
					    conversation_id text not null,
					    revision_id text
					);
					pragma user_version = 1;
				`);
			});
		} catch (error) {
			this.#db.close();
			throw error;
		}
	}

	#transaction<T>(operation: () => T): T {
		this.#db.exec("begin immediate");
		try {
			const result = operation();
			this.#db.exec("commit");
			return result;
		} catch (error) {
			this.#db.exec("rollback");
			throw error;
		}
	}

	createEnrollment(deviceName: string): Enrollment {
		const name = validate(() => text(deviceName, "device name", 256));
		const token = randomBytes(32).toString("hex");
		const now = new Date();
		const expiresAt = new Date(now.getTime() + ENROLLMENT_LIFETIME_MS).toISOString();
		this.#transaction(() => {
			this.#db.prepare(`
				delete from enrollments
				where
				    expires_at <= ?
			`).run(now.toISOString());
			this.#db.prepare(`
				insert into enrollments (
				    token_hash,
				    name,
				    expires_at
				)
				values (?, ?, ?)
			`).run(tokenHash(token), name, expiresAt);
		});
		return { token, expiresAt };
	}

	enroll(token: unknown, deviceName: unknown): { deviceId: string; credential: string } {
		const name = validate(() => text(deviceName, "device name", 256));
		if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
			throw new CloudError(401, "Invalid or expired enrollment token");
		}
		return this.#transaction(() => {
			const now = new Date().toISOString();
			const consumed = this.#db.prepare(`
				delete from enrollments
				where
				    token_hash = ?
				    and expires_at > ?
				returning
				    token_hash
			`).get(tokenHash(token), now);
			if (!consumed) throw new CloudError(401, "Invalid or expired enrollment token");
			const deviceId = randomUUID();
			const credential = randomBytes(32).toString("hex");
			this.#db.prepare(`
				insert into devices (
				    id,
				    name,
				    created_at,
				    credential_hash
				)
				values (?, ?, ?, ?)
			`).run(deviceId, name, now, tokenHash(credential));
			return { deviceId, credential };
		});
	}

	authenticate(credential: string): string {
		if (!TOKEN_PATTERN.test(credential)) throw new CloudError(401, "Unauthorized");
		const device = this.#db.prepare(`
			select
			    id
			from
			    devices
			where
			    credential_hash = ?
			    and revoked = 0
		`).get(tokenHash(credential)) as { id: string } | undefined;
		if (!device) throw new CloudError(401, "Unauthorized");
		return device.id;
	}

	listDevices(): Device[] {
		const devices = this.#db.prepare(`
			select
			    id,
			    name,
			    created_at,
			    revoked
			from
			    devices
			order by
			    created_at,
			    id
		`).all() as unknown as { id: string; name: string; created_at: string; revoked: number }[];
		return devices.map((device) => ({
			id: device.id, name: device.name, createdAt: device.created_at, revoked: device.revoked !== 0,
		}));
	}

	revokeDevice(id: string): void {
		validate(() => uuid(id, "device ID"));
		this.#db.prepare(`
			update devices
			set
			    revoked = 1
			where
			    id = ?
		`).run(id);
	}

	#assertLiveConversation(conversationId: string): void {
		const deleted = this.#db.prepare(`
			select
			    conversation_id
			from
			    tombstones
			where
			    conversation_id = ?
		`).get(conversationId);
		if (deleted) throw new CloudError(410, "Conversation deleted");
	}

	#readBlob(row: RevisionRow): Revision {
		const revision = parseRevision(JSON.parse(readFileSync(join(this.#blobDirectory, `${row.id}.json`), "utf8")));
		if (revision.id !== row.id || revision.conversationId !== row.conversation_id || revision.createdAt !== row.created_at) {
			throw new Error("Stored revision integrity failure");
		}
		return revision;
	}

	#writeBlob(revision: Revision): Revision {
		const destination = join(this.#blobDirectory, `${revision.id}.json`);
		const temporary = join(this.#blobDirectory, `.${randomUUID()}.tmp`);
		const descriptor = openSync(temporary, "wx", 0o600);
		try {
			try {
				writeFileSync(descriptor, JSON.stringify(revision));
				fsyncSync(descriptor);
			} finally {
				closeSync(descriptor);
			}
			try {
				// A hard link publishes a complete file atomically without replacing an existing blob.
				linkSync(temporary, destination);
			} catch (error) {
				if (!isAlreadyPresent(error)) throw error;
				const existing = parseRevision(JSON.parse(readFileSync(destination, "utf8")));
				if (existing.id !== revision.id) throw new Error("Stored revision integrity failure");
				return existing;
			}
			const directory = openSync(this.#blobDirectory, constants.O_RDONLY);
			try {
				fsyncSync(directory);
			} finally {
				closeSync(directory);
			}
			return revision;
		} finally {
			unlinkSync(temporary);
		}
	}

	registerRevision(value: unknown, authenticatedDeviceId: string): Revision {
		const draft = validate(() => parseDraft(value));
		if (draft.deviceId !== authenticatedDeviceId) throw new CloudError(403, "Device does not match credential");
		const id = revisionId(draft);
		return this.#transaction(() => {
			const device = this.#db.prepare(`
				select
				    id
				from
				    devices
				where
				    id = ?
				    and revoked = 0
			`).get(authenticatedDeviceId);
			if (!device) throw new CloudError(401, "Unauthorized");
			this.#assertLiveConversation(draft.conversationId);
			const existing = this.#db.prepare(`
				select
				    id,
				    conversation_id,
				    created_at
				from
				    revisions
				where
				    id = ?
			`).get(id) as unknown as RevisionRow | undefined;
			if (existing) return this.#readBlob(existing);
			const conversation = this.#db.prepare(`
				select
				    project_id
				from
				    conversations
				where
				    id = ?
			`).get(draft.conversationId) as { project_id: string } | undefined;
			if (conversation && conversation.project_id !== draft.project.id) {
				throw new CloudError(409, "Conversation belongs to another project");
			}
			if (draft.parentRevisionId !== null) {
				const parent = this.#db.prepare(`
					select
					    r.conversation_id,
					    c.project_id
					from
					    revisions r
					    join conversations c on c.id = r.conversation_id
					where
					    r.id = ?
				`).get(draft.parentRevisionId) as { conversation_id: string; project_id: string } | undefined;
				if (!parent || parent.conversation_id !== draft.conversationId || parent.project_id !== draft.project.id) {
					throw new CloudError(409, "Parent revision must exist in the same conversation and project");
				}
			}
			const revision = this.#writeBlob({ ...draft, id, createdAt: new Date().toISOString() });
			this.#db.prepare(`
				insert into conversations (
				    id,
				    project_id,
				    project_name,
				    title,
				    updated_at
				)
				values (?, ?, ?, ?, ?)
				on conflict (id) do update set
				    project_name = excluded.project_name,
				    title = excluded.title,
				    updated_at = excluded.updated_at
			`).run(draft.conversationId, draft.project.id, draft.project.name, draft.title, revision.createdAt);
			this.#db.prepare(`
				insert into revisions (
				    id,
				    conversation_id,
				    parent_revision_id,
				    device_id,
				    created_at
				)
				values (?, ?, ?, ?, ?)
			`).run(id, draft.conversationId, draft.parentRevisionId, draft.deviceId, revision.createdAt);
			this.#db.prepare(`
				delete from heads
				where
				    conversation_id = ?
				    and revision_id = ?
			`).run(draft.conversationId, draft.parentRevisionId);
			this.#db.prepare(`
				insert into heads (
				    conversation_id,
				    revision_id
				)
				values (?, ?)
			`).run(draft.conversationId, id);
			this.#db.prepare(`
				insert into changes (
				    kind,
				    conversation_id,
				    revision_id
				)
				values ('revision', ?, ?)
			`).run(draft.conversationId, id);
			return revision;
		});
	}

	getRevision(id: string): Revision {
		validate(() => revisionKey(id));
		const row = this.#db.prepare(`
			select
			    id,
			    conversation_id,
			    created_at
			from
			    revisions
			where
			    id = ?
		`).get(id) as unknown as RevisionRow | undefined;
		if (!row) throw new CloudError(404, "Revision not found");
		this.#assertLiveConversation(row.conversation_id);
		return this.#readBlob(row);
	}

	listConversations(): ConversationSummary[] {
		// One statement keeps summaries and heads consistent even with other local processes.
		const rows = this.#db.prepare(`
			select
			    c.id,
			    c.project_id,
			    c.project_name,
			    c.title,
			    c.updated_at,
			    h.revision_id
			from
			    conversations c
			    join heads h on h.conversation_id = c.id
			where
			    not exists (
			        select
			            1
			        from
			            tombstones t
			        where
			            t.conversation_id = c.id
			    )
			order by
			    c.updated_at desc,
			    c.id,
			    h.revision_id
		`).all() as unknown as {
			id: string; project_id: string; project_name: string; title: string; updated_at: string; revision_id: string;
		}[];
		const conversations = new Map<string, ConversationSummary>();
		for (const row of rows) {
			let conversation = conversations.get(row.id);
			if (!conversation) {
				conversation = {
					id: row.id, project: { id: row.project_id, name: row.project_name },
					title: row.title, heads: [], updatedAt: row.updated_at,
				};
				conversations.set(row.id, conversation);
			}
			conversation.heads.push(row.revision_id);
		}
		return [...conversations.values()];
	}

	listChanges(after = 0): ChangePage {
		if (!Number.isSafeInteger(after) || after < 0) throw new CloudError(400, "Invalid change cursor");
		const rows = this.#db.prepare(`
			select
			    seq,
			    kind,
			    conversation_id,
			    revision_id
			from
			    changes
			where
			    seq > ?
			order by
			    seq
			limit 101
		`).all(after) as unknown as {
			seq: number; kind: Change["kind"]; conversation_id: string; revision_id: string | null;
		}[];
		const changes = rows.slice(0, 100).map((row) => ({
			seq: row.seq, kind: row.kind, conversationId: row.conversation_id, revisionId: row.revision_id,
		}));
		return { changes, cursor: changes.at(-1)?.seq ?? after, more: rows.length > 100 };
	}

	deleteConversation(id: string): void {
		validate(() => uuid(id, "conversation ID"));
		this.#transaction(() => {
			const inserted = this.#db.prepare(`
				insert into tombstones (
				    conversation_id,
				    deleted_at
				)
				values (?, ?)
				on conflict (conversation_id) do nothing
			`).run(id, new Date().toISOString());
			if (inserted.changes === 0) return;
			this.#db.prepare(`
				insert into changes (
				    kind,
				    conversation_id,
				    revision_id
				)
				values ('deleted', ?, null)
			`).run(id);
		});
	}

	close(): void {
		if (this.#closed) return;
		this.#db.close();
		this.#closed = true;
	}
}

export function openStore(dataDir: string): CloudStore {
	return new CloudStore(dataDir);
}

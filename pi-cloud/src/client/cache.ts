import { constants } from "node:fs";
import { open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { REVISION_PATTERN, parseRevision, revisionKey } from "../protocol.ts";
import type { ConversationSummary, Revision } from "../protocol.ts";
import { atomicWrite, readPrivate } from "./filesystem.ts";
import type { ProfileState } from "./types.ts";

export function isMissing(error: unknown): boolean {
	return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

export function snapshotPath(home: string, id: string): string {
	return join(home, "snapshots", `${revisionKey(id)}.jsonl`);
}

export function revisionPath(home: string, id: string): string {
	return join(home, "revisions", `${revisionKey(id)}.json`);
}

export function assertAvailable(state: ProfileState, id: string, conversationId?: string): void {
	const known = conversationId ?? state.revisions.find((revision) => revision.id === id)?.conversationId;
	if (state.unavailableRevisions.includes(id) || known && state.tombstones.includes(known)) throw new Error("Conversation has been deleted");
}

export async function readCachedRevision(home: string, state: ProfileState, id: string): Promise<Revision | null> {
	revisionKey(id);
	assertAvailable(state, id);
	let serialized: string;
	try {
		serialized = await readPrivate(revisionPath(home, id));
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	}
	const revision = parseRevision(JSON.parse(serialized));
	if (revision.id !== id) throw new Error("Cached revision ID mismatch");
	assertAvailable(state, id, revision.conversationId);
	return revision;
}

export async function cacheRevision(home: string, state: ProfileState, revision: Revision): Promise<void> {
	assertAvailable(state, revision.id, revision.conversationId);
	const cached = await readCachedRevision(home, state, revision.id);
	if (cached && JSON.stringify(cached) !== JSON.stringify(revision)) throw new Error("Immutable cached revision changed");
	if (!cached) await atomicWrite(revisionPath(home, revision.id), JSON.stringify(revision));
	const path = snapshotPath(home, revision.id);
	let snapshot: string | null = null;
	try {
		snapshot = await readPrivate(path);
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
	// The parsed revision authenticates the exact snapshot bytes via its content hash.
	if (snapshot !== revision.snapshot) await atomicWrite(path, revision.snapshot);
	if (!state.revisions.some((entry) => entry.id === revision.id)) {
		const { id, conversationId, parentRevisionId, project, title, createdAt } = revision;
		state.revisions.push({ id, conversationId, parentRevisionId, project, title, createdAt });
	}
}

export async function purgeDeletedCache(home: string, state: ProfileState): Promise<void> {
	if (state.tombstones.length === 0) return;
	const ids = new Set(state.revisions.filter((revision) => state.tombstones.includes(revision.conversationId)).map((revision) => revision.id));
	// Include complete blobs published just before a crash, but not yet added to state.
	for (const name of await readdir(join(home, "revisions"))) {
		if (!name.endsWith(".json") || !REVISION_PATTERN.test(name.slice(0, -5)) || ids.has(name.slice(0, -5))) continue;
		const revision = parseRevision(JSON.parse(await readPrivate(join(home, "revisions", name))));
		if (revision.id !== name.slice(0, -5)) throw new Error("Cached revision ID mismatch");
		if (state.tombstones.includes(revision.conversationId)) ids.add(revision.id);
	}
	for (const id of ids) {
		// Snapshot first: a crash must not leave an unidentifiable orphan snapshot.
		for (const path of [snapshotPath(home, id), revisionPath(home, id)]) {
			await unlink(path).catch((error: unknown) => { if (!isMissing(error)) throw error; });
		}
	}
	for (const directory of ["snapshots", "revisions"]) {
		const descriptor = await open(join(home, directory), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		try { await descriptor.sync(); }
		finally { await descriptor.close(); }
	}
}

export function catalogue(state: ProfileState): ConversationSummary[] {
	const summaries = new Map<string, ConversationSummary>();
	const parents = new Set(state.revisions.map((revision) => revision.parentRevisionId));
	const revisions = state.revisions.filter((revision) => !state.tombstones.includes(revision.conversationId))
		.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
	for (const revision of revisions) {
		let summary = summaries.get(revision.conversationId);
		if (!summary) {
			summary = { id: revision.conversationId, project: revision.project, title: revision.title, heads: [], updatedAt: revision.createdAt };
			summaries.set(revision.conversationId, summary);
		}
		if (!parents.has(revision.id)) summary.heads.push(revision.id);
		summary.project = revision.project;
		summary.title = revision.title;
		summary.updatedAt = revision.createdAt;
	}
	return [...summaries.values()].map((summary) => ({ ...summary, heads: summary.heads.sort() }))
		.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
}

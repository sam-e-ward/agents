import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MAX_SNAPSHOT_BYTES, parseSnapshot } from "../protocol.ts";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const SNAPSHOT_MAX_RETRIES = 3;
const LOCK_TIMEOUT_MS = 20_000;
const LOCK_RETRY_MS = 100;
const OWNER_PATTERN = /^([1-9][0-9]*)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.owner$/;

function hasCode(error: unknown, ...codes: string[]): boolean {
	return error !== null && typeof error === "object" && "code" in error
		&& typeof error.code === "string" && codes.includes(error.code);
}

function requireDirectory(stat: { isSymbolicLink(): boolean; isDirectory(): boolean }, path: string): void {
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Expected a non-symlink directory: ${path}`);
}

function requireFile(stat: { isFile(): boolean; isSymbolicLink(): boolean }, path: string): void {
	if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Expected a regular, non-symlink file: ${path}`);
}

export async function privateDirectory(path: string): Promise<void> {
	// A trailing slash otherwise makes lstat/O_NOFOLLOW follow a directory symlink.
	if (path.endsWith("/")) path = path.replace(/\/+$/, "") || "/";
	await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
	requireDirectory(await lstat(path), path);
	const directory = await open(path, DIRECTORY_FLAGS);
	try {
		await directory.chmod(DIRECTORY_MODE);
	} finally {
		await directory.close();
	}
}

async function checkDestination(path: string): Promise<void> {
	try {
		requireFile(await lstat(path), path);
	} catch (error) {
		if (!hasCode(error, "ENOENT")) throw error;
	}
}

export async function atomicWrite(path: string, data: string): Promise<void> {
	await checkDestination(path);
	const parent = dirname(path);
	const temporary = join(parent, `.atomic-${process.pid}-${randomUUID()}.tmp`);
	let ownsTemporary = false;
	try {
		const file = await open(temporary, "wx", FILE_MODE);
		ownsTemporary = true;
		try {
			await file.chmod(FILE_MODE);
			await file.writeFile(data, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
		await checkDestination(path);
		const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY);
		try {
			await rename(temporary, path);
			ownsTemporary = false;
			await directory.sync();
		} finally {
			await directory.close();
		}
	} finally {
		if (ownsTemporary) {
			await unlink(temporary).catch((error: unknown) => {
				if (!hasCode(error, "ENOENT")) throw error;
			});
		}
	}
}

export async function readPrivate(path: string): Promise<string> {
	const file = await open(path, READ_FLAGS);
	try {
		requireFile(await file.stat(), path);
		await file.chmod(FILE_MODE);
		return await file.readFile("utf8");
	} finally {
		await file.close();
	}
}

function sameVersion(left: BigIntStats, right: BigIntStats): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.size === right.size
		&& left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

export async function stableSnapshot(path: string): Promise<string> {
	for (let attempt = 0; attempt <= SNAPSHOT_MAX_RETRIES; attempt++) {
		try {
			const file = await open(path, READ_FLAGS);
			try {
				const before = await file.stat({ bigint: true });
				requireFile(before, path);
				const beforePath = await lstat(path, { bigint: true });
				requireFile(beforePath, path);
				if (!sameVersion(before, beforePath)) continue;
				if (before.size > BigInt(MAX_SNAPSHOT_BYTES)) throw new Error("Session exceeds the 16 MiB snapshot limit");

				// The extra byte detects growth past the limit without an unbounded readFile.
				const buffer = Buffer.allocUnsafe(MAX_SNAPSHOT_BYTES + 1);
				let length = 0;
				while (length < buffer.length) {
					const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
					if (bytesRead === 0) break;
					length += bytesRead;
				}
				if (length > MAX_SNAPSHOT_BYTES) throw new Error("Session exceeds the 16 MiB snapshot limit");

				const after = await file.stat({ bigint: true });
				const afterPath = await lstat(path, { bigint: true });
				requireFile(afterPath, path);
				if (!sameVersion(before, after) || !sameVersion(after, afterPath) || BigInt(length) !== after.size) continue;
				const snapshot = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
				parseSnapshot(snapshot);
				return snapshot;
			} finally {
				await file.close();
			}
		} catch (error) {
			if (!hasCode(error, "ENOENT")) throw error;
		}
	}
	throw new Error(`Session kept changing or disappeared while taking a snapshot: ${path}`);
}

export async function canonicalSessionFile(path: string): Promise<string> {
	const canonical = await realpath(path);
	requireFile(await lstat(canonical), canonical);
	return canonical;
}

async function removeOwnerDirectory(directory: string, owner: string): Promise<void> {
	try {
		requireDirectory(await lstat(directory), directory);
	} catch (error) {
		if (hasCode(error, "ENOENT")) return;
		throw error;
	}
	try {
		await unlink(join(directory, owner));
	} catch (error) {
		if (!hasCode(error, "ENOENT")) throw error;
	}
	try {
		await rmdir(directory);
	} catch (error) {
		if (!hasCode(error, "ENOENT", "ENOTEMPTY")) throw error;
	}
}

async function recoverDeadOwner(directory: string): Promise<void> {
	try {
		requireDirectory(await lstat(directory), directory);
		const entries = await readdir(directory);
		if (entries.length === 0) return;
		const owner = entries[0];
		const match = OWNER_PATTERN.exec(owner);
		if (entries.length !== 1 || !match) throw new Error(`Unrecognized profile lock contents: ${directory}`);
		const pid = Number(match[1]);
		if (!Number.isSafeInteger(pid) || pid > 2_147_483_647) throw new Error(`Invalid lock owner PID: ${directory}`);
		requireFile(await lstat(join(directory, owner)), join(directory, owner));
		try {
			process.kill(pid, 0);
		} catch (error) {
			if (hasCode(error, "ESRCH")) {
				// Never remove a generic owner file: a replacement lock has a different name.
				await removeOwnerDirectory(directory, owner);
			} else if (!hasCode(error, "EPERM")) {
				throw error;
			}
		}
	} catch (error) {
		if (!hasCode(error, "ENOENT")) throw error;
	}
}

export async function withProfileLock<T>(home: string, operation: () => Promise<T>): Promise<T> {
	await privateDirectory(home);
	const identity = `${process.pid}-${randomUUID()}`;
	const candidate = join(home, `.lock-candidate-${identity}`);
	const directory = join(home, ".lock");
	const owner = `${identity}.owner`;
	await mkdir(candidate, { mode: DIRECTORY_MODE });
	let acquired = false;
	try {
		await chmod(candidate, DIRECTORY_MODE);
		const ownerFile = await open(join(candidate, owner), "wx", FILE_MODE);
		try {
			await ownerFile.writeFile(JSON.stringify({ pid: process.pid }), "utf8");
		} finally {
			await ownerFile.close();
		}
		const deadline = performance.now() + LOCK_TIMEOUT_MS;
		while (!acquired) {
			try {
				// A nonempty directory cannot be replaced; an empty abandoned lock can.
				await rename(candidate, directory);
				acquired = true;
			} catch (error) {
				if (!hasCode(error, "EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR")) throw error;
				await recoverDeadOwner(directory);
				const remaining = deadline - performance.now();
				if (remaining <= 0) throw new Error(`Timed out waiting for profile lock: ${directory}`);
				await delay(Math.min(LOCK_RETRY_MS, remaining));
			}
		}
		return await operation();
	} finally {
		try {
			if (acquired) await removeOwnerDirectory(directory, owner);
		} finally {
			await removeOwnerDirectory(candidate, owner);
		}
	}
}

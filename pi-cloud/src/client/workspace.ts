import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { relativeDirectory } from "../protocol.ts";
import type { GitState, Revision } from "../protocol.ts";
import type { ProjectMapping } from "./types.ts";

const execute = promisify(execFile);

export async function canonicalDirectory(path: string): Promise<string> {
	const canonical = await realpath(resolve(path));
	if (!(await lstat(canonical)).isDirectory()) throw new Error(`Not a directory: ${path}`);
	return canonical;
}

export function isWithin(root: string, path: string): boolean {
	const subpath = relative(root, path);
	return subpath === "" || (!isAbsolute(subpath) && subpath !== ".." && !subpath.startsWith(`..${sep}`));
}

export async function resolveProjectCwd(mapping: ProjectMapping, cwd: string): Promise<{ cwd: string; relativeCwd: string }> {
	if (!isAbsolute(cwd)) throw new Error("Session working directory must be absolute");
	const root = await canonicalDirectory(mapping.root);
	if (root !== mapping.root) throw new Error("Registered project root changed; register it again");
	const canonical = await canonicalDirectory(cwd);
	if (!isWithin(root, canonical)) throw new Error("Session working directory escapes its registered project");
	return { cwd: canonical, relativeCwd: relativeDirectory(relative(root, canonical).split(sep).join("/") || ".") };
}

export async function resolveRevisionCwd(revision: Revision, mapping: ProjectMapping): Promise<string> {
	const subpath = relativeDirectory(revision.relativeCwd);
	const target = resolve(mapping.root, ...subpath.split("/"));
	return (await resolveProjectCwd(mapping, target)).cwd;
}

export async function readGitState(cwd: string): Promise<GitState | null> {
	const options = { cwd, timeout: 3_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" as const, windowsHide: true };
	try {
		const [branch, commit, status] = await Promise.all([
			execute("git", ["rev-parse", "--abbrev-ref", "HEAD"], options),
			execute("git", ["rev-parse", "HEAD"], options),
			execute("git", ["--no-optional-locks", "status", "--porcelain", "--untracked-files=normal"], options),
		]);
		return { branch: branch.stdout.trim(), commit: commit.stdout.trim(), dirty: status.stdout.length > 0 };
	} catch {
		return null;
	}
}

export async function resumeWarnings(revision: Revision, targetCwd: string): Promise<string[]> {
	const warnings: string[] = [];
	if (revision.sourceCwd !== targetCwd) warnings.push(`Working directory changed: ${revision.sourceCwd} → ${targetCwd}`);
	const target = await readGitState(targetCwd);
	if (revision.git && target) {
		if (revision.git.branch !== target.branch) warnings.push(`Git branch differs: ${revision.git.branch} → ${target.branch}`);
		if (revision.git.commit !== target.commit) warnings.push(`Git commit differs: ${revision.git.commit} → ${target.commit}`);
		if (revision.git.dirty !== target.dirty) warnings.push(`Git dirty state differs: ${revision.git.dirty} → ${target.dirty}`);
	} else if (revision.git !== target) {
		warnings.push("Git metadata is unavailable in either the source snapshot or target workspace; repository state cannot be compared");
	}
	return warnings;
}

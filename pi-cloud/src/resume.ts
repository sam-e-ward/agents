import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { atomicWrite, privateDirectory } from "./client/index.ts";
import type { ResumePlan } from "./client/index.ts";

export const CONTINUATION_TYPE = "pi-cloud.continuation";

export function continuationContext(plan: ResumePlan): string {
	return [
		"This conversation was continued from a pi-cloud snapshot on another local session.",
		`Cloud revision: ${plan.revision.id}`,
		`Previous project root: ${JSON.stringify(plan.revision.sourceRoot)}`,
		`Previous working directory: ${JSON.stringify(plan.revision.sourceCwd)}`,
		plan.workspaceMode === "anywhere"
			? "Project matching: bypassed; this directory was chosen independently of the original workspace."
			: `Current project root: ${JSON.stringify(plan.projectRoot)}`,
		`Current working directory: ${JSON.stringify(plan.targetCwd)}`,
		"Historical paths, tool results, extension state, and file contents may describe the previous machine.",
		"The workspace, Git state, dependencies, credentials, and running processes have NOT been synced.",
		"Use the current runtime environment and inspect the local workspace before acting. Do not replay old tool calls.",
		...plan.warnings.map((warning) => `Workspace warning: ${warning}`),
	].join("\n");
}

/** CLI handoff source for pi's native --fork. Never modify an immutable cached snapshot. */
export async function writeHandoffSource(home: string, plan: ResumePlan): Promise<string> {
	const directory = join(home, "handoffs");
	await privateDirectory(directory);
	const file = join(directory, `${randomUUID()}.jsonl`);
	const entry = {
		type: "custom_message", id: randomUUID(), parentId: plan.revision.leafId,
		timestamp: new Date().toISOString(), customType: CONTINUATION_TYPE,
		content: continuationContext(plan), display: true,
		details: { revisionId: plan.revision.id },
	};
	// This final entry selects the recorded active branch, not merely the last line in history.
	await atomicWrite(file, `${plan.revision.snapshot}${JSON.stringify(entry)}\n`);
	return file;
}

/** Repos (path prefixes, covering all worktrees) where the infra tools (vm_*, opensearch) are enabled. */
const INFRA_TOOL_ROOTS = ["/var/www/countfire/"];

export function infraToolsEnabled(cwd: string = process.cwd()): boolean {
	const dir = cwd.endsWith("/") ? cwd : `${cwd}/`;
	return INFRA_TOOL_ROOTS.some((root) => dir.startsWith(root));
}

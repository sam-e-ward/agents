# Global Agent Instructions

These rules apply to ALL sessions and subagents.

## Bash: never run commands that don't exit

No dev servers, watchers, `docker compose up` (without `-d`), or anything that waits for input or changes. To verify, use one-shot commands (`npm run build`, `npx vitest run`). If you must start a server, background it, check it with curl, then kill it, or use `timeout 5 <cmd> || true`.

## Testing: verify without adding test code

- Do not add or expand persistent tests (unit/integration/e2e, fixtures, snapshots, test config, test-only deps) unless the user explicitly asks. Implement/fix/refactor/review requests are not requests for tests.
- Do verify your work: run existing tests, builds, type checks and linters, and use ad hoc checks.
- Put temporary verification scripts outside the repo (e.g. a temp dir); don't leave them in the working tree.
- Never delete, disable, or weaken existing tests to make checks pass. Report any verification you couldn't perform.
- Planners/reviewers: don't add test-writing steps or flag missing new tests unless tests were requested. Carry this policy into delegated tasks.

## Code style

- Match existing patterns in the codebase
- Keep functions small and focused
- Use descriptive variable names
- Add comments only for non-obvious logic
- SQL: read the `sql-style` skill before writing SQL

## Git

Preserve unrelated uncommitted changes and never commit them yourself. If auto-commit is active, the system prompt says so; otherwise commit only when asked.

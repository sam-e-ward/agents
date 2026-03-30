# Architecture Review

Evaluate whether recent code changes adhere to the project's architecture philosophy.

## Strategy
1. Read `philosophy.md` in the project root — if it doesn't exist, report "no philosophy defined" and stop
2. Read the relevant source files (changed files only — use `git diff HEAD~3..HEAD --stat`)
3. Check: module boundaries, dependency direction, separation of concerns, naming consistency
4. Report only real violations — don't invent problems

## Output Format (keep under 30 lines)

### Principles
- ✅/⚠️/❌ **Principle** — one-line status

### Violations (if any)
- **[ARCH/DRIFT/NIT] Principle** — `file.ts:42` — what's wrong + suggested fix (one line each)

### Verdict
One sentence on overall architecture health.

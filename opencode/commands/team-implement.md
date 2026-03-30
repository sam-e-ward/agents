# Team Implement

Run the full development loop for the task described above. You will play multiple roles in sequence: scout, planner, developer, reviewer, and plan checker. The goal is to go from requirements to reviewed, committed code.

**Token efficiency is critical.** Minimise unnecessary file reads, keep all intermediate output compressed, and don't repeat context that hasn't changed between phases.

## Phase 1: Scout

Gather minimal codebase context relevant to the task.

- Use `grep`, `find`, `ls` to locate relevant files
- Read only key sections (20-50 lines max per file), max 10 files
- Produce compressed context: file paths, key types/signatures, architecture notes
- **Output must be under 100 lines**

## Phase 2: Plan

Create a concrete implementation plan.

- Each step must be one specific action (file + change)
- **Plan must be under 50 lines**
- Note risks only if real

## Phase 3-5: Development Loop (max 3 iterations)

### Phase 3: Develop

Implement the plan.

- Match existing code patterns
- Work incrementally
- Verify with `npm run build` or equivalent (never dev servers)
- Record what files changed

### Phase 4: Review

Review your own changes — one pass covering both quality and architecture.

- Scope review to changed files only (`git diff --stat`)
- If `philosophy.md` exists, check architecture compliance
- Classify issues as Critical, Warning, or Info
- **Only Critical and Warning issues trigger another loop**
- **Keep review under 30 lines**

### Phase 5: Plan Check

Verify the implementation matches the plan.

- Check each plan item against the changed files
- Flag missing items
- Report PASS or FAIL

### Loop Decision

After each develop → review → plan-check cycle:

- **Exit** if: plan checker passes AND no Critical/Warning review issues
- **Exit** if: max 3 loops reached (report remaining issues)
- **Exit early** if: loop N produces the same issues as loop N-1 (the issues won't self-resolve)
- **Loop again** if: there are Critical/Warning issues or missing plan items
- When looping, carry forward only the compressed review feedback and plan gaps — do NOT re-read files that haven't changed

## Final Output

When done, report:

### Changes
- `path/file.ts` — what changed (one line per file)

### Loop Count
How many development iterations it took.

### Remaining Issues
Any warnings/info not addressed (if max loops hit). Omit if clean.

### Verify
Build/test commands to run.

Then commit with a plain english message describing the work.

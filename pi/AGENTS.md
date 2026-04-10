# Global Agent Instructions

These rules apply to ALL sessions and subagents.

## Bash Commands: Avoid Long-Running Processes

**CRITICAL:** Never run commands that don't exit on their own. This includes:

- `npm run dev` / `yarn dev` / `pnpm dev` — dev servers
- `npm start` / `yarn start` — app servers
- `node server.js` / `python manage.py runserver` — any server
- `ng serve` / `vite` / `webpack serve` — build watchers with servers
- `docker compose up` (without `-d`) — container orchestration
- Any command that watches files and waits for changes

### What to do instead

1. **If you need to verify a build runs:** Use `npm run build` (compiles and exits)
2. **If you need to run tests:** Use `npm test` or `npx vitest run` (not `vitest watch`)
3. **If you must start a dev server:** Use background mode with timeout:
   ```bash
   timeout 5 npm run dev 2>&1 || true
   ```
   Or redirect and background:
   ```bash
   nohup npm run dev > /dev/null 2>&1 &
   sleep 2
   ```
4. **If you need to verify the app loads:** Start it in background, check with curl, then kill it:
   ```bash
   npm run dev &
   DEV_PID=$!
   sleep 3
   curl -s http://localhost:5173 | head -20
   kill $DEV_PID
   ```

### Why this matters

Long-running processes never return control, causing the agent to hang indefinitely. Always ensure your bash commands will exit.

## Code Style

- Match existing patterns in the codebase
- Keep functions small and focused
- Use descriptive variable names
- Add comments only for non-obvious logic

## Git Workflow

**IMPORTANT:** Follow this workflow for every session that involves code changes. This applies globally across all repositories.

### Before starting work

1. Run `git status` to check for uncommitted changes.
2. If there are uncommitted changes:
   - Read the diff (`git diff` and `git diff --staged`)
   - Summarise the changes and ask: **"There are existing uncommitted changes that [summary]. Commit these and continue?"**
   - If the user says **no**, stop work entirely. Do not proceed.
   - If the user says **yes**, stage and commit those changes with an `AI:` prefixed plain english message, then continue with the requested work.

### After completing work

1. Stage all changes related to the work you just did.
2. Commit with a message starting with `AI:` followed by a short, plain english description of what was done. No conventional commits — just the `AI:` prefix and a clear sentence.
3. Tell the user what was committed.

### On follow-up prompts

When the user sends a follow-up after you've just committed work, classify their intent before doing anything. If the intent is **not clear**, ask:

> How would you like to proceed?
> 1. **Fix it** — I'll undo the last commit, apply the fix, and re-commit
> 2. **Build on it** — I'll keep the commit and start new work on top
> 3. **Scrap it** — I'll stash the changes and revert to before

Then act based on the classification:

#### Fix it (user reports a bug, error, or wants a different approach)
1. `git reset --soft HEAD~1` to undo the commit but keep the changes
2. Make the requested fixes/improvements
3. Stage everything and commit with an updated message that reflects the final state of the work
4. If the user follows up with *another* fix, repeat this process — keep amending into one logical commit until they move on

#### Build on it (user moves to new/related work)
1. Leave the previous commit in place
2. Do the new work
3. Commit as a separate, new commit

#### Scrap it (user rejects the work entirely)
1. `git stash push -m "pi: [description of what was done]"` to preserve the changes without committing
2. Summarise what was stashed so the user knows what's there if they want it later
3. Do **not** proceed with further work unless asked

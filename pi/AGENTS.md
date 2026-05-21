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

### SQL

- All lowercase — keywords, functions, aliases, types (`select`, `count`, `coalesce`, `integer`)
- 4-space indentation
- Clause keywords (`select`, `from`, `where`, `group by`, `order by`, `having`, `limit`) on their own line at base indent; their contents indented one level below
- Joins at the same indent level as the first table inside the `from` block
- One column/expression per line in `select`, `order by`, `group by`
- One condition per line in `where` (with `and`/`or` at line start, indented)
- Trailing commas
- Quoted aliases in lowercase (`"bad fit"`, not `"Bad fit"`)
- `distinct on` indented under `select`, not on the keyword line
- CTEs: `with name as (` then body indented, closing `)` at CTE indent level

Example:

```sql
with team_sizes as (
    select
        distinct on (c.organisation_id)
        c.organisation_id,
        te.teamsize
    from
        trial_enquiry te
        join contact c on c.rt_id = te.rt_id
    where
        te.teamsize is not null
    order by
        c.organisation_id,
        te.created_at asc
)
select
    to_char(md.initial_contact_date, 'yyyy-mm') as date_created_month,
    count(*) filter (where o.lead_status = 'bad_fit') as "bad fit",
    count(*) as "grand total"
from
    merged_deal md
    join organisation o on o.id = md.organisation_id
    left join team_sizes ts on ts.organisation_id = md.organisation_id
group by
    grouping sets (
        (to_char(md.initial_contact_date, 'yyyy-mm')),
        ()
    )
order by
    date_created_month nulls first
```

## Git Workflow

**Commits are handled automatically** by the `auto-commit` extension. It runs after every agent response, detects edited files, and commits them with an `AI:` prefix. **Do NOT manually stage or commit changes.**

- When editing the same repo in consecutive responses, the extension asks the user whether to **amend** (fold into previous commit) or create a **new commit**.
- The `/scrap` command undoes the last auto-commit and stashes the changes.

### Before starting work

1. Run `git status` to check for uncommitted changes.
2. If there are uncommitted changes:
   - Read the diff (`git diff` and `git diff --staged`)
   - Summarise the changes and ask: **"There are existing uncommitted changes that [summary]. Commit these and continue?"**
   - If the user says **no**, stop work entirely. Do not proceed.
   - If the user says **yes**, stage and commit those changes with `git commit -am "AI: <description>"`, then continue with the requested work.

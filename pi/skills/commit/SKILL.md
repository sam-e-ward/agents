---
name: commit
description: "Read this skill before making git commits"
---

Create a git commit for the current changes using a plain english description.

## Format

Start with `AI:` followed by a short, clear sentence describing what was done. No conventional commits format, no trailing period.

Good: `AI: Add user authentication with session tokens`
Good: `AI: Fix search returning duplicate results`
Bad: `feat(auth): add user authentication`
Bad: `misc changes`
Bad: `Add user authentication` (missing AI: prefix)

## Notes

- Always start the message with `AI:` prefix.
- Do NOT include other prefixes like `feat:`, `fix:`, `chore:`, etc.
- Do NOT add sign-offs (no `Signed-off-by`).
- Only commit; do NOT push.
- If it is unclear whether a file should be included, ask the user which files to commit.
- Treat any caller-provided arguments as additional commit guidance. Common patterns:
  - Freeform instructions should influence the commit message.
  - File paths or globs should limit which files to commit. If files are specified, only stage/commit those unless the user explicitly asks otherwise.
  - If arguments combine files and instructions, honor both.

## Steps

1. Infer from the prompt if the user provided specific file paths/globs and/or additional instructions.
2. Review `git status` and `git diff` to understand the current changes (limit to argument-specified files if provided).
3. If there are ambiguous extra files, ask the user for clarification before committing.
4. Stage only the intended files (all changes if no files specified).
5. Run `git commit -m "<message>"`.

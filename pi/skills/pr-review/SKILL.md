---
name: pr-review
description: Four-stage PR review combining high-level aims, structural analysis (based on A Philosophy of Software Design), bug detection, and root-cause correlation. Use when reviewing pull requests or branches.
---

# PR Review

A structured, four-stage review of a pull request. Each stage builds on the previous one. Do not skip stages.

## Setup

Determine the diff to review:

1. If the user provides a branch name or commit range, use that.
2. Otherwise run `git log --oneline -10` and ask the user which commits constitute the PR.

Once you know the range, gather the diff:

```bash
git diff <base>..<head> --stat
git diff <base>..<head>
```

Read every changed file in full (not just the diff) so you understand the surrounding context.

---

## Stage 1 — Intent & Aims

Summarise what the PR is trying to achieve in 2–4 sentences. Identify:

- **Goal** — what user-visible or system-level behaviour changes.
- **Approach** — the strategy chosen (new module, refactor, config change, etc.).
- **Scope** — what's touched and what's deliberately left alone.

If the PR has a description or linked issue, incorporate that. If intent is unclear, say so — unclear intent is itself a finding.

---

## Stage 2 — Structure (A Philosophy of Software Design)

This is the core of the review. Read [the reference guide](references/structure.md) before starting this stage.

Analyse the PR's structural changes through the lens described in the reference. For every finding, you must:

1. **Name the specific concept** from the reference (e.g. "Shallow module", "Information leakage", "Temporal decomposition").
2. **Quote or point to the exact code** (file + line range) that exhibits it.
3. **Explain why it matters in this PR's context** — not in the abstract.
4. **Suggest a concrete alternative** with enough detail that the author could implement it without further clarification.

### What to look for

Work through these questions in order. Skip any that genuinely don't apply.

**Modules & depth**
- Do new functions/classes/modules earn their existence? Is the interface simpler than the implementation, or is it a shallow wrapper?
- Are there pass-through methods that add no new abstraction?
- Could any thin wrappers be eliminated by letting callers use the underlying API directly?

**Information hiding & leakage**
- Does any design decision (file format, protocol detail, algorithm choice) leak across module boundaries?
- Are two modules jointly aware of something that only one should know?
- Does temporal decomposition (splitting by "what happens first/second") force knowledge of ordering across boundaries?

**Interfaces & layers**
- Does each layer provide a genuinely different abstraction, or do adjacent layers mirror each other's signatures?
- Are new parameters pass-through variables threading high-level concerns to low-level code?
- Would a context object or existing shared state eliminate pass-through?

**Complexity trajectory**
- Does this PR pull complexity downward (hiding it behind a simpler interface) or push it upward (forcing callers to handle more)?
- Are configuration parameters being added where good defaults would suffice?
- Are errors being defined out of existence, or are new exception paths being introduced that callers must handle?

**Comments & obviousness**
- Do interface comments capture *what and why* (not *how*)?
- Is any non-obvious code left uncommented?
- Do any comments just restate the code?

**Red flags checklist** (cite only those that actually appear):
- Shallow module
- Information leakage
- Temporal decomposition
- Pass-through method
- Pass-through variable
- Repetition
- Special-general mixture
- Conjoined methods
- Comment repeats code
- Implementation detail in interface docs
- Vague name
- Hard to pick name
- Hard to describe
- Non-obvious code

### Output format for Stage 2

For each finding:

```
**[RED-FLAG or STRUCTURE] <concept name>** — `path/to/file.ts:42-58`
<What's happening and why it's a problem in this context>
→ Alternative: <concrete suggestion>
```

If the structure is clean, say so explicitly and note what's done well.

---

## Stage 3 — Bugs

Look for actual defects. Not style issues — things that would cause wrong behaviour at runtime.

- Off-by-one errors, null/undefined access, race conditions
- Incorrect boolean logic, missing edge cases
- Resource leaks (unclosed handles, missing cleanup)
- Security issues (injection, auth bypass, data exposure)
- Broken error handling (swallowed exceptions, wrong error types)
- API contract violations (wrong return type, missing required fields)

For each bug:

```
**[BUG] Title** — `path/to/file.ts:42`
<What breaks and under what conditions>
→ Fix: <concrete fix>
```

If no bugs found, say so.

---

## Stage 4 — Correlation

This is where the review comes together. Look back at Stages 2 and 3 and identify which bugs are *caused by* or *enabled by* structural problems.

For example:
- A null-access bug might exist because information leakage forced the caller to know about an internal state it shouldn't manage.
- An edge-case miss might stem from a shallow module that didn't fully encapsulate its responsibility.
- A race condition might result from temporal decomposition spreading sequence-dependent logic across modules.

For each correlation:

```
**[ROOT-CAUSE] <Bug title> ← <Structure finding>**
<How the structural problem led to or enabled the bug>
→ Fixing the structure would also fix the bug: <brief explanation>
```

If no correlations exist, say so — not every bug is structural.

---

## Final Summary

End with a short summary (under 10 lines):

1. One sentence on the PR's intent and whether the approach is sound.
2. Count of structural findings, bugs, and correlations.
3. The single most important thing to address before merging (if any).
4. An overall recommendation: **approve**, **approve with nits**, **request changes**, or **rethink approach**.

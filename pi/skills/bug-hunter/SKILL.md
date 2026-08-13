---
name: bug-hunter
description: Finds concrete runtime defects in a pull request, commit range, uncommitted change, or code snapshot. Use for a focused bug-only review, especially when structural review is unnecessary; the pr-review skill invokes it for its bug stage.
---

# Bug Hunter

Perform a focused, evidence-led review for defects introduced by a change. Review logic and contracts, not code style or architecture. Prefer no finding to a speculative finding.

## Establish the review scope

1. If the user gives a branch, commit range, PR, or paths, use it.
2. Otherwise run `git log --oneline -10` and ask which commits to review.
3. For a commit range, inspect both the summary and patch:

```bash
git diff <base>..<head> --stat
git diff <base>..<head>
```

4. Read every changed file in full. Then follow each changed symbol into the smallest relevant set of callers, callees, types, schemas, configuration, and boundary adapters.
5. Read project instructions and documentation that define affected behaviour. Infer contracts from types, validation, error handling, existing call sites, and analogous code; do not invent requirements.

For a snapshot review with no diff, state that limitations explicitly and restrict findings to defects that are independently demonstrable from the code.

## Review method

### 1. Build an impact map

For every behavioural change, identify:

- **Inputs:** request fields, arguments, environment/configuration, persisted data, queue messages, or external responses.
- **Assumptions and invariants:** required/nullability rules, ownership/authorization, units, ordering, uniqueness, state preconditions, and error semantics.
- **Flow:** transformations, branches, early exits, async boundaries, retries, side effects, and outputs.
- **Consumers:** callers, API clients, serializers, persistence, caches, events, and user-visible results.

Trace actual values and states through this path. Do not stop at the changed line: look for the first consumer that depends on the previous behaviour and the outcome it now receives.

### 2. Perform independent bug passes

Use each applicable pass. Search for a small number of high-confidence defects, not a checklist of hypothetical risks.

**Data and control flow**
- Reversed or incomplete conditions, unreachable/missing branches, incorrect defaults, stale values, and mismatched return values.
- Null/empty/absent values; zero, negative, first/last, duplicate, and oversized values; precision, units, dates, time zones, and pagination boundaries.
- Mutation, aliasing, accidental shared state, or a value used before it is initialized or after it becomes invalid.

**Contracts and boundaries**
- Request/response, type, schema, serialization, database, event, configuration, and version-compatibility mismatches.
- Validation that permits invalid values, rejects valid values, or happens after an unsafe side effect.
- Changed semantics that callers, clients, migrations, or persisted records still interpret using the old contract.

**State, failure, and lifecycle**
- Invalid state transitions; retry/non-idempotency issues; duplicate or lost writes.
- Exceptions, rejected promises, cancellation, and partial failures that leave incorrect state or claim success.
- Missing cleanup, rollback, transaction boundaries, resource release, or compensation after a side effect.

**Ordering, concurrency, and caching**
- Races between reads and writes, stale reads, non-atomic check-then-act logic, ordering assumptions, and async work not awaited.
- Cache invalidation/key/tenant-scope mistakes and inconsistency between cached, persisted, and emitted state.

**Security and isolation**
- Authorization or tenant scope lost across a new path; data exposure in responses, logs, errors, or cache keys.
- Injection, unsafe redirects/fetches, path traversal, insecure deserialization, and handling of untrusted input.

Compare changed logic against nearby code handling the same domain case. A difference is evidence to investigate, not automatically a bug.

### 3. Validate each candidate with a failure trace

Report a bug only after constructing an explicit trace:

1. **Conditions:** concrete input, state, actor, ordering, or external outcome that activates it.
2. **Path:** the exact code path through the changed code and relevant consumers.
3. **Failure:** the incorrect observable result, invalid state, security impact, or broken contract.
4. **Introduced change:** why the reviewed change causes it rather than merely exposing a pre-existing issue.

Use existing tests, type checks, static analysis, logs, or documentation only when present and helpful as corroboration. Do not assume automated tests exist, and do not make test execution a prerequisite for a finding. Do not write tests or modify code unless the user explicitly asks.

Discard candidates that depend on an unstated assumption, intentional semantic change, or a failure you cannot trace.

## Findings

Report only runtime defects. Do not report style, naming, maintainability, missing tests, or structural concerns; those belong in other reviews.

For each finding:

```markdown
**[BUG] Title** — `path/to/file.ts:42-47`
**Conditions:** <specific triggering input or state>
**Failure path:** <changed code → relevant consumer → incorrect result>
**Impact:** <what breaks, leaks, corrupts, or becomes unavailable>
→ Fix: <concrete minimal correction>
```

Keep locations in the reviewed diff where possible. A finding may cite unchanged code only to establish the failure path.

## Final result

End with:

```markdown
### Bug-hunt result
- Findings: <count>
- Confidence: <high/medium, based on the evidence available>
- Scope note: <only if the diff, contract, or runtime context limited verification>
```

If there are no qualifying defects, say **“No verified bugs found.”** This means the review found no defect that could be traced from conditions to an incorrect outcome; it is not a guarantee of correctness.

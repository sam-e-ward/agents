---
name: native-web-search
description: "Use when you need to research something on the internet. Delegates to a fast, cheap subagent to preserve main context."
---

# Native Web Search

Delegate internet research to the `web-researcher` subagent. This keeps the research off the main context and uses a faster, cheaper model.

## How to use

Invoke the subagent with a specific query and purpose:

```
@web-researcher latest release of vite and any breaking changes — purpose: preparing a migration
@web-researcher how to configure ESM output in tsup — purpose: fixing build config
@web-researcher anthropic claude haiku pricing — purpose: estimating agent costs
```

## What the subagent does

- Fetches 2–3 authoritative sources (docs, release pages, registries)
- Cross-checks facts and flags disagreements between sources
- Returns 3–7 key findings with full canonical URLs
- Recommends which source to trust first

## When to use this skill

- Looking up current library versions or changelogs
- Checking API docs or compatibility tables
- Researching error messages or known issues
- Any question where you need current, sourced information rather than training data

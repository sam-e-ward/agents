---
name: native-web-search
description: "Search the web with a supported native provider or best-effort DuckDuckGo fallback. Use for quick research; check URLs and distinguish unavailable search from no results."
---

# Native Web Search

Use this skill to search the web and get concise research summaries with explicit full URLs.

## Script

- `search.mjs` — Node.js script that performs the search

## Setup

DuckDuckGo Lite/HTML uses Node's built-in `fetch` (Node >= 18); no npm install is needed. Native provider search requires compatible pi-ai and valid credentials.

## Usage

Run from this skill directory:

```bash
node search.mjs "<what to search>" --purpose "<why you need this>"
```

Examples:

```bash
node search.mjs "latest python release" --purpose "update dependency notes"
node search.mjs "vite 7 breaking changes" --purpose "prepare migration checklist"
```

Optional flags:

- `--provider auto|duckduckgo|openai-codex|anthropic|openrouter|deepseek|mistral`
- `--model <model-id>`
- `--timeout <ms>`
- `--json`

## How it works

The script auto-detects the best search provider:

1. **With Anthropic/OpenRouter/OpenAI-Codex**: Uses the provider's native web search tool (most accurate)
2. **With DeepSeek/Mistral/other providers**: Tries DuckDuckGo Lite, then DDG HTML (no API key, but both can rate-limit/challenge the same IP).
3. **In auto mode**, if native search fails (including an incompatible OAuth helper), warns on stderr and tries DDG. Explicit `--provider` failures remain visible.

Neither path guarantees availability. HTTP errors, unparseable/challenge pages and timeouts are **failures**, not evidence of zero results. If DDG is unavailable, try an authenticated native provider, relevant primary-source APIs (`scout.mjs` for HN/Stack Exchange), or browser verification. Do not invent results or imply search coverage when a source failed.

## Output expectations

The script returns search results with:
- Full canonical URLs (`https://...`) for each finding
- Brief snippets from each result
- Number of results found

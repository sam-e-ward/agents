---
name: native-web-search
description: "Trigger native web search. Use when you need quick internet research with concise summaries and full source URLs. Works with any LLM provider via DuckDuckGo fallback."
---

# Native Web Search

Use this skill to search the web and get concise research summaries with explicit full URLs.

## Script

- `search.mjs` — Node.js script that performs the search

## Setup

The skill requires `duck-duck-scrape` for the fallback search. This is already installed in `node_modules/`.

If you encounter module errors, run:
```bash
cd /path/to/skills/native-web-search && npm install
```

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
2. **With DeepSeek/Mistral/other providers**: Falls back to **DuckDuckGo Lite** search (free, no API key needed, always works)

This means web search works regardless of which LLM provider you're using.

## Output expectations

The script returns search results with:
- Full canonical URLs (`https://...`) for each finding
- Brief snippets from each result
- Number of results found

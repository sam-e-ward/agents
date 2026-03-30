# Authentication

OpenCode stores provider credentials at `~/.local/share/opencode/auth.json`.

## Setting up via CLI

```bash
opencode providers login
```

This walks you through adding API keys interactively.

## Manual configuration

Create or edit `~/.local/share/opencode/auth.json`:

```json
{
  "anthropic": {
    "type": "api",
    "key": "sk-ant-..."
  },
  "openai": {
    "type": "api",
    "key": "sk-..."
  }
}
```

## Provider configuration in project config

You can also set provider API keys in `.opencode.json` at the project root:

```json
{
  "providers": {
    "anthropic": {
      "apiKey": "sk-ant-..."
    },
    "openai": {
      "apiKey": "sk-..."
    }
  }
}
```

Environment variables are also supported — opencode reads `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc. automatically via its `OPENCODE_` env prefix convention.

## Checking configured providers

```bash
opencode providers list
```

Only include the providers you need.

/**
 * Shared utility for resolving auxiliary LLM models used by pi extensions.
 *
 * Reads from a machine-local config file at ~/.pi/agent/tool-models.json.
 * This config is never committed to a repo — it's per-machine, per-environment.
 *
 * Config format:
 * {
 *   "branch-context": { "provider": "deepseek", "id": "deepseek-v4-flash" },
 *   "auto-commit":    { "provider": "openrouter", "id": "deepseek/deepseek-v4-flash" },
 *   "loop":           { "provider": "anthropic", "id": "claude-haiku-4-5" }
 * }
 *
 * Each key is a tool/extension name. If a tool isn't listed, the extension
 * falls back to its built-in default candidates.
 *
 * The file is optional — if it doesn't exist, everything works with defaults.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const CONFIG_PATH = path.join(getAgentDir(), "tool-models.json");

export interface ToolModelConfig {
    provider: string;
    id: string;
}

type ToolModelsConfig = Record<string, ToolModelConfig>;

let _config: ToolModelsConfig | undefined;
let _configLoaded = false;

function loadConfig(): ToolModelsConfig {
    if (!_configLoaded) {
        try {
            const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") {
                _config = parsed as ToolModelsConfig;
            }
        } catch {
            // File doesn't exist or is invalid — that's fine
        }
        _configLoaded = true;
    }
    return _config ?? {};
}

/** Resolve a model for a given tool.
 *
 * 1. If tool-models.json has an entry for `toolName`, try that model first.
 * 2. Fall back to the provided `defaultCandidates` (provider/id pairs tried in order).
 * 3. If nothing works, return undefined.
 *
 * Returns { provider, id } on success, or undefined if no model is available.
 */
export async function resolveToolModel(
    toolName: string,
    ctx: ExtensionContext,
    defaultCandidates: ReadonlyArray<readonly [string, string]>,
): Promise<{ provider: string; id: string } | undefined> {
    const config = loadConfig();

    // Build the candidate list: config entry first, then defaults.
    const candidates: Array<[string, string]> = [];
    const entry = config[toolName];
    if (entry) {
        candidates.push([entry.provider, entry.id]);
    }
    for (const c of defaultCandidates) {
        candidates.push([c[0], c[1]]);
    }

    for (const [provider, id] of candidates) {
        const model = ctx.modelRegistry.find(provider, id);
        if (!model) continue;
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (auth.ok) return { provider, id };
    }

    return undefined;
}

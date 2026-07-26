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
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

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

function writeConfig(config: ToolModelsConfig): void {
    try {
        fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4) + "\n");
        // Invalidate cache so next resolveToolModel picks up changes
        _config = config;
        _configLoaded = true;
    } catch {
        // Best-effort; ignore write failures.
    }
}

/**
 * Register the /tool-models command.
 * Call this from any extension that imports this module.
 */
export function registerToolModelsCommand(pi: ExtensionAPI): void {
    pi.registerCommand("tool-models", {
        description: "Configure which models extensions use for auxiliary tasks",
        handler: async (_args, ctx) => {
            await toolModelsUI(ctx);
        },
    });
}

async function toolModelsUI(ctx: ExtensionCommandContext): Promise<void> {
    const config = { ...loadConfig() };
    const availableModels = ctx.modelRegistry.getAvailable();

    // Build the model choice list
    const modelChoices: SelectItem[] = [
        {
            value: "__defaults__",
            label: "(use defaults)",
            description: "Remove config entry — fall back to built-in defaults",
        },
    ];
    for (const m of availableModels) {
        const key = `${m.provider}/${m.id}`;
        modelChoices.push({
            value: key,
            label: key,
            description: m.name !== m.id ? m.name : undefined,
        });
    }

    while (true) {
        const toolNames = Object.keys(config).sort();

        if (toolNames.length === 0) {
            const add = await ctx.ui.confirm(
                "No tool models configured",
                "Add a tool model entry?",
            );
            if (!add) return;
            const name = await ctx.ui.input("Tool name (e.g. branch-context):");
            if (!name?.trim()) return;
            const modelKey = await pickModel(ctx, modelChoices);
            if (!modelKey) return;
            if (modelKey === "__defaults__") continue;
            const [provider, ...idParts] = modelKey.split("/");
            config[name.trim()] = { provider, id: idParts.join("/") };
            writeConfig(config);
            continue;
        }

        const items: SelectItem[] = toolNames.map((name) => {
            const entry = config[name];
            const label = `${name} → ${entry.provider}/${entry.id}`;
            return { value: name, label };
        });

        const selected = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
            const container = new Container();
            container.addChild(
                new Text(theme.fg("accent", theme.bold("Tool Model Configuration")), 1, 1),
            );
            container.addChild(
                new Text(theme.fg("dim", "Enter: change model  Del: remove  a: add tool  Esc: done"), 1, 0),
            );

            const list = new SelectList(items, Math.min(items.length + 3, 16), {
                selectedPrefix: (text) => theme.fg("accent", text),
                selectedText: (text) => theme.fg("accent", text),
                description: (text) => theme.fg("muted", text),
                scrollInfo: (text) => theme.fg("dim", text),
                noMatch: (text) => theme.fg("warning", text),
            });

            list.onSelect = (item) => done(item.value);
            list.onCancel = () => done(null);

            // Capture keypresses before list for Delete and 'a'
            const origHandleInput = list.handleInput.bind(list);
            list.handleInput = (data: string) => {
                if (data === "\x7f" || data === "\b") {
                    // Delete/Backspace — remove selected tool
                    const active = list.filteredItems[list.selectedIndex];
                    if (active) {
                        done(`__delete__:${active.value}`);
                        return;
                    }
                }
                if (data === "a" || data === "n") {
                    done("__add__");
                    return;
                }
                origHandleInput(data);
                tui.requestRender();
            };

            container.addChild(list);

            return {
                render(width: number) {
                    return container.render(width);
                },
                invalidate() {
                    container.invalidate();
                },
                handleInput(data: string) {
                    list.handleInput(data);
                    tui.requestRender();
                },
            };
        });

        if (selected === null) return; // Esc

        if (selected === "__add__") {
            const name = await ctx.ui.input("Tool name (e.g. my-extension):");
            if (!name?.trim()) continue;
            const modelKey = await pickModel(ctx, modelChoices);
            if (!modelKey) continue;
            if (modelKey === "__defaults__") continue;
            const [provider, ...idParts] = modelKey.split("/");
            config[name.trim()] = { provider, id: idParts.join("/") };
            writeConfig(config);
            continue;
        }

        if (selected.startsWith("__delete__:")) {
            const toolName = selected.slice("__delete__:".length);
            delete config[toolName];
            writeConfig(config);
            continue;
        }

        // Change model for selected tool
        const modelKey = await pickModel(ctx, modelChoices);
        if (!modelKey) continue;
        if (modelKey === "__defaults__") {
            delete config[selected];
        } else {
            const [provider, ...idParts] = modelKey.split("/");
            config[selected] = { provider, id: idParts.join("/") };
        }
        writeConfig(config);
    }
}

async function pickModel(
    ctx: ExtensionCommandContext,
    choices: SelectItem[],
): Promise<string | null> {
    return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(
            new Text(theme.fg("accent", theme.bold("Select model")), 1, 1),
        );
        container.addChild(
            new Text(theme.fg("dim", "Enter: confirm  Esc: cancel"), 1, 0),
        );

        const list = new SelectList(choices, Math.min(choices.length + 2, 16), {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
        });

        list.onSelect = (item) => done(item.value);
        list.onCancel = () => done(null);

        container.addChild(list);

        return {
            render(width: number) {
                return container.render(width);
            },
            invalidate() {
                container.invalidate();
            },
            handleInput(data: string) {
                list.handleInput(data);
                tui.requestRender();
            },
        };
    });
}

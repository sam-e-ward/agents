import { promises as fs } from "node:fs";
import { join } from "node:path";
import { DynamicBorder, getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

export const COMPLEXITIES = ["low", "med", "high"] as const;
export type Complexity = (typeof COMPLEXITIES)[number];

const CONFIG_FILE = "subagent-models.json";
const SELECTION_TIMEOUT_MS = 10_000;

export type ModelSelection = {
	model: string;
	thinkingLevel?: string;
};

type ModelDefaults = Partial<Record<Complexity, ModelSelection>>;

type ModelOption = ModelSelection & {
	label: string;
	description: string;
};

function modelKey(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

export function formatModelSelection(selection: ModelSelection): string {
	return selection.thinkingLevel ? `${selection.model}:${selection.thinkingLevel}` : selection.model;
}

function getConfigPath(): string {
	return join(getAgentDir(), CONFIG_FILE);
}

async function loadDefaults(): Promise<ModelDefaults> {
	try {
		const data = JSON.parse(await fs.readFile(getConfigPath(), "utf8")) as { defaults?: ModelDefaults };
		return data.defaults ?? {};
	} catch {
		return {};
	}
}

async function saveDefaults(defaults: ModelDefaults): Promise<void> {
	await fs.writeFile(getConfigPath(), `${JSON.stringify({ defaults }, null, "\t")}\n`, "utf8");
}

function getModelOptions(ctx: ExtensionContext): ModelOption[] {
	return ctx.scopedModels.map(({ model, thinkingLevel }) => {
		const selection = { model: modelKey(model), thinkingLevel };
		return {
			...selection,
			label: formatModelSelection(selection),
			description: model.name && model.name !== model.id ? model.name : "",
		};
	});
}

function findDefault(options: ModelOption[], defaults: ModelDefaults, complexity: Complexity, ctx: ExtensionContext): ModelOption | undefined {
	const configured = defaults[complexity];
	if (configured) {
		const match = options.find((option) => formatModelSelection(option) === formatModelSelection(configured));
		if (match) return match;
	}

	const currentModel = ctx.model ? modelKey(ctx.model) : undefined;
	const current = options.find((option) => option.model === currentModel);
	return current ?? options[0];
}

export function classifyTask(task: string): Complexity {
	const normalized = task.toLowerCase();
	const highSignals = /\b(architect(?:ure|ural)?|implement|migrat|refactor|redesign|debug|investigat|security|performance|concurren|integrat|database|deploy|multi[- ]?(?:file|step|service)|root cause)\b/g;
	const lowSignals = /\b(find|locate|list|identify|summari[sz]e|explain|inspect|check|confirm|count)\b/g;
	const highCount = normalized.match(highSignals)?.length ?? 0;
	const lowCount = normalized.match(lowSignals)?.length ?? 0;

	if (highCount > 0) return "high";
	if (lowCount > 0 && normalized.length < 220) return "low";
	return "med";
}

export async function selectModelForTask(
	ctx: ExtensionContext,
	task: string,
	complexity: Complexity,
): Promise<{ selection?: ModelSelection; complexity: Complexity }> {
	const options = getModelOptions(ctx);
	if (options.length === 0) return { complexity };

	const defaults = await loadDefaults();
	let changed = false;
	for (const level of COMPLEXITIES) {
		const fallback = findDefault(options, defaults, level, ctx);
		if (fallback && !defaults[level]) {
			defaults[level] = { model: fallback.model, thinkingLevel: fallback.thinkingLevel };
			changed = true;
		}
	}
	if (changed) await saveDefaults(defaults);
	const defaultOption = findDefault(options, defaults, complexity, ctx);
	if (!defaultOption || ctx.mode !== "tui") {
		return { selection: defaultOption, complexity };
	}

	const items: SelectItem[] = options.map((option) => ({
		value: formatModelSelection(option),
		label: option.label,
		description: option.description,
	}));
	const defaultIndex = items.findIndex((item) => item.value === formatModelSelection(defaultOption));
	const selected = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		const title = new Text("", 1, 0);
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(title);

		const selectList = new SelectList(items, Math.min(items.length, 8), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		if (defaultIndex >= 0) selectList.setSelectedIndex(defaultIndex);
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "↑↓ choose • enter select • esc/default • auto-selects in 10s"), 1, 0));
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

		const deadline = Date.now() + SELECTION_TIMEOUT_MS;
		let resolved = false;
		let timeout: ReturnType<typeof setTimeout>;
		const updateTitle = () => {
			const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
			title.setText(
				theme.fg("accent", theme.bold(`Delegate model — ${complexity} complexity (${seconds}s)`)) +
					`\n${theme.fg("muted", task.length > 120 ? `${task.slice(0, 117)}...` : task)}`,
			);
			tui.requestRender();
		};
		const timer = setInterval(updateTitle, 100);
		const close = (value: string | null) => {
			if (resolved) return;
			resolved = true;
			clearInterval(timer);
			clearTimeout(timeout);
			done(value);
		};
		updateTitle();
		timeout = setTimeout(() => close(null), SELECTION_TIMEOUT_MS);
		selectList.onSelect = (item) => close(item.value);
		selectList.onCancel = () => close(null);

		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});

	const chosen = options.find((option) => formatModelSelection(option) === selected) ?? defaultOption;
	return { selection: chosen, complexity };
}

export async function configureModelDefaults(ctx: ExtensionContext): Promise<void> {
	const options = getModelOptions(ctx);
	if (options.length === 0) {
		ctx.ui.notify("No scoped models are configured. Set /scoped-models first.", "warning");
		return;
	}
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Subagent model defaults can only be configured interactively.", "warning");
		return;
	}

	const defaults = await loadDefaults();
	for (const complexity of COMPLEXITIES) {
		const defaultOption = findDefault(options, defaults, complexity, ctx)!;
		defaults[complexity] ??= { model: defaultOption.model, thinkingLevel: defaultOption.thinkingLevel };
		const choice = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
			container.addChild(new Text(theme.fg("accent", theme.bold(`Default model for ${complexity} complexity`)), 1, 0));
			const items: SelectItem[] = options.map((option) => ({
				value: formatModelSelection(option),
				label: option.label,
				description: option.description,
			}));
			const list = new SelectList(items, Math.min(items.length, 8));
			list.setSelectedIndex(items.findIndex((item) => item.value === formatModelSelection(defaultOption)));
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			container.addChild(list);
			container.addChild(new Text(theme.fg("dim", "↑↓ choose • enter select • esc keep current"), 1, 0));
			container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
			return {
				render: (width) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		});
		if (choice) {
			const selected = options.find((option) => formatModelSelection(option) === choice);
			if (selected) defaults[complexity] = { model: selected.model, thinkingLevel: selected.thinkingLevel };
		}
	}
	await saveDefaults(defaults);
	ctx.ui.notify("Saved subagent model defaults.", "info");
}

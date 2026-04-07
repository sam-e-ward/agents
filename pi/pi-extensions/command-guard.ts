/**
 * command-guard
 *
 * Generic bash command guard. Blocks commands matching registered patterns
 * before they execute.
 *
 * ## Static rules
 *
 * Add patterns to `command-guard.json` next to this file:
 *
 *   {
 *     "rules": [
 *       { "pattern": "\\bsocat\\b", "reason": "Don't start socat directly" }
 *     ]
 *   }
 *
 * `pattern` is a regex string (tested against the full command).
 * `reason` is returned to the LLM so it understands why the command was blocked.
 *
 * ## Dynamic registration (from other extensions)
 *
 * Other extensions can register rules at load time via pi.events:
 *
 *   pi.events.emit("command-guard:register", {
 *     pattern: "\\bkubectl\\s+delete\\b",
 *     reason: "Use the deployment tool instead of kubectl delete",
 *   });
 *
 * Rules registered this way persist for the session lifetime.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

interface Rule {
	pattern: RegExp;
	reason: string;
}

interface RuleConfig {
	pattern: string;
	reason: string;
}

export default function (pi: ExtensionAPI) {
	const rules: Rule[] = [];

	// --- load static rules from command-guard.json ---
	const configPath = path.join(path.dirname(new URL(import.meta.url).pathname), "command-guard.json");
	try {
		const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { rules?: RuleConfig[] };
		for (const r of raw.rules ?? []) {
			rules.push({ pattern: new RegExp(r.pattern), reason: r.reason });
		}
	} catch {
		// missing or malformed config — fine, just no static rules
	}

	// --- dynamic registration from other extensions ---
	pi.events.on("command-guard:register", (data: RuleConfig) => {
		rules.push({ pattern: new RegExp(data.pattern), reason: data.reason });
	});

	// --- intercept bash calls ---
	pi.on("tool_call", async (event) => {
		if (!isToolCallEventType("bash", event)) return;

		const cmd = event.input.command;
		for (const rule of rules) {
			if (rule.pattern.test(cmd)) {
				return { block: true, reason: rule.reason };
			}
		}
	});
}

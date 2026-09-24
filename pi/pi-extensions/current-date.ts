import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function getLocalDate(): { date: string; weekday: string; timeZone: string } {
	const now = new Date();
	const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		weekday: "long",
	}).formatToParts(now);
	const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));

	return {
		date: `${values.year}-${values.month}-${values.day}`,
		weekday: values.weekday,
		timeZone,
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		const { date, weekday, timeZone } = getLocalDate();
		return {
			systemPrompt: `${event.systemPrompt}\n\nCurrent date: ${date} (${weekday}; local timezone: ${timeZone}). This runtime-provided date is authoritative; do not infer today's date from training data or a model's knowledge cutoff.`,
		};
	});
}

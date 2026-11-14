import { MAX_REQUEST_BYTES } from "../protocol.ts";

export class CloudHttpError extends Error {
	readonly status: number;
	constructor(status: number) {
		super(`Cloud server returned HTTP ${status}`);
		this.name = "CloudHttpError";
		this.status = status;
	}
}

export function validateServerUrl(input: string): string {
	const url = new URL(input);
	const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(input.trim())?.[1];
	if (!authority || authority.includes("@") || url.username || url.password || url.href.includes("?") || url.href.includes("#")) {
		throw new Error("Server URL must not contain credentials, a query, or a fragment");
	}
	const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		throw new Error("Server URL must use HTTPS, or HTTP on loopback only");
	}
	return url.href.replace(/\/+$/, "");
}

export async function request(serverUrl: string, path: string, options: {
	method?: "GET" | "POST" | "DELETE";
	token?: string;
	body?: unknown;
	expectedStatus?: number;
} = {}): Promise<unknown> {
	const controller = new AbortController();
	const deadline = setTimeout(() => controller.abort(), 15_000);
	try {
		const response = await fetch(`${validateServerUrl(serverUrl)}${path}`, {
			method: options.method ?? "GET",
			redirect: "error",
			signal: controller.signal,
			headers: {
				Accept: "application/json",
				...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
				...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
		});
		if (response.status !== (options.expectedStatus ?? 200)) {
			await response.body?.cancel();
			throw new CloudHttpError(response.status);
		}
		if (response.status === 204) return undefined;
		if (!response.body) throw new Error("Cloud server returned an empty response");
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let length = 0;
		try {
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				length += chunk.value.byteLength;
				if (length > MAX_REQUEST_BYTES) throw new Error("Cloud response exceeds the size limit");
				chunks.push(chunk.value);
			}
		} finally {
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length)));
	} finally {
		clearTimeout(deadline);
	}
}

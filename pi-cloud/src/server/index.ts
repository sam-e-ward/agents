import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { MAX_REQUEST_BYTES, PROTOCOL_VERSION, object } from "../protocol.ts";
import { CloudError, validate } from "./errors.ts";
import { openStore } from "./store.ts";
import type { CloudStore, Device, Enrollment } from "./store.ts";

export { openStore } from "./store.ts";
export type { CloudStore, Device, Enrollment } from "./store.ts";

const REQUEST_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 5_000;

export interface CloudServerOptions {
	dataDir: string;
	host?: string;
	port?: number;
}

export interface CloudServer {
	server: Server;
	url: string;
	close(): Promise<void>;
}

function withStore<T>(dataDir: string, operation: (store: CloudStore) => T): T {
	const store = openStore(dataDir);
	try {
		return operation(store);
	} finally {
		store.close();
	}
}

export function createEnrollment(dataDir: string, deviceName: string): Enrollment {
	return withStore(dataDir, (store) => store.createEnrollment(deviceName));
}

export function listDevices(dataDir: string): Device[] {
	return withStore(dataDir, (store) => store.listDevices());
}

export function revokeDevice(dataDir: string, id: string): void {
	withStore(dataDir, (store) => store.revokeDevice(id));
}

function send(request: IncomingMessage, response: ServerResponse, status: number, body?: unknown): void {
	if (response.destroyed || response.writableEnded) return;
	response.statusCode = status;
	response.setHeader("Cache-Control", "no-store");
	response.setHeader("X-Content-Type-Options", "nosniff");
	if (status === 401) response.setHeader("WWW-Authenticate", "Bearer");
	// Do not leave unauthenticated, oversized, or incomplete uploads draining indefinitely.
	if (!request.complete) response.setHeader("Connection", "close");
	const serialized = body === undefined ? undefined : JSON.stringify(body);
	if (serialized !== undefined) response.setHeader("Content-Type", "application/json; charset=utf-8");
	response.end(serialized, () => {
		if (!request.complete) request.destroy();
	});
}

async function readBody(request: IncomingMessage): Promise<unknown> {
	const declaredLength = request.headers["content-length"];
	if (declaredLength !== undefined && Number(declaredLength) > MAX_REQUEST_BYTES) {
		throw new CloudError(413, "Request too large");
	}
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request.iterator({ destroyOnReturn: false })) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_REQUEST_BYTES) throw new CloudError(413, "Request too large");
		chunks.push(buffer);
	}
	return validate(() => JSON.parse(Buffer.concat(chunks, size).toString("utf8")));
}

function authenticate(store: CloudStore, request: IncomingMessage): string {
	const authorization = request.headers.authorization;
	const match = typeof authorization === "string" ? /^Bearer ([0-9a-f]{64})$/i.exec(authorization) : null;
	if (!match) throw new CloudError(401, "Unauthorized");
	return store.authenticate(match[1]);
}

async function route(store: CloudStore, request: IncomingMessage, response: ServerResponse): Promise<void> {
	const url = validate(() => new URL(request.url ?? "/", "http://localhost"));
	const path = url.pathname;
	if (request.method === "GET" && path === "/health") {
		send(request, response, 200, { protocol: PROTOCOL_VERSION });
		return;
	}
	if (request.method === "POST" && path === "/v1/enroll") {
		const body = await readBody(request);
		if (response.destroyed || response.writableEnded) return;
		const data = validate(() => object(body));
		send(request, response, 200, store.enroll(data.token, data.name));
		return;
	}
	const deviceId = authenticate(store, request);
	if (request.method === "DELETE" && path === "/v1/device") {
		store.revokeDevice(deviceId);
		send(request, response, 204);
		return;
	}
	if (request.method === "POST" && path === "/v1/revisions") {
		const body = await readBody(request);
		if (response.destroyed || response.writableEnded) return;
		// A credential can be revoked while the body is being received.
		authenticate(store, request);
		send(request, response, 200, store.registerRevision(body, deviceId));
		return;
	}
	const revision = /^\/v1\/revisions\/([^/]+)$/.exec(path);
	if (request.method === "GET" && revision) {
		send(request, response, 200, store.getRevision(revision[1]));
		return;
	}
	if (request.method === "GET" && path === "/v1/conversations") {
		send(request, response, 200, { conversations: store.listConversations() });
		return;
	}
	if (request.method === "GET" && path === "/v1/changes") {
		const values = url.searchParams.getAll("after");
		const cursor = values[0] ?? "0";
		if (values.length > 1 || !/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) {
			throw new CloudError(400, "Invalid change cursor");
		}
		send(request, response, 200, store.listChanges(Number(cursor)));
		return;
	}
	const conversation = /^\/v1\/conversations\/([^/]+)$/.exec(path);
	if (request.method === "DELETE" && conversation) {
		store.deleteConversation(conversation[1]);
		send(request, response, 204);
		return;
	}
	throw new CloudError(404, "Not found");
}

export async function createCloudServer(options: CloudServerOptions): Promise<CloudServer> {
	const store = openStore(options.dataDir);
	let closing = false;
	const server = createServer({
		requestTimeout: REQUEST_TIMEOUT_MS,
		headersTimeout: 10_000,
		keepAliveTimeout: 5_000,
		connectionsCheckingInterval: 1_000,
		maxHeaderSize: 16 * 1024,
	}, (request, response) => {
		response.setHeader("Cache-Control", "no-store");
		if (closing) {
			response.setHeader("Connection", "close");
			send(request, response, 503, { error: "Server closing" });
			return;
		}
		const timeout = setTimeout(() => {
			if (!response.destroyed && !response.writableEnded) {
				response.setHeader("Connection", "close");
				send(request, response, 408, { error: "Request timed out" });
			}
			// The deadline also bounds clients that never read the response.
			request.socket.destroy();
		}, REQUEST_TIMEOUT_MS);
		timeout.unref();
		response.once("close", () => clearTimeout(timeout));
		response.once("finish", () => clearTimeout(timeout));
		void route(store, request, response).catch((error: unknown) => {
			if (error instanceof CloudError) {
				send(request, response, error.status, { error: error.message });
			} else {
				send(request, response, 500, { error: "Internal server error" });
			}
		});
	});
	server.setTimeout(REQUEST_TIMEOUT_MS, (socket) => socket.destroy());
	// Parser-level failures must not echo headers, tokens, or request payloads.
	server.on("clientError", (_error, socket) => {
		if (socket.writable) {
			socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n");
		} else {
			socket.destroy();
		}
	});
	try {
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				server.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				server.off("error", onError);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(options.port ?? 4210, options.host ?? "127.0.0.1");
		});
	} catch (error) {
		store.close();
		throw error;
	}
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		store.close();
		throw new Error("Expected an HTTP TCP address");
	}
	const host = address.address.includes(":") ? `[${address.address}]` : address.address;
	let closePromise: Promise<void> | undefined;
	return {
		server,
		url: `http://${host}:${address.port}`,
		close() {
			if (closePromise) return closePromise;
			closing = true;
			closePromise = new Promise<void>((resolve, reject) => {
				const deadline = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
				deadline.unref();
				server.close((error) => {
					clearTimeout(deadline);
					try {
						store.close();
						if (error && (!("code" in error) || error.code !== "ERR_SERVER_NOT_RUNNING")) reject(error);
						else resolve();
					} catch (closeError) {
						reject(closeError);
					}
				});
			});
			return closePromise;
		},
	};
}

#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { CloudClient } from "./client/index.ts";
import { writeHandoffSource } from "./resume.ts";

const HELP = `pi-cloud — opt-in conversation sync (Node 24.14+)

  server start [--data DIR] [--host HOST] [--port PORT]
  server enroll NAME [--data DIR]                  Print a one-use login token
  server devices [--data DIR]
  server revoke DEVICE-ID [--data DIR]

  login URL --token-stdin [--name NAME]             Read enrollment token from stdin
  logout                                          Revoke this device, then forget credential
  status                                          Safe profile summary
  project add NAME ROOT [--id PROJECT-ID]           Explicitly map a local workspace
  project list
  track SESSION-FILE --project PROJECT-ID          Opt this session into syncing
  untrack SESSION-FILE                             Stop uploads; retain cloud history
  bindings                                        List local session bindings
  sync [--once]                                   Upload tracked sessions and pull changes
  sessions                                        List cached conversations and revision heads
  resume REVISION-ID [--workspace ROOT] [--yes]     Fork into a mapped workspace and start pi
  delete CONVERSATION-ID --yes                     Explicit cloud tombstone; native files kept

Client state: PI_CLOUD_HOME or ~/.pi/cloud
Server state: PI_CLOUD_SERVER_HOME or ~/.pi/cloud-server
HTTP is permitted only on loopback; use an SSH tunnel or HTTPS reverse proxy.
Sessions contain sensitive data. Only explicitly tracked sessions are uploaded.
`;

function output(value: unknown): void {
	console.log(JSON.stringify(value, null, 2));
}

function argumentsFor(args: string[], options: Record<string, { type: "string" | "boolean" }> = {}) {
	return parseArgs({ args, options, allowPositionals: true, strict: true });
}

function arity(values: string[], count: number, usage: string): void {
	if (values.length !== count) throw new Error(`Usage: pi-cloud ${usage}`);
}

async function readToken(): Promise<string> {
	if (process.stdin.isTTY) throw new Error("Pipe an enrollment token into login --token-stdin (do not put secrets in command arguments)");
	let token = "";
	for await (const chunk of process.stdin) {
		token += String(chunk);
		if (Buffer.byteLength(token) > 1024) throw new Error("Enrollment token input is too large");
	}
	return token.trim();
}

async function serverCommand(args: string[]): Promise<void> {
	const [command, ...rest] = args;
	const { values, positionals } = argumentsFor(rest, { data: { type: "string" }, host: { type: "string" }, port: { type: "string" } });
	const dataDir = values.data as string | undefined ?? process.env.PI_CLOUD_SERVER_HOME ?? join(homedir(), ".pi", "cloud-server");
	const { createCloudServer, createEnrollment, listDevices, revokeDevice } = await import("./server/index.ts");
	if (command !== "start" && (values.host !== undefined || values.port !== undefined)) throw new Error("--host and --port apply only to server start");
	if (command === "enroll") {
		arity(positionals, 1, "server enroll NAME [--data DIR]");
		const enrollment = createEnrollment(dataDir, positionals[0]);
		console.error(`Enrollment token expires at ${enrollment.expiresAt}. Treat stdout as a secret.`);
		console.log(enrollment.token);
	} else if (command === "devices") {
		arity(positionals, 0, "server devices [--data DIR]");
		output(listDevices(dataDir));
	} else if (command === "revoke") {
		arity(positionals, 1, "server revoke DEVICE-ID [--data DIR]");
		revokeDevice(dataDir, positionals[0]);
		console.log("Device revoked.");
	} else if (command === "start") {
		arity(positionals, 0, "server start [--data DIR] [--host HOST] [--port PORT]");
		const port = values.port === undefined ? 4210 : Number(values.port);
		if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Port must be an integer from 0 to 65535");
		const host = values.host as string | undefined;
		if (host && !["127.0.0.1", "localhost", "::1"].includes(host)) console.error("Warning: plain HTTP listener is exposed. Put it behind HTTPS; do not expose it publicly.");
		const cloud = await createCloudServer({ dataDir, port, host });
		console.log(`pi-cloud listening on ${cloud.url}`);
		await new Promise<void>((resolve, reject) => {
			const shutdown = () => {
				process.off("SIGINT", shutdown);
				process.off("SIGTERM", shutdown);
				void cloud.close().then(resolve, reject);
			};
			process.once("SIGINT", shutdown);
			process.once("SIGTERM", shutdown);
		});
	} else throw new Error("Usage: pi-cloud server start|enroll|devices|revoke (see --help)");
}

async function resume(client: CloudClient, args: string[]): Promise<void> {
	const { values, positionals } = argumentsFor(args, { workspace: { type: "string" }, yes: { type: "boolean" } });
	arity(positionals, 1, "resume REVISION-ID [--workspace ROOT] --yes");
	const plan = await client.prepareResume(positionals[0], values.workspace as string | undefined);
	console.error(`Target workspace: ${plan.targetCwd}`);
	for (const warning of plan.warnings) console.error(`Warning: ${warning}`);
	console.error("History only: workspace files and Git state have not been synced.");
	if (!values.yes) throw new Error("Review the target and warnings above, then repeat with --yes to create a local fork");
	const source = await writeHandoffSource(client.home, plan);
	const sessionId = randomUUID();
	// Explicitly load the source extension even when the CLI itself is compiled.
	const extension = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./extension.ts" : "../src/extension.ts", import.meta.url));
	const code = await new Promise<number>((resolve, reject) => {
		const child = spawn("pi", ["--fork", source, "--session-id", sessionId, "-e", extension], {
			cwd: plan.targetCwd,
			stdio: "inherit",
			env: {
				...process.env, PI_CLOUD_HOME: client.home,
				PI_CLOUD_RESUME_SESSION_ID: sessionId, PI_CLOUD_RESUME_REVISION: plan.revision.id,
			},
		});
		child.once("error", reject);
		child.once("exit", (exitCode, signal) => resolve(exitCode ?? (signal === "SIGINT" ? 130 : 1)));
	});
	if (code !== 0) process.exitCode = code;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
	const [command, ...rest] = args;
	if (!command || command === "--help" || command === "help" || command === "-h") { console.log(HELP); return; }
	if (command === "server") { await serverCommand(rest); return; }
	const client = new CloudClient();
	if (command === "login") {
		const { values, positionals } = argumentsFor(rest, { "token-stdin": { type: "boolean" }, name: { type: "string" } });
		arity(positionals, 1, "login URL --token-stdin [--name NAME]");
		if (!values["token-stdin"]) throw new Error("Login requires --token-stdin");
		output(await client.login(positionals[0], await readToken(), values.name as string | undefined ?? hostname()));
	} else if (command === "project") {
		const [action, ...projectArgs] = rest;
		const { values, positionals } = argumentsFor(projectArgs, { id: { type: "string" } });
		if (action === "add") {
			arity(positionals, 2, "project add NAME ROOT [--id PROJECT-ID]");
			output(await client.registerProject(positionals[0], positionals[1], values.id as string | undefined));
		} else if (action === "list" && values.id === undefined) {
			arity(positionals, 0, "project list");
			output(await client.projects());
		} else throw new Error("Usage: pi-cloud project add NAME ROOT [--id ID] | project list");
	} else if (command === "track") {
		const { values, positionals } = argumentsFor(rest, { project: { type: "string" } });
		arity(positionals, 1, "track SESSION-FILE --project PROJECT-ID");
		if (typeof values.project !== "string") throw new Error("track requires --project PROJECT-ID");
		output(await client.track(positionals[0], values.project));
	} else if (command === "sync") {
		const { positionals } = argumentsFor(rest, { once: { type: "boolean" } });
		arity(positionals, 0, "sync [--once]");
		const result = await client.sync();
		output(result);
		if (result.errors.length) process.exitCode = 1;
	} else if (command === "resume") {
		await resume(client, rest);
	} else if (command === "delete") {
		const { values, positionals } = argumentsFor(rest, { yes: { type: "boolean" } });
		arity(positionals, 1, "delete CONVERSATION-ID --yes");
		if (!values.yes) throw new Error("Cloud deletion is permanent for syncing; repeat with --yes. Native pi files and server backups are retained.");
		await client.deleteConversation(positionals[0]);
		console.log("Cloud conversation deleted. Native sessions and retained server blobs/backups were not erased.");
	} else {
		const { positionals } = argumentsFor(rest);
		if (command === "untrack") {
			arity(positionals, 1, "untrack SESSION-FILE");
			await client.untrack(positionals[0]);
			console.log("Sync disabled. Existing cloud history retained.");
		} else {
			arity(positionals, 0, command);
			if (command === "status") output(await client.status());
			else if (command === "bindings") output(await client.bindings());
			else if (command === "sessions") output(await client.conversations());
			else if (command === "logout") { await client.logout(); console.log("Device revoked; local credential removed."); }
			else throw new Error(`Unknown command: ${command}. See pi-cloud --help`);
		}
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}

# pi-cloud

An optional, local-first conversation sync layer for pi. Independent of the configuration in `../pi/`.

**Initial implementation:** a single-owner HTTP server, device enrollment, a manual sync CLI, and a thin pi extension. Sessions stay native JSONL files. The server is trusted to read them; this is not end-to-end encrypted or a public multi-tenant service.

## Requirements and installation

- Node.js **24.14 or newer** (uses built-in SQLite).
- pi **1.5.0** is the currently verified extension/continuation API.
- Linux or macOS with a local filesystem for client/server state. Do not share a client profile over NFS or between machines.

From this directory:

```sh
npm ci --ignore-scripts
npm run check
npm run build
node dist/cli.js --help
```

All examples below use `node dist/cli.js`; you can optionally run `npm link` to put `pi-cloud` on PATH. The CLI and server have no third-party runtime dependencies. Pi/TypeScript dependencies are for extension development and checking.

Install the optional extension separately (this does not modify `../pi/`):

```sh
pi install /absolute/path/to/agents/pi-cloud
```

Restart pi or `/reload`. Nothing is uploaded just by installing or logging in.

## First connection over SSH

On the server, build the package and start it under your service manager, or in a terminal:

```sh
node dist/cli.js server start
```

It listens on `127.0.0.1:4210`. Its data lives at `~/.pi/cloud-server`, overrideable with `PI_CLOUD_SERVER_HOME` or `--data DIR`.

On the client, establish a tunnel in a separate terminal:

```sh
ssh -N -L 4210:127.0.0.1:4210 my-server
```

`my-server` can be an SSH alias reached via NetBird or Tailscale. The application does not depend on either product.

Create a ten-minute, single-use enrollment token on the server and pipe it into client login. Assuming the server checkout is `/srv/agents`:

```sh
ssh my-server 'cd /srv/agents/pi-cloud && node dist/cli.js server enroll laptop' \
  | node dist/cli.js login http://127.0.0.1:4210 --token-stdin --name laptop
```

Only the enrollment token is written to server-command stdout; diagnostics go to stderr. Avoid saving tokens in shell history, logs or world-readable files. If the login response is lost, create another enrollment token and revoke the unused device with `server devices` / `server revoke`.

Each client profile pins one server URL. Use the same tunnel address consistently. To use another server, use a separate `PI_CLOUD_HOME`; logout does not remove the pin or local history.

For direct mesh access, put the HTTP service behind an **HTTPS** reverse proxy. Client URLs permit plain HTTP only on loopback, reject embedded credentials, and never follow redirects. `server start --host ADDRESS` exposes plain HTTP and should only be used in a controlled reverse-proxy deployment.

## Register a project and opt in a session

On machine A:

```sh
node dist/cli.js project add agents /home/wards/agents
```

The output includes a stable project UUID. Keep it for mapping the same project on other machines.

In pi, after the session has been saved:

```text
/cloud track
/cloud sync
```

`/cloud track` asks for confirmation: **the entire history may include source files, secrets, tool output and extension state**. Future settled runs, compactions, renames and tree changes trigger best-effort background sync for that session. Sync errors appear in the footer and remain retryable. Network work is not done on token-streaming hooks.

Alternatively, opt in a specific file from the CLI:

```sh
node dist/cli.js track /absolute/path/to/session.jsonl --project PROJECT-UUID
node dist/cli.js sync --once
```

Only explicitly tracked native session files are scanned/uploaded. Tracking one session does not enable an entire directory, new sessions, forks or subagents. This conservative default is also the initial exclusion policy: leave sensitive sessions untracked.

Disable further uploads with `/cloud off` or `untrack SESSION-FILE`. Previously uploaded history remains on the server.

## Continue on machine B

Enroll B, then explicitly map the **same project ID** to its local checkout:

```sh
node dist/cli.js project add agents /Users/wards/src/agents --id PROJECT-UUID
node dist/cli.js sync
node dist/cli.js sessions
```

The catalogue shows conversation IDs, project IDs and revision heads. Choose a revision:

```sh
# Without --yes, only shows the destination and warnings.
node dist/cli.js resume REVISION-HASH --workspace /Users/wards/src/agents
node dist/cli.js resume REVISION-HASH --workspace /Users/wards/src/agents --yes
```

This starts pi with its native `--fork`, a new local session ID and the cloud extension explicitly loaded. The extension associates the new session with the original cloud conversation and parent revision. It remains a normal resumable local session even when the server is offline.

Inside pi, `/cloud sessions` opens the cached conversation picker; `/cloud resume REVISION-HASH` selects a specific continuation. Run `/cloud sync` first to refresh the cache. No remote conversation is executed merely because it was downloaded.

### Paths and worktrees

- Project IDs are independent of filenames, Git remotes and absolute paths.
- Each device explicitly maps a project ID to one or more local roots. Multiple worktrees require a choice; nested/overlapping project roots are rejected as ambiguous.
- The session cwd is stored relative to the registered root. A session from `PROJECT/pi` continues in `LOCAL-PROJECT/pi`, not the repository root.
- Targets must exist. Traversal and symlink escapes outside the mapped root are rejected. Missing mappings never fall back to `$HOME` or the current shell directory.
- Continuation creates a new native session; it never overwrites a cached or open session.
- All historical entries remain unchanged. A new visible context entry explains the old/current paths and workspace limitations. That entry also restores the selected active branch.
- Cloud ancestry uses revision IDs. Native `parentSession` points to a local cached snapshot or handoff source, not a path on another machine.
- Path mapping is not a sandbox: tools retain pi's normal OS permissions.

Git branch, commit and dirty-state metadata generate warnings, not automatic checkouts/resets/stashes. **Files, uncommitted changes, dependencies, credentials, extension caches and running processes are not synced.** Matching paths or commits do not establish matching filesystem contents; dirty workspaces on both machines may contain different changes.

## Conflict and failure semantics

Every upload creates an immutable, hash-verified revision with its parent revision and origin device. If A and B both continue the same revision, both children remain as separate heads. There is no last-writer-wins replacement, JSONL concatenation or automatic merge.

The client saves a durable draft before uploading. Retrying a dropped response submits the same revision. Changed, incomplete, oversized or invalid sessions are reported individually; other tracked sessions can still sync. Native files are read with stability checks and never truncated or rewritten by the sync engine. Snapshots contain complete persisted records, not live streaming tokens.

The change feed uses a server-issued sequence, not device clocks. A cursor advances only after the corresponding cache work is durable. Startup/manual sync scans the registered file paths, so an interrupted automatic sync can be reconciled later.

Client state, credentials, outbox and cache live under `~/.pi/cloud` (`PI_CLOUD_HOME` overrides). Directories are private and files are mode `0600`; client mutations use a cross-process lock with dead-owner recovery. Keep this profile on a local disk. Do not copy its device credential to another machine; enroll a separate device.

## Commands

Run `node dist/cli.js --help` for the complete interface. Useful administrative commands:

```sh
node dist/cli.js status
node dist/cli.js bindings
node dist/cli.js project list
node dist/cli.js server devices
node dist/cli.js server revoke DEVICE-UUID
node dist/cli.js logout
node dist/cli.js delete CONVERSATION-UUID --yes
```

Logout revokes the device before removing the local credential. Network failure leaves it available for retry; already-revoked credentials can be forgotten. Re-enrollment may use the same profile for the same server.

Cloud deletion writes a permanent tombstone. Clients disable associated uploads and remove cached revision/snapshot files once they learn it. Native pi sessions and local continuation handoffs are retained. An offline client can still have old data until it reconnects. Deletion prevents further serving/re-uploading that cloud identity; it is **not secure erasure** of server blobs, native files, handoffs or backups.

## Running and backing up the server

`deploy/pi-cloud-server.service` is a sample systemd **user** unit. Adjust its checkout and Node paths before installing. The server closes on SIGINT/SIGTERM and bounds active request/shutdown time.

The private server directory contains `cloud.sqlite` and immutable `blobs/`. SQLite metadata includes device credential hashes, enrollment hashes, conversation ancestry, branch heads, tombstones and change sequences. Full revision bodies live in the blob directory. Back up **both** together with the server stopped; restore both together. Do not back up only the database. Use encrypted storage/backups where appropriate. Raw transcript bodies and bearer tokens are not logged by the server.

The service is single-owner: every enrolled device can read and delete all conversations. There are upload/response limits (16 MiB native snapshots) and request deadlines, but no public-service abuse protection, quotas or user isolation. Put it on a private network/tunnel, not directly on the internet.

## Layout and next steps

```text
src/protocol.ts     Versioned wire data, validation and revision hashing
src/client/         Private profile, durable sync, cache and workspace mapping
src/server/         HTTP API, SQLite metadata and immutable blobs
src/extension.ts    Optional /cloud commands and checkpoint triggers
src/resume.ts       Explicit continuation context and CLI fork source
src/cli.ts          Client and server entry point
```

This first slice deliberately does not include an always-on client worker, filesystem watchers, all-session backfill, push notifications, automatic merges, end-to-end encryption or blob retention/garbage collection. Manual `sync` works independently of pi; the extension adds checkpoint-triggered sync. Next, add the per-user worker/reconciliation scheduler around the same engine, then retention/backup tooling and stronger operational controls.

Native pi v3 sessions are supported; open older sessions in pi to migrate them first. Unknown entry types are retained verbatim, but arbitrary extension state and absolute paths inside history are not made portable. Rebuild and re-check compatibility when upgrading pi.

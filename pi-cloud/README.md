# pi-cloud

An optional, local-first conversation sync layer for pi. Independent of the configuration in `../pi/`.

**Initial implementation:** a single-owner HTTP server, device enrollment, a manual sync CLI, and a thin pi extension. Sessions stay native JSONL files. The server is trusted to read them; this is not end-to-end encrypted or a public multi-tenant service.

## Requirements and installation

- Node.js **24.14 or newer** (uses built-in SQLite).
- [just](https://just.systems/) on each machine (`just` 1.59 is verified). SSH remote recipes also require Bash locally and `just`/Node on the remote non-interactive shell's PATH.
- pi **1.5.0** is the currently verified extension/continuation API.
- Linux or macOS with a local filesystem for client/server state. Do not share a client profile over NFS or between machines.

From the repository root or any directory inside it:

```sh
just                         # List commands
just cloud-setup             # Install locked dependencies, check and build
just cloud --help            # Full CLI interface
```

The root `justfile` covers both client and server commands. `just cloud ...` forwards any CLI operation; named recipes provide convenient shortcuts. It runs the TypeScript source directly so a stale build cannot hide changes. `just cloud-check` and `just cloud-build` are also available separately. The CLI/server have no third-party runtime dependencies; installed Pi/TypeScript packages support extension development and checking.

**Paths and `--here` refer to the directory where you invoked `just`**, not the directory containing the justfile. From outside this checkout, use `just --justfile /path/to/agents/justfile cloud-resume-here ...`.

Install the optional extension separately (this does not modify `../pi/`):

```sh
just cloud-install-extension
```

Use `just cloud-remove-extension` to unregister it. Both accept `--local` for a project-local installation.

Restart pi or `/reload`. Nothing is uploaded just by installing or logging in.

## First connection over SSH

On the server, build the package and start it under your service manager, or in a terminal:

```sh
just cloud-setup
just cloud-server-start
```

It listens on `127.0.0.1:4210`. Its data lives at `~/.pi/cloud-server`, overrideable with `PI_CLOUD_SERVER_HOME` or `--data DIR`.

On the client, establish a tunnel in a separate terminal:

```sh
just cloud-tunnel my-server
# Optional local and remote ports:
# just cloud-tunnel my-server 14210 4210
```

`my-server` can be an SSH alias reached via NetBird or Tailscale. The application does not depend on either product.

Create a ten-minute, single-use enrollment token remotely and pipe it directly into client login. Assuming the server checkout is `/srv/agents`:

```sh
just cloud-login-ssh my-server /srv/agents http://127.0.0.1:4210 laptop
```

Or use the individual recipes (only the token travels through stdout):

```sh
just cloud-remote my-server /srv/agents cloud-server-enroll laptop \
  | just cloud-login http://127.0.0.1:4210 --name laptop
```

`just cloud-remote HOST CHECKOUT RECIPE [ARGS...]` can also run setup and administration remotely, for example `just cloud-remote my-server /srv/agents cloud-setup`. Remote checkout paths and recipe arguments are shell-quoted; secrets are never placed in SSH arguments.

Only the enrollment token is written to server-command stdout; diagnostics go to stderr. Avoid saving tokens in shell history, logs or world-readable files. If the login response is lost, create another enrollment token and revoke the unused device with `server devices` / `server revoke`.

Each client profile pins one server URL. Use the same tunnel address consistently. To use another server, use a separate `PI_CLOUD_HOME`; logout does not remove the pin or local history.

For direct mesh access, put the HTTP service behind an **HTTPS** reverse proxy. Client URLs permit plain HTTP only on loopback, reject embedded credentials, and never follow redirects. `server start --host ADDRESS` exposes plain HTTP and should only be used in a controlled reverse-proxy deployment.

## Opt in a session — no project matching required

For conversations where the working folder is unimportant, no project registration is needed:

```sh
just cloud-track /absolute/path/to/session.jsonl
just cloud-sync
```

New sessions tracked without `--project` are grouped under **Unfiled**, and their original folder is descriptive metadata only. The source folder does not need to exist to upload an archived session file. Existing tracked sessions keep their current mode; use `just cloud-track SESSION-FILE --anywhere` to disable matching for an existing binding without changing its cloud identity.

In pi, after the session has been saved:

```text
/cloud track
/cloud sync
```

`/cloud track` asks for confirmation: **the entire history may include source files, secrets, tool output and extension state**. Future settled runs, compactions, renames and tree changes trigger best-effort background sync for that session. Sync errors appear in the footer and remain retryable. Network work is not done on token-streaming hooks.

Alternatively, opt in a specific file from the CLI:

```sh
just cloud-track /absolute/path/to/session.jsonl
just cloud-sync --once
```

Only explicitly tracked native session files are scanned/uploaded. Tracking one session does not enable an entire directory, new sessions, forks or subagents. This conservative default is also the initial exclusion policy: leave sensitive sessions untracked.

Disable further uploads with `/cloud off` or `untrack SESSION-FILE`. Previously uploaded history remains on the server.

## Continue on machine B

Enroll B, then pull conversations:

```sh
just cloud-sync
just cloud-sessions
```

### Anywhere: ignore project and folder matching

Resume **any** conversation in your current directory, including a conversation originally attached to a project:

```sh
just cloud-resume-here REVISION-HASH --yes
# Or choose an arbitrary existing folder, with no project registration:
just cloud-resume REVISION-HASH --cwd /path/to/notes --yes
```

Without `--yes`, these commands only preview the destination and warnings. Unfiled sessions also default to the caller's directory with `just cloud-resume REVISION-HASH --yes`. Neither mode recreates the old directory hierarchy. The new local continuation stays in **anywhere** mode, so later uploads and checkpoint syncs do not require a mapping either. The original cloud conversation/ancestry is preserved.

Inside pi, `/cloud resume-here [REVISION-HASH]` resumes into the current session's directory; omit the revision to open the conversation picker. `/cloud sessions` and `/cloud resume` offer **Here (ignore project matching)** alongside available mapped workspaces. Unfiled sessions use the current directory directly. A confirmation still shows the destination and warns that historical paths may be unrelated.

### Optional: mapped projects and worktrees

For coding sessions where the checkout matters, register a project on A and opt a new session into mapped tracking before its first upload:

```sh
just cloud-project-add agents /home/wards/agents
just cloud-track SESSION-FILE --project PROJECT-UUID
# Or use /cloud track mapped inside pi after registering the root.
```

Map the **same project ID** to B's checkout:

```sh
just cloud-project-add agents /Users/wards/src/agents --id PROJECT-UUID
just cloud-resume REVISION-HASH --workspace /Users/wards/src/agents --yes
```

`--workspace` retains strict project matching and restores the source-relative working directory. It is mutually exclusive with `--here`/`--cwd`. For project-associated conversations, CLI resume without a location flag still uses mapped mode; explicitly use `cloud-resume-here` or `--cwd` to bypass it. Older saved bindings remain mapped unless you explicitly change their mode. A cloud conversation's project ID is not reassigned; switching a mapped conversation to anywhere mode keeps its original catalogue grouping.

This starts pi with its native `--fork`, a new local session ID and the cloud extension explicitly loaded. The extension associates the new session with the original cloud conversation and parent revision. It remains a normal resumable local session even when the server is offline.

Run `/cloud sync` first to refresh pi's cached conversation picker. `/cloud track` enables a new session without project matching; `/cloud track mapped` opts into matching and `/cloud track anywhere` switches an existing binding to folder-agnostic sync. No remote conversation is executed merely because it was downloaded.

### Paths and worktrees

- Project IDs are independent of filenames, Git remotes and absolute paths.
- Each device explicitly maps a project ID to one or more local roots. Multiple worktrees require a choice; nested/overlapping project roots are rejected as ambiguous.
- In mapped mode, the session cwd is stored relative to the registered root. A session from `PROJECT/pi` continues in `LOCAL-PROJECT/pi`, not the repository root. Anywhere continuations instead use the chosen folder directly and publish their location with relative cwd `.`.
- Targets must exist. In mapped mode, traversal and symlink escapes outside the mapped root are rejected; missing mappings never silently fall back elsewhere. Anywhere mode deliberately uses the exact directory you select, independently of project roots.
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

Run `just` for the recipe list and `just cloud --help` for the complete CLI interface. Useful administrative commands:

```sh
just cloud-status
just cloud-bindings
just cloud-projects
just cloud-server-devices
just cloud-server-revoke DEVICE-UUID
just cloud-logout
just cloud-delete CONVERSATION-UUID --yes
```

`PI_CLOUD_HOME` and `PI_CLOUD_SERVER_HOME` work with every recipe. Server administration also accepts `--data DIR`; for example, `just cloud-server-enroll laptop --data /private/cloud-server`.

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

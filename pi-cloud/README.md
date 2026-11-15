# pi-cloud

## Walkthrough

Sync pi conversations between machines through a private, trusted server. Requires Node **24.14+** and [just](https://just.systems/) on both sides, plus pi on clients (verified with **1.5.0**). Run recipes from this checkout or its subdirectories. SSH recipes require Bash locally and Node/just on the remote shell's PATH.

1. **Prepare both machines:** run `just cloud-setup` in each checkout.
2. **Start the server:** run `just cloud-server-start` and leave it running. It listens on `127.0.0.1:4210`.
3. **Prepare the client:** run `just cloud-install-extension`, then restart pi or `/reload`. In a separate terminal, leave `just cloud-tunnel my-server` running (`my-server` is your SSH host/alias, optionally reached through NetBird or Tailscale).
4. **Log in:** assuming the server checkout is `/srv/agents`, run:
   ```sh
   just cloud-login-ssh my-server /srv/agents http://127.0.0.1:4210 laptop
   ```
5. **Upload a saved conversation:** inside pi, run `/cloud track`, then `/cloud sync`. Subsequent completed runs sync automatically on a best-effort basis.
6. **Continue elsewhere:** prepare and log in another client using a different device name. Run `/cloud sync`, then `/cloud resume-here` to choose a conversation and continue in the current session's folder. No project mapping is required.

Only explicitly tracked sessions upload. **History can contain source code, tool output and secrets; the server can read it.** Workspace files, Git state, credentials and running processes are not synced. Resuming creates a new local session; concurrent continuations remain separate branches rather than overwriting one another.

## Client

Paths are relative to where you invoke `just`, not the justfile. From outside the checkout, use `just --justfile /path/to/agents/justfile COMMAND`. Client state lives in `~/.pi/cloud`; set `PI_CLOUD_HOME` for another profile. Each profile pins one server URL, even after logout.

**Just commands**

| Command | What it does |
| --- | --- |
| `just` / `just default` | List available recipes. |
| `just cloud-setup` | Install locked dependencies without lifecycle scripts, type-check and build. |
| `just cloud-check` | Type-check the code. |
| `just cloud-build` | Compile the code; just recipes run source directly, so building is not required for them. |
| `just cloud ARGS...` | Run any CLI operation; `just cloud --help` lists its options. |
| `just cloud-install-extension [--local]` | Register the cloud extension globally, or for the current project with `--local`. |
| `just cloud-remove-extension [--local]` | Remove that extension registration. |
| `just cloud-tunnel HOST [LOCALPORT] [REMOTEPORT]` | Keep an SSH tunnel open in the foreground. Both ports default to `4210`. |
| `just cloud-login-ssh HOST CHECKOUT URL NAME` | Enroll on the remote server and log in locally, piping the token without putting it in arguments or files. |
| `just cloud-login URL [--name NAME]` | Log in using an enrollment token read from stdin. Name defaults to the hostname. |
| `just cloud-logout` | Revoke this device and forget its credential; network failure leaves it available for retry. |
| `just cloud-status` | Show login, server and tracking counts without exposing credentials. |
| `just cloud-track FILE [--project ID]` | Enable sync for a native session file. New sessions need no project; `--project` opts into mapped tracking. |
| `just cloud-track FILE --anywhere` | Switch an existing binding to folder-agnostic tracking without changing its cloud identity. |
| `just cloud-untrack FILE` | Stop uploads for that session; retain existing cloud history. |
| `just cloud-bindings` | List local tracked-session bindings and their modes. |
| `just cloud-sync [--once]` | Upload tracked sessions and download changes. Always runs once. |
| `just cloud-sessions` | List cached conversations and their revision heads. |
| `just cloud-resume-here REVISION [--yes]` | Resume in the caller's directory, ignoring project matching. Without `--yes`, only preview. |
| `just cloud-resume REVISION [OPTIONS]` | Preview or resume with `--yes`. Use `--cwd DIR` or `--here` to ignore matching; `--workspace ROOT` uses a mapped project and restores its relative folder. These location options are mutually exclusive. Unfiled sessions default to the caller's directory; project-associated sessions default to mapped mode. |
| `just cloud-project-add NAME ROOT [--id ID]` | Register an optional workspace mapping. Reuse the same project ID on another machine. |
| `just cloud-projects` | List workspace mappings. |
| `just cloud-delete CONVERSATION --yes` | Tombstone cloud history and stop its future uploads. Native sessions and retained server blobs/backups are not erased. |

**Pi extension commands**

| Command | What it does |
| --- | --- |
| `/cloud status` | Show connection details and this session's tracking mode. |
| `/cloud track` | Confirm and enable sync. New sessions are folder-agnostic; existing bindings keep their mode. |
| `/cloud track anywhere` | Enable folder-agnostic sync for this session, preserving its cloud identity. |
| `/cloud track mapped` | Enable tracking against an already registered workspace. Choose this before initially tracking a project-specific session. |
| `/cloud off` | Disable uploads for this session without deleting cloud history. |
| `/cloud sync` | Checkpoint this session if tracked, sync all tracked files and refresh the remote cache. |
| `/cloud sessions` | Open the cached conversation picker, then choose where to continue. |
| `/cloud resume [REVISION]` | Resume a specific revision, or open the picker. Offers the current folder and any mapped workspaces; Unfiled sessions use the current folder. |
| `/cloud resume-here [REVISION]` | Resume in the current session's folder without project matching; omit the revision to open the picker. |

Resume destinations must exist. Mapped mode rejects paths escaping the project root; anywhere mode uses your chosen folder directly and remains mapping-free for subsequent syncs. Historical paths are not rewritten. Run sync before opening a picker to see recent remote sessions. There is no always-on client worker yet; use manual sync to reconcile interrupted checkpoint uploads.

## Server

A single-owner service: every enrolled device can access all conversations. Keep it behind an SSH tunnel or an HTTPS reverse proxy; it has no built-in TLS or end-to-end encryption. Clients permit plain HTTP only on loopback.

| Command | What it does |
| --- | --- |
| `just cloud-setup` | Install dependencies, check and build the server checkout. Shared `cloud-check`, `cloud-build` and `cloud ARGS...` recipes also apply here. |
| `just cloud-server-start [OPTIONS]` | Run in the foreground; defaults to loopback port `4210`. Accepts `--data DIR`, `--host HOST` and `--port PORT`. Stop with Ctrl+C. Exposing a non-loopback HTTP listener requires a protected deployment. |
| `just cloud-server-enroll NAME [--data DIR]` | Print a ten-minute, single-use enrollment token to stdout. Pipe it into `cloud-login`; treat it as a secret. |
| `just cloud-server-devices [--data DIR]` | List devices, IDs and revocation status without credentials. |
| `just cloud-server-revoke DEVICE-ID [--data DIR]` | Invalidate a device's credential immediately. |
| `just cloud-remote HOST CHECKOUT RECIPE [ARGS...]` | Run a just recipe in a remote checkout over SSH, for example `just cloud-remote my-server /srv/agents cloud-server-devices`. |

There are no server-side pi extension commands. Data lives in `~/.pi/cloud-server`, overridden by `PI_CLOUD_SERVER_HOME` or `--data`. For a managed service, adapt [`deploy/pi-cloud-server.service`](deploy/pi-cloud-server.service). Back up the **whole data directory with the server stopped**, including SQLite and blobs. Cloud deletion prevents serving/re-uploading a conversation but does not securely erase retained blobs or backups.

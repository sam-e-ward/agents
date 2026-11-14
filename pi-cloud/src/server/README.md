# pi-cloud server

Requires Node.js 24; run/import the `.ts` files directly using native type stripping. There are no runtime dependencies. The shared wire contract is `../protocol.ts`.

## Exports (`index.ts`)

- `await createCloudServer({ dataDir, host?, port? })` starts listening and returns `{ server, url, close }`. Defaults to `127.0.0.1:4210`; `port: 0` selects an available port. `url` includes the actual bound address and port. `close()` is idempotent, allows active requests five seconds to finish, then disconnects them and closes SQLite. Prefer it over calling `server.close()` directly.
- `createEnrollment(dataDir, deviceName)` returns a single-use `{ token, expiresAt }`, valid for ten minutes. The issuance name is a local enrollment label; enrollment's required `name` becomes the device's display name. Deliver the token privately. Only its SHA-256 digest is stored.
- `listDevices(dataDir)` returns `{ id, name, createdAt, revoked }[]` without credentials.
- `revokeDevice(dataDir, id)` immediately invalidates the device credential; unknown IDs are a no-op.
- `openStore(dataDir)` returns a synchronous `CloudStore`. Call `close()` when finished. It also exposes the corresponding enrollment/device operations, `authenticate`, `registerRevision(value, authenticatedDeviceId)`, `getRevision`, `listConversations`, `listChanges(after?)`, and `deleteConversation`.

`store.ts` additionally exports `CloudStore`; `index.ts` exports the associated TypeScript interfaces.

## HTTP

All responses set `Cache-Control: no-store`. Errors are `{ "error": "..." }`, with no internal exception details or request data. The server does not log transcripts, headers, tokens, or errors.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/health` | `{ protocol: 1 }`, public |
| POST | `/v1/enroll` | `{ token, name }` → `{ deviceId, credential }`, public |
| DELETE | `/v1/device` | Revoke the authenticating device; 204 |
| POST | `/v1/revisions` | `RevisionDraft` → canonical `Revision`; 200, including retries |
| GET | `/v1/revisions/<hash>` | `Revision` |
| GET | `/v1/conversations` | `{ conversations: ConversationSummary[] }` |
| GET | `/v1/changes?after=N` | `ChangePage`, at most 100 changes, ascending sequence |
| DELETE | `/v1/conversations/<uuid>` | Persistent, idempotent tombstone; 204 |

Except health and enrollment, every route requires `Authorization: Bearer <credential>`. Revoked/unknown credentials return 401; posting for another device returns 403. Invalid input returns 400, oversized bodies 413, unknown revisions 404, incompatible/missing parents or project conflicts 409, and deleted conversations/revisions 410. Tombstoned IDs cannot be reused, including previously unknown conversation IDs and identical revision retries. Deleting twice generates only one change. A change page's cursor is the last returned sequence, or the input cursor if empty; `more` signals another page.

Bodies are bounded by `MAX_REQUEST_BYTES`, snapshots by the shared protocol validators. Headers have a ten-second deadline and requests a thirty-second deadline, including chunked uploads. Shutdown waits at most five seconds for active connections, excluding time spent in synchronous filesystem/SQLite work.

## Storage and deployment

The data directory and blob directory are restricted to `0700`, SQLite to `0600`, and blob files to `0600`. Use a dedicated local data directory on a filesystem supporting atomic hard links and directory fsync. Symlinked data/blob directories and database files are rejected. SQLite uses full synchronous durability, foreign keys, a five-second busy timeout, and rollback journaling.

Revisions are addressed by the shared `revisionId(draft)` SHA-256 of canonical protocol payloads. Complete immutable JSON blobs are fsynced and atomically published without replacement before the synchronous metadata transaction commits. Revisions, branch heads, and change-feed entries commit together. A crash/rollback can leave unreferenced blobs or temporary files; they are not served without a registered revision. Concurrent children preserve distinct heads. Identical retries return the original timestamp without adding changes.

**Deletion is logical, not secure erasure.** Tombstones persist, remove conversations from listings, and prevent serving their snapshots. Revision metadata, historical changes, and blob contents remain on disk; there is no purge/garbage collector. Backups therefore retain deleted content too.

This is a single-owner personal server, not a multi-tenant service. The default listener is loopback-only. An explicit `host` option can bind elsewhere (for example `0.0.0.0`); the caller must supply a trusted TLS reverse proxy, access/network controls, and matching proxy upload/time limits before exposing it. There is no built-in TLS, public enrollment UI, or rate limiter. Keep credentials and enrollment tokens out of URLs and logs.

Implementation references: SQLite's [atomic commit documentation](https://www.sqlite.org/atomiccommit.html) and Node.js 24's [HTTP API](https://nodejs.org/docs/latest-v24.x/api/http.html). The filesystem and database are separate durability domains; publishing first deliberately favors harmless orphaned blobs over committed metadata pointing to missing content.

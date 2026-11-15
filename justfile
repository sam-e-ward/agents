# Requires Node >=24.14; the CLI runs directly from TypeScript, without a build.
# Arguments: https://just.systems/man/en/positional-arguments.html
# Caller paths: https://just.systems/man/en/working-directory.html
set positional-arguments

export _PI_CLOUD_ROOT := justfile_directory()

# List available commands.
default:
    @just --justfile "$_PI_CLOUD_ROOT/justfile" --list

# Install locked dependencies without lifecycle scripts, then check and build.
cloud-setup:
    @cd "$_PI_CLOUD_ROOT/pi-cloud" && npm ci --ignore-scripts && npm run check && npm run build

# Type-check pi-cloud.
cloud-check:
    @cd "$_PI_CLOUD_ROOT/pi-cloud" && npm run check

# Compile pi-cloud (not required to run the commands below).
cloud-build:
    @cd "$_PI_CLOUD_ROOT/pi-cloud" && npm run build

# Register the absolute local package with pi; optionally pass --local.
[no-cd]
cloud-install-extension *args:
    @pi install "$_PI_CLOUD_ROOT/pi-cloud" "$@"

# Remove that package registration; use --local if installed locally.
[no-cd]
cloud-remove-extension *args:
    @pi remove "$_PI_CLOUD_ROOT/pi-cloud" "$@"

# Run any CLI command, e.g. just cloud --help. Paths remain caller-relative.
[no-cd]
cloud *args:
    @node "$_PI_CLOUD_ROOT/pi-cloud/src/cli.ts" "$@"

# Start the server in the foreground; accepts --data, --host and --port.
[no-cd]
cloud-server-start *args:
    @node "$_PI_CLOUD_ROOT/pi-cloud/src/cli.ts" server start "$@"

# Print only the one-use token to stdout; accepts --data DIR.
[no-cd]
cloud-server-enroll name *args:
    @node "$_PI_CLOUD_ROOT/pi-cloud/src/cli.ts" server enroll "$@"

# List enrolled devices; accepts --data DIR.
[no-cd]
cloud-server-devices *args:
    @node "$_PI_CLOUD_ROOT/pi-cloud/src/cli.ts" server devices "$@"

# Revoke a device; accepts --data DIR.
[no-cd]
cloud-server-revoke device *args:
    @node "$_PI_CLOUD_ROOT/pi-cloud/src/cli.ts" server revoke "$@"

# Run a just recipe in a remote checkout (e.g. cloud-setup or cloud-server-enroll NAME).
[no-cd]
cloud-remote host checkout +args:
    #!/usr/bin/env bash
    set -euo pipefail
    # SSH passes a command through a remote shell; quote every argument for that shell too.
    shell_quote() { printf "'%s'" "${1//\'/\'\\\'\'}"; }
    remote="cd -- $(shell_quote "$2") && just"
    for argument in "${@:3}"; do remote+=" $(shell_quote "$argument")"; done
    exec ssh -- "$1" "$remote"

# Enroll remotely and log in locally without exposing the token in arguments or files.
[no-cd]
cloud-login-ssh host checkout url name:
    #!/usr/bin/env bash
    set -euo pipefail
    just --justfile "$_PI_CLOUD_ROOT/justfile" cloud-remote "$1" "$2" cloud-server-enroll "$4" \
        | just --justfile "$_PI_CLOUD_ROOT/justfile" cloud-login "$3" --name "$4"

# Read a token from stdin: just cloud-server-enroll NAME | just cloud-login URL.
[no-cd]
cloud-login url *args:
    @node "$_PI_CLOUD_ROOT/pi-cloud/src/cli.ts" login --token-stdin "$@"

# Revoke this device and forget its credential.
[no-cd]
cloud-logout:
    @node "$_PI_CLOUD_ROOT/pi-cloud/src/cli.ts" logout

# Show a safe client profile summary.
[no-cd]
cloud-status:
    @node "$_PI_CLOUD_ROOT/pi-cloud/src/cli.ts" status

# List registered projects.
[no-cd]
cloud-projects:
    @node "$_PI_CLOUD_ROOT/pi-cloud/src/cli.ts" project list

# Map a local workspace; root is caller-relative. Accepts --id PROJECT-ID.
[no-cd]
cloud-project-add name root *args:
    @node "$_PI_CLOUD_ROOT/pi-cloud/src/cli.ts" project add "$@"

# Track a session file; optionally pass --project PROJECT-ID for a mapped project.
[no-cd]
cloud-track file *args:
    @node "$_PI_CLOUD_ROOT/pi-cloud/src/cli.ts" track "$@"

# Stop uploads for a session file, retaining its cloud history.
[no-cd]
cloud-untrack file:
    @node "$_PI_CLOUD_ROOT/pi-cloud/src/cli.ts" untrack "$@"

# List local session bindings.
[no-cd]
cloud-bindings:
    @node "$_PI_CLOUD_ROOT/pi-cloud/src/cli.ts" bindings

# Sync once; accepts the explicit --once option too.
[no-cd]
cloud-sync *args:
    @node "$_PI_CLOUD_ROOT/pi-cloud/src/cli.ts" sync "$@"

# List cached conversations and revision heads.
[no-cd]
cloud-sessions:
    @node "$_PI_CLOUD_ROOT/pi-cloud/src/cli.ts" sessions

# Review a revision's target; pass --yes to fork. Accepts --workspace ROOT or --cwd DIR.
[no-cd]
cloud-resume revision *args:
    @node "$_PI_CLOUD_ROOT/pi-cloud/src/cli.ts" resume "$@"

# Resume into the caller's directory, bypassing mapping; still requires explicit --yes.
[no-cd]
cloud-resume-here revision *args:
    @node "$_PI_CLOUD_ROOT/pi-cloud/src/cli.ts" resume --here "$@"

# Delete cloud history only when --yes is explicitly supplied; native files remain.
[no-cd]
cloud-delete conversation *args:
    @node "$_PI_CLOUD_ROOT/pi-cloud/src/cli.ts" delete "$@"

# Forward loopback ports over SSH in the foreground: just cloud-tunnel user@host [localport] [remoteport].
[no-cd]
cloud-tunnel host localport='4210' remoteport='4210':
    @ssh -N -T -o ExitOnForwardFailure=yes -L "127.0.0.1:$2:127.0.0.1:$3" -- "$1"

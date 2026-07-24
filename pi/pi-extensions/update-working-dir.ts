import * as path from "node:path";
import { existsSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Moves the *current* session to a new working directory. This is for the
// "resume a session from elsewhere, then pull it into the dir I'm in now"
// flow: pi in a new directory shows sessions matched by cwd, autocommit runs
// against the session's cwd, and the status bar displays it. None of that
// updates just by /resume-ing an old session file, since /resume keeps the
// cwd stored in that session's header.
//
// Implementation forks the session (SessionManager.forkFrom): it copies the
// full history into a new session file under the target directory's default
// session directory, with its header cwd set to the target and
// parentSession pointing back at the original file. The original file is
// left untouched, so this is non-destructive — if forkFrom picked the wrong
// directory you still have the original session to fork again.
export default function (pi: ExtensionAPI) {
	pi.registerCommand("update_working_dir", {
		description: "Move the current session to a new working directory (default: pi's actual cwd)",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("This session isn't persisted to a file yet; nothing to move.", "error");
				return;
			}

			const targetArg = args.trim();
			// process.cwd() is the directory pi's process actually started in,
			// which is what we want by default — ctx.cwd reflects the session's
			// stored cwd, which after /resume-ing an old session is still the
			// *old* directory, not the one the user is sitting in now.
			const newCwd = path.resolve(targetArg || process.cwd());

			if (!existsSync(newCwd)) {
				ctx.ui.notify(`Target directory does not exist: ${newCwd}`, "error");
				return;
			}

			const oldCwd = path.resolve(ctx.sessionManager.getCwd());
			if (oldCwd === newCwd) {
				ctx.ui.notify(`Session already uses working directory ${newCwd}`, "info");
				return;
			}

			let forked: SessionManager;
			try {
				forked = SessionManager.forkFrom(sessionFile, newCwd);
			} catch (error) {
				ctx.ui.notify(
					`Failed to move session: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}

			const newSessionFile = forked.getSessionFile();
			if (!newSessionFile) {
				ctx.ui.notify("Failed to move session: forked session has no file path.", "error");
				return;
			}

			const result = await ctx.switchSession(newSessionFile, {
				withSession: async (replacedCtx) => {
					replacedCtx.ui.notify(`Session moved to ${newCwd}`, "info");
				},
			});
			if (result.cancelled) {
				ctx.ui.notify("Working directory update was cancelled by another extension.", "warning");
			}
		},
	});
}

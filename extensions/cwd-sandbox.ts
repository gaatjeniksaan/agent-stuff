/**
 * cwd-sandbox
 *
 * Confines pi's file-touching tools to the directory pi was launched in
 * (and nested folders). Blocks read/write/edit on paths outside the root,
 * and blocks bash invocations whose cwd resolves outside the root.
 *
 * NOTE: This is a *path guard*, not a kernel sandbox. A bash command can
 * still escape via `cd ..`, absolute paths inside the script body, etc.
 * For true isolation, use the bundled `sandbox` extension instead
 * (examples/extensions/sandbox in the pi-coding-agent package).
 */

import { isAbsolute, resolve, relative, sep } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// Lock root to the directory pi was started in.
	const ROOT = process.cwd();

	function insideRoot(p: string, base: string = ROOT): boolean {
		const abs = isAbsolute(p) ? p : resolve(base, p);
		const rel = relative(ROOT, abs);
		// Inside root if relative path doesn't start with ".." and isn't absolute
		return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
	}

	// Heuristics for bash commands that try to escape the root.
	function bashLooksEscaping(command: string): string | null {
		// Strip quoted strings to reduce false positives on `echo "../foo"`
		const stripped = command
			.replace(/'[^']*'/g, "''")
			.replace(/"[^"]*"/g, '""');

		// `cd` to absolute path outside root, or to ~ / $HOME
		const cdMatches = stripped.matchAll(/(?:^|[;&|]|\&\&|\|\|)\s*cd\s+([^\s;&|]+)/g);
		for (const m of cdMatches) {
			const target = m[1].replace(/^~\/?/, `${process.env.HOME ?? ""}/`).replace(/^\$HOME/, process.env.HOME ?? "");
			if (target === "~" || target === "$HOME") return `cd to home`;
			if (isAbsolute(target) && !insideRoot(target)) return `cd to outside root: ${target}`;
			if (!isAbsolute(target) && !insideRoot(target)) return `cd traversal escapes root: ${target}`;
		}

		// Common destructive / system-wide patterns
		const danger = [
			/\bsudo\b/,
			/\brm\s+-rf\s+\//,
			/(^|\s)>\s*\/(?!tmp\/|dev\/null)/, // redirect to absolute path outside /tmp or /dev/null
		];
		for (const re of danger) {
			if (re.test(stripped)) return `dangerous pattern: ${re}`;
		}
		return null;
	}

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("cwd-sandbox", ctx.ui.theme.fg("accent", `🔒 sandbox: ${ROOT}`));
		ctx.ui.notify(`cwd-sandbox active. Root: ${ROOT}`, "info");
	});

	pi.on("tool_call", async (event, ctx) => {
		// Path-based built-in tools
		if (event.toolName === "read" || event.toolName === "write" || event.toolName === "edit") {
			const p = (event.input as { path?: string }).path;
			if (typeof p === "string" && !insideRoot(p)) {
				if (ctx.hasUI) ctx.ui.notify(`Blocked ${event.toolName}: ${p} outside ${ROOT}`, "warning");
				return { block: true, reason: `Path "${p}" is outside sandbox root ${ROOT}` };
			}
		}

		// Bash tool
		if (event.toolName === "bash") {
			const input = event.input as { command?: string; cwd?: string };
			const bashCwd = input.cwd ?? ROOT;
			if (!insideRoot(bashCwd)) {
				if (ctx.hasUI) ctx.ui.notify(`Blocked bash: cwd ${bashCwd} outside ${ROOT}`, "warning");
				return { block: true, reason: `bash cwd "${bashCwd}" is outside sandbox root ${ROOT}` };
			}
			if (typeof input.command === "string") {
				const why = bashLooksEscaping(input.command);
				if (why) {
					if (ctx.hasUI) ctx.ui.notify(`Blocked bash (${why})`, "warning");
					return { block: true, reason: `bash blocked by sandbox: ${why}` };
				}
			}
		}

		return undefined;
	});

	// Also guard user `!` / `!!` shell escapes.
	pi.on("user_bash", (event, ctx) => {
		if (!insideRoot(event.cwd)) {
			ctx.ui?.notify(`Blocked user bash: cwd ${event.cwd} outside ${ROOT}`, "warning");
			return {
				result: {
					output: `cwd-sandbox: blocked. cwd ${event.cwd} is outside ${ROOT}`,
					exitCode: 1,
					cancelled: false,
					truncated: false,
				},
			};
		}
		const why = bashLooksEscaping(event.command);
		if (why) {
			ctx.ui?.notify(`Blocked user bash (${why})`, "warning");
			return {
				result: {
					output: `cwd-sandbox: blocked. ${why}`,
					exitCode: 1,
					cancelled: false,
					truncated: false,
				},
			};
		}
		return undefined;
	});

	pi.registerCommand("sandbox-root", {
		description: "Show cwd-sandbox root",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`Sandbox root: ${ROOT}`, "info");
		},
	});
}

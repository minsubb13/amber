// Amber for pi: the same sensors and enforcers the Claude Code and Codex hooks
// run (plugin/lib), driven by pi extension events instead of hook processes.
//
//   S0 (SessionStart)     <- session_start (startup/new/resume/fork) and
//                            session_compact; the briefing is held and handed
//                            to the model as a hidden `amber` message before
//                            the next model request
//   S1 (UserPromptSubmit) <- input (typed /amber:<name> or /skill:amber-<name>)
//   S2 (Stop)             <- agent_before_settle; a block becomes a visible
//                            `amber` message plus one continuation
//   S3 (Skill recorder)   <- tool_call `read` of plugin/pi/skills/amber-<name>/SKILL.md
//   E1 (PreToolUse)       <- tool_call bash/powershell (Bash) and write/edit
//
// The handlers are the compiled CommonJS modules every host shares, so the
// ledger rows, state files, briefings and refusals are word for word the same.
// Like the hooks, a crash fails open and leaves a breadcrumb in
// sensor-failures.log; broken contract state still fails closed through E1.
//
// Subagents: pi has none built in. A child pi started with AMBER_AGENT_ID (and
// AMBER_PARENT_SESSION_ID) acts as that agent of the parent session: E1 sees
// the agent id (claim handshake, unit scope) and S0/S1/S2 stay silent, as a
// Claude Code subagent fires no SessionStart or Stop.

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type HookEvent = "S0" | "S1" | "S2" | "S3" | "E1";
type HookOutput = Record<string, unknown> | null;
type Handler = (input: unknown) => HookOutput;

const PI_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(PI_DIR, "..");
const SKILLS_DIR = path.join(PI_DIR, "skills");
const requireCjs = createRequire(import.meta.url);

const lib = (name: string): Record<string, unknown> => requireCjs(path.join(PLUGIN_ROOT, "lib", name + ".cjs"));
const inputs = lib("hook-input") as { hookInput(raw: unknown, event: HookEvent): unknown };
const state = lib("state-store") as {
	FAILURES_FILE: string;
	ensureDirs(): void;
	sessionStatePath(id: unknown): string;
	readSessionState(id: unknown): unknown;
	writeStateAtomic(file: string, value: unknown): void;
};
const handlers: Record<HookEvent, Handler> = {
	S0: (lib("session-start") as { runS0: Handler }).runS0,
	S1: (lib("prompt-submit") as { runS1: Handler }).runS1,
	S2: (lib("stop-gate") as { runS2: Handler }).runS2,
	S3: (lib("skill-recorder") as { runS3: Handler }).runS3,
	E1: (lib("enforcer") as { runE1: Handler }).runE1,
};

const AGENT_ID = (process.env.AMBER_AGENT_ID || "").trim() || null;
const PARENT_SESSION_ID = (process.env.AMBER_PARENT_SESSION_ID || "").trim() || null;

/** Typed /skill:amber-<name> reads as the /amber:<name> the shared S1 matches. */
const SKILL_COMMAND = /^\/skill:amber-([a-z]+)\b/;
/** Typed /amber:<name>, which pi itself does not know: rewritten to the skill command. */
const AMBER_COMMAND = /^\/amber:([a-z]+)\b/;
const AMBER_SKILLS = new Set(["planning", "set", "init", "status", "mark", "audit"]);

function recordCrash(event: string, err: unknown): void {
	try {
		state.ensureDirs();
		const message = err instanceof Error ? err.message : String(err);
		fs.appendFileSync(
			state.FAILURES_FILE,
			new Date().toISOString() + " hook-crash event=" + event + " host=pi " + message.slice(0, 200) + "\n",
			{ mode: 0o600 },
		);
	} catch {
		// Nowhere to record it.
	}
}

/** Runs one shared handler; a crash fails open (null) and leaves a breadcrumb. */
function run(event: HookEvent, raw: Record<string, unknown>): HookOutput {
	try {
		return handlers[event](inputs.hookInput(raw, event));
	} catch (err) {
		recordCrash(event, err);
		return null;
	}
}

function field(value: unknown, ...keys: string[]): unknown {
	let v = value;
	for (const k of keys) {
		if (!v || typeof v !== "object") return undefined;
		v = (v as Record<string, unknown>)[k];
	}
	return v;
}

/** Resolves a tool path the way pi's file tools do (leading @, ~, cwd-relative). */
function resolveToolPath(raw: unknown, cwd: string): string {
	let p = typeof raw === "string" ? raw.trim() : "";
	if (!p) return "";
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~") p = os.homedir();
	else if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
	return path.resolve(cwd, p);
}

/** The Amber skill a read targets: plugin/pi/skills/amber-<name>/SKILL.md. */
function skillOfRead(abs: string): string | null {
	if (path.dirname(path.dirname(abs)) !== SKILLS_DIR || path.basename(abs) !== "SKILL.md") return null;
	const m = /^amber-([a-z]+)$/.exec(path.basename(path.dirname(abs)));
	return m && m[1] && AMBER_SKILLS.has(m[1]) ? m[1] : null;
}

export default function amber(pi: ExtensionAPI) {
	/** Briefings (S0, S1) waiting for the next model request. */
	let pending: string[] = [];
	/** Claude's stop_hook_active: this stop follows a continuation S2 asked for. */
	let continued = false;
	/** Skills already recorded for the current prompt (a re-read is not a new call). */
	let recordedSkills = new Set<string>();

	const sessionId = (ctx: ExtensionContext): string => PARENT_SESSION_ID || ctx.sessionManager.getSessionId();
	const base = (ctx: ExtensionContext): Record<string, unknown> => ({
		session_id: sessionId(ctx),
		cwd: ctx.cwd,
	});

	const queueContext = (output: HookOutput): void => {
		const text = field(output, "hookSpecificOutput", "additionalContext");
		if (typeof text === "string" && text) pending.push(text);
	};
	const takePending = (): string | null => {
		if (pending.length === 0) return null;
		const text = pending.join("\n\n");
		pending = [];
		return text;
	};

	const updateStatus = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		try {
			const contracts = lib("contract") as { contractInfo(cwd: string): Record<string, unknown> };
			const info = contracts.contractInfo(ctx.cwd);
			const label = info.broken
				? "amber: broken contract pointer"
				: typeof info.boundaryFile === "string" && info.boundaryFile
					? "amber: " + info.boundaryFile
					: undefined;
			ctx.ui.setStatus("amber", label);
		} catch {
			// Status is cosmetic.
		}
	};

	const sessionStart = (ctx: ExtensionContext): void => {
		if (AGENT_ID) return;
		queueContext(run("S0", { ...base(ctx), model: ctx.model?.id }));
		updateStatus(ctx);
	};

	pi.on("session_start", async (event, ctx) => {
		process.env.AMBER_PLUGIN_ROOT = PLUGIN_ROOT;
		pending = [];
		continued = false;
		// A reload keeps the conversation that already holds the briefing.
		if (event.reason !== "reload") sessionStart(ctx);
		else updateStatus(ctx);
	});

	// Claude Code re-runs SessionStart after compaction; so does Amber on pi.
	pi.on("session_compact", async (_event, ctx) => {
		sessionStart(ctx);
	});

	// The ledger reads the model from the session state S0 wrote.
	pi.on("model_select", async (event, ctx) => {
		if (AGENT_ID) return;
		try {
			const id = sessionId(ctx);
			const current = state.readSessionState(id);
			if (!current || typeof current !== "object" || Array.isArray(current)) return;
			(current as Record<string, unknown>).model = event.model.id;
			state.ensureDirs();
			state.writeStateAtomic(state.sessionStatePath(id), current);
		} catch (err) {
			recordCrash("model_select", err);
		}
	});

	// S1: typed calls are recorded from the raw prompt, before pi expands
	// /skill: commands; /amber:<name> is rewritten to the skill command.
	pi.on("input", async (event, ctx) => {
		if (AGENT_ID) return { action: "continue" as const };
		const text = event.text;
		const typed = AMBER_COMMAND.exec(text);
		const skill = SKILL_COMMAND.exec(text);
		const prompt = skill && skill[1] && AMBER_SKILLS.has(skill[1]) ? "/amber:" + text.slice("/skill:amber-".length) : text;
		queueContext(run("S1", { ...base(ctx), prompt }));
		if (typed && typed[1] && AMBER_SKILLS.has(typed[1])) {
			return { action: "transform" as const, text: "/skill:amber-" + text.slice("/amber:".length) };
		}
		return { action: "continue" as const };
	});

	pi.on("before_agent_start", async (event) => {
		if (event.messageType === "user") {
			continued = false;
			recordedSkills = new Set();
		}
		const text = takePending();
		if (!text) return;
		return { message: { customType: "amber", content: text, display: false } };
	});

	// A briefing that arrived mid-run (compaction during tool calls).
	pi.on("turn_end", async () => {
		const text = takePending();
		if (!text) return;
		return { entries: [{ type: "custom_message" as const, customType: "amber", content: text, display: false }] };
	});

	pi.on("tool_call", async (event, ctx) => {
		const name = event.toolName;
		const input = event.input as Record<string, unknown>;
		if (name === "read") {
			const skill = skillOfRead(resolveToolPath(input.path, ctx.cwd));
			// mark is recorded by its recorder command, never by loading the skill.
			if (skill && skill !== "mark" && !recordedSkills.has(skill)) {
				recordedSkills.add(skill);
				run("S3", { ...base(ctx), tool_name: "Skill", tool_input: { skill: "amber:" + skill } });
			}
			return;
		}
		let raw: Record<string, unknown>;
		if (name === "bash" || name === "powershell") {
			raw = { tool_name: "Bash", tool_input: { command: input.command } };
		} else if (name === "write" || name === "edit") {
			raw = {
				tool_name: name === "write" ? "Write" : "Edit",
				tool_input: { file_path: resolveToolPath(input.path, ctx.cwd) },
			};
		} else {
			return;
		}
		const output = run("E1", { ...base(ctx), ...raw, ...(AGENT_ID ? { agent_id: AGENT_ID } : {}) });
		if (field(output, "hookSpecificOutput", "permissionDecision") === "deny") {
			const reason = field(output, "hookSpecificOutput", "permissionDecisionReason");
			return { block: true, reason: typeof reason === "string" ? reason : "amber: blocked" };
		}
		return;
	});

	// S2: the completion gate and the loop body. Claude's Stop hook does not
	// fire for an interrupted or failed turn, so neither does this one.
	pi.on("agent_before_settle", async (event, ctx) => {
		if (AGENT_ID || event.outcome !== "completed") return;
		const output = run("S2", { ...base(ctx), stop_hook_active: continued });
		const reason = field(output, "reason");
		if (field(output, "decision") === "block" && typeof reason === "string") {
			continued = true;
			return {
				entries: [{ type: "custom_message" as const, customType: "amber", content: reason, display: true }],
				continue: true,
			};
		}
		continued = false;
		return;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		updateStatus(ctx);
	});
}

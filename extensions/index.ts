import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type Stage = "idle" | "working" | "waiting" | "error";
type EffectMode = "solid" | "blink" | "fade" | "frontback";
type VisualState = Stage | "off";

interface StageSettings {
	color: string;
	mode: EffectMode;
}

interface Blink1PiConfig {
	version: 1;
	stages: Record<Stage, StageSettings>;
}

const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const BLINK1_TOOL = process.env.BLINK1_TOOL_PATH ?? join(homedir(), ".local", "bin", "blink1-tool");
const CONFIG_PATH =
	process.env.BLINK1_PI_CONFIG_PATH ?? join(PI_AGENT_DIR, "extensions", "blink1-pi", "config.json");
const SOLID_FADE_MS = 100;
const BLINK_FADE_MS = 50;
const BLINK_INTERVAL_MS = 500;
const PULSE_FADE_MS = 900;
const PULSE_INTERVAL_MS = 1050;
const FRONTBACK_FADE_MS = 500;
const FRONTBACK_PATTERN_START = 29;
const FRONTBACK_PATTERN_END = 31;
const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const SUBAGENT_PROCESS_TERMINAL_EVENT = "subagent:process-terminal";

const STAGES: Stage[] = ["idle", "working", "waiting", "error"];
const MODES: EffectMode[] = ["solid", "blink", "fade", "frontback"];
const STAGE_LABELS: Record<Stage, string> = {
	idle: "Idle / ready",
	working: "Model / agent running",
	waiting: "Waiting for user",
	error: "Error",
};
const MODE_LABELS: Record<EffectMode, string> = {
	solid: "Solid",
	blink: "Blinking",
	fade: "Fading in/out",
	frontback: "Front/back fade",
};
const NAMED_COLORS: Record<string, string> = {
	black: "000000",
	white: "ffffff",
	red: "ff0000",
	green: "00ff00",
	blue: "0000ff",
	yellow: "ffff00",
	cyan: "00ffff",
	magenta: "ff00ff",
	purple: "8000ff",
	orange: "ff8000",
	pink: "ff4080",
	off: "000000",
	disabled: "000000",
};
const SETTINGS_COLOR_CHOICES = [
	{ label: "Red", color: NAMED_COLORS.red },
	{ label: "Green", color: NAMED_COLORS.green },
	{ label: "Blue", color: NAMED_COLORS.blue },
	{ label: "Cyan", color: NAMED_COLORS.cyan },
	{ label: "Magenta", color: NAMED_COLORS.magenta },
	{ label: "Yellow", color: NAMED_COLORS.yellow },
	{ label: "Off / disabled", color: NAMED_COLORS.off },
] as const;

function defaultConfig(): Blink1PiConfig {
	return {
		version: 1,
		stages: {
			idle: { color: "00ff00", mode: "solid" },
			working: { color: "ffff00", mode: "solid" },
			waiting: { color: "0000ff", mode: "solid" },
			error: { color: "ff0000", mode: "solid" },
		},
	};
}

function normalizeColor(value: string): string | undefined {
	const input = value.trim().toLowerCase();
	const named = NAMED_COLORS[input];
	if (named) return named;

	const hex = input.replace(/^#/, "");
	if (/^[0-9a-f]{3}$/.test(hex)) {
		return [...hex].map((digit) => digit + digit).join("");
	}
	return /^[0-9a-f]{6}$/.test(hex) ? hex : undefined;
}

function normalizeMode(value: string): EffectMode | undefined {
	switch (value.trim().toLowerCase()) {
		case "solid":
			return "solid";
		case "blink":
		case "blinking":
			return "blink";
		case "fade":
		case "fading":
		case "pulse":
		case "pulsing":
		case "breathing":
			return "fade";
		case "frontback":
		case "front-back":
		case "front/back":
		case "sweep":
			return "frontback";
		default:
			return undefined;
	}
}

function normalizeStage(value: string): Stage | undefined {
	switch (value.trim().toLowerCase()) {
		case "idle":
		case "ready":
			return "idle";
		case "working":
		case "running":
		case "model":
			return "working";
		case "waiting":
		case "question":
		case "prompt":
			return "waiting";
		case "error":
		case "failed":
		case "failure":
			return "error";
		default:
			return undefined;
	}
}

function validatedConfig(value: unknown): Blink1PiConfig {
	const defaults = defaultConfig();
	if (!value || typeof value !== "object") return defaults;

	const input = value as { stages?: Record<string, unknown> };
	for (const stage of STAGES) {
		const candidate = input.stages?.[stage];
		if (!candidate || typeof candidate !== "object") continue;
		const settings = candidate as { color?: unknown; mode?: unknown };
		const color = typeof settings.color === "string" ? normalizeColor(settings.color) : undefined;
		const mode = typeof settings.mode === "string" ? normalizeMode(settings.mode) : undefined;
		if (color) defaults.stages[stage].color = color;
		if (mode) defaults.stages[stage].mode = mode;
		if (defaults.stages[stage].color === "000000") defaults.stages[stage].mode = "solid";
	}
	return defaults;
}

function stageSettingsSummary(settings: StageSettings): string {
	return settings.color === "000000" ? "Off / disabled" : `#${settings.color} · ${MODE_LABELS[settings.mode]}`;
}

function configSummary(config: Blink1PiConfig): string {
	return STAGES.map((stage) => `${STAGE_LABELS[stage]}: ${stageSettingsSummary(config.stages[stage])}`).join("\n");
}

function helpText(): string {
	return [
		"blink1-pi commands:",
		"/blink1-pi                         Interactive configuration",
		"/blink1-pi show                    Show current settings",
		"/blink1-pi set <stage> <color> [solid|blink|fade|frontback]",
		"/blink1-pi set <stage> off         Disable light for that stage",
		"/blink1-pi test [stage]            Preview configured effects",
		"/blink1-pi off                     Turn off until the next agent run",
		"/blink1-pi reset                   Restore default colors and modes",
		"",
		"Stages: idle, working, waiting, error",
		`Named colors: ${Object.keys(NAMED_COLORS).join(", ")}; #RGB and #RRGGBB also work.`,
	].join("\n");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function eventIdentifier(payload: unknown, keys: string[]): string | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const record = payload as Record<string, unknown>;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

export default function blink1Pi(pi: ExtensionAPI) {
	// Background pi-subagents load ambient extensions inside each child process.
	// The root session alone owns the physical device and represents child work.
	if (process.env[SUBAGENT_CHILD_ENV] === "1") return;

	let config = defaultConfig();
	let active = false;
	let waitingDepth = 0;
	let runFailed = false;
	let shuttingDown = false;
	let offUntilNextRun = false;
	let previewStage: Stage | undefined;
	let activeVisualKey: string | undefined;
	let effectGeneration = 0;
	let effectTimer: ReturnType<typeof setTimeout> | undefined;
	let commandQueue: Promise<void> = Promise.resolve();
	let failureLogged = false;
	const activeAsyncSubagentRuns = new Set<string>();

	async function loadConfig(): Promise<void> {
		try {
			config = validatedConfig(JSON.parse(await readFile(CONFIG_PATH, "utf8")));
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
			if (code !== "ENOENT") {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`[blink1-pi] Unable to read ${CONFIG_PATH}; using defaults: ${message}`);
			}
			config = defaultConfig();
		}
	}

	async function saveConfig(): Promise<void> {
		await mkdir(dirname(CONFIG_PATH), { recursive: true });
		const temporaryPath = `${CONFIG_PATH}.${process.pid}.tmp`;
		await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
		await rename(temporaryPath, CONFIG_PATH);
	}

	function currentVisualState(): VisualState {
		if (shuttingDown) return "off";
		if (previewStage) return previewStage;
		if (offUntilNextRun) return "off";
		if (waitingDepth > 0) return "waiting";
		if (runFailed) return "error";
		if (active || activeAsyncSubagentRuns.size > 0) return "working";
		return "idle";
	}

	function stopEffect(): number {
		effectGeneration++;
		if (effectTimer) clearTimeout(effectTimer);
		effectTimer = undefined;
		return effectGeneration;
	}

	function queueBlink1Command(args: string[], generation: number, action: string): Promise<void> {
		commandQueue = commandQueue.then(async () => {
			if (generation !== effectGeneration) return;

			try {
				const result = await pi.exec(BLINK1_TOOL, ["--quiet", ...args], { timeout: 3000 });
				if (result.code !== 0) {
					throw new Error((result.stderr || result.stdout || `exit code ${result.code}`).trim());
				}
				failureLogged = false;
			} catch (error) {
				if (!failureLogged) {
					const message = error instanceof Error ? error.message : String(error);
					console.error(`[blink1-pi] Unable to ${action}: ${message}`);
					failureLogged = true;
				}
			}
		});
		return commandQueue;
	}

	function queueColor(color: string, fadeMs: number, generation: number): Promise<void> {
		return queueBlink1Command([`--millis=${fadeMs}`, `--rgb=${color}`], generation, "set light color");
	}

	function queueStopHardwarePattern(generation: number): Promise<void> {
		return queueBlink1Command(["--play", "0"], generation, "stop hardware pattern");
	}

	function queuePatternLine(
		position: number,
		color: string,
		led: 0 | 1 | 2,
		generation: number,
	): Promise<void> {
		return queueBlink1Command(
			[
				`--led=${led}`,
				`--millis=${FRONTBACK_FADE_MS}`,
				`--rgb=${color}`,
				"--setpattline",
				String(position),
			],
			generation,
			`write hardware pattern line ${position}`,
		);
	}

	async function startFrontBackPattern(color: string, generation: number): Promise<void> {
		await queuePatternLine(FRONTBACK_PATTERN_START, color, 1, generation);
		await queuePatternLine(FRONTBACK_PATTERN_START + 1, color, 2, generation);
		await queuePatternLine(FRONTBACK_PATTERN_END, "000000", 0, generation);
		await queueBlink1Command(
			["--play", `1,${FRONTBACK_PATTERN_START},${FRONTBACK_PATTERN_END},0`],
			generation,
			"start front/back hardware pattern",
		);
	}

	function scheduleAlternatingEffect(
		color: string,
		fadeMs: number,
		intervalMs: number,
		on: boolean,
		generation: number,
	): Promise<void> {
		return queueColor(on ? color : "000000", fadeMs, generation).then(() => {
			if (generation !== effectGeneration) return;
			effectTimer = setTimeout(() => {
				void scheduleAlternatingEffect(color, fadeMs, intervalMs, !on, generation);
			}, intervalMs);
			effectTimer.unref?.();
		});
	}

	async function applyVisualState(state: VisualState, force = false): Promise<void> {
		const settings = state === "off" ? undefined : config.stages[state];
		const key = state === "off" ? "off" : `${state}:${settings.color}:${settings.mode}`;
		if (!force && key === activeVisualKey) return;
		activeVisualKey = key;

		const generation = stopEffect();
		await queueStopHardwarePattern(generation);
		if (generation !== effectGeneration) return;

		if (state === "off" || settings.color === "000000") {
			await queueColor("000000", 0, generation);
			return;
		}

		if (settings.mode === "solid") {
			await queueColor(settings.color, SOLID_FADE_MS, generation);
			return;
		}

		if (settings.mode === "blink") {
			await scheduleAlternatingEffect(settings.color, BLINK_FADE_MS, BLINK_INTERVAL_MS, true, generation);
			return;
		}

		if (settings.mode === "fade") {
			await scheduleAlternatingEffect(settings.color, PULSE_FADE_MS, PULSE_INTERVAL_MS, true, generation);
			return;
		}

		await startFrontBackPattern(settings.color, generation);
	}

	function refreshLight(force = false): Promise<void> {
		return applyVisualState(currentVisualState(), force);
	}

	function handleAsyncSubagentStarted(payload: unknown): void {
		const runId = eventIdentifier(payload, ["runId", "id"]);
		if (!runId || activeAsyncSubagentRuns.has(runId)) return;
		activeAsyncSubagentRuns.add(runId);
		void refreshLight();
	}

	function handleAsyncSubagentFinished(payload: unknown): void {
		const runId = eventIdentifier(payload, ["runId", "id"]);
		if (!runId || !activeAsyncSubagentRuns.delete(runId)) return;
		void refreshLight();
	}

	const subagentEventUnsubscribes = [
		pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, handleAsyncSubagentStarted),
		pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, handleAsyncSubagentFinished),
		pi.events.on(SUBAGENT_PROCESS_TERMINAL_EVENT, handleAsyncSubagentFinished),
	];

	async function configureStageInteractively(stage: Stage, ctx: ExtensionCommandContext): Promise<void> {
		const current = config.stages[stage];
		const presetOptions = SETTINGS_COLOR_CHOICES.map(
			({ label, color }) => `${label} (#${color})${color === current.color ? " (current)" : ""}`,
		);
		const customOption = `Custom #RGB/#RRGGBB${presetOptions.some((option) => option.endsWith("(current)")) ? "" : ` (current: #${current.color})`}`;
		const colorChoice = await ctx.ui.select(`Color for ${STAGE_LABELS[stage]}`, [...presetOptions, customOption]);
		if (!colorChoice) return;

		const presetIndex = presetOptions.indexOf(colorChoice);
		let color: string | undefined;
		if (presetIndex >= 0) {
			color = SETTINGS_COLOR_CHOICES[presetIndex].color;
		} else {
			const colorInput = await ctx.ui.input(
				`Custom color for ${STAGE_LABELS[stage]}`,
				`#RGB or #RRGGBB (current: #${current.color})`,
			);
			if (colorInput === undefined) return;
			color = normalizeColor(colorInput);
			if (!color) {
				ctx.ui.notify(`Invalid color: ${colorInput}. Use #RGB or #RRGGBB.`, "error");
				return;
			}
		}

		let mode: EffectMode;
		if (color === "000000") {
			mode = "solid";
		} else {
			const choice = await ctx.ui.select(
				`Effect for ${STAGE_LABELS[stage]}`,
				MODES.map((candidate) => `${MODE_LABELS[candidate]}${candidate === current.mode ? " (current)" : ""}`),
			);
			if (!choice) return;

			const selectedMode = MODES.find((candidate) => choice.startsWith(MODE_LABELS[candidate]));
			if (!selectedMode) return;
			mode = selectedMode;
		}

		config.stages[stage] = { color, mode };
		await saveConfig();
		await refreshLight(true);
		ctx.ui.notify(`${STAGE_LABELS[stage]} set to ${stageSettingsSummary(config.stages[stage])}`, "info");
	}

	async function testStages(stages: Stage[], ctx: ExtensionCommandContext): Promise<void> {
		for (const stage of stages) {
			previewStage = stage;
			ctx.ui.notify(`Testing ${STAGE_LABELS[stage]}: ${stageSettingsSummary(config.stages[stage])}`, "info");
			await refreshLight(true);
			await sleep(config.stages[stage].mode === "solid" ? 1500 : 3000);
		}
		previewStage = undefined;
		await refreshLight(true);
	}

	async function runInteractiveConfig(ctx: ExtensionCommandContext): Promise<void> {
		const stageChoices = STAGES.map(
			(stage) => `Configure ${STAGE_LABELS[stage]} · ${stageSettingsSummary(config.stages[stage])}`,
		);
		const choice = await ctx.ui.select("blink1-pi settings", [
			...stageChoices,
			"Turn light off until next agent run",
			"Test all stages",
			"Show configuration",
			"Reset defaults",
		]);
		if (!choice) return;

		const stageIndex = stageChoices.indexOf(choice);
		if (stageIndex >= 0) {
			await configureStageInteractively(STAGES[stageIndex], ctx);
			return;
		}
		if (choice === "Turn light off until next agent run") {
			offUntilNextRun = true;
			await refreshLight(true);
			ctx.ui.notify("blink1-pi is off until the next agent run.", "info");
			return;
		}
		if (choice === "Test all stages") {
			await testStages(STAGES, ctx);
			return;
		}
		if (choice === "Show configuration") {
			ctx.ui.notify(configSummary(config), "info");
			return;
		}
		if (choice === "Reset defaults") {
			const confirmed = await ctx.ui.confirm("Reset blink1-pi?", "Restore all default colors and solid modes?");
			if (!confirmed) return;
			config = defaultConfig();
			await saveConfig();
			await refreshLight(true);
			ctx.ui.notify("blink1-pi settings reset to defaults.", "info");
		}
	}

	pi.registerCommand("blink1-pi", {
		description: "Configure and test blink(1) lifecycle colors and effects",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			if (tokens.length === 0) {
				await runInteractiveConfig(ctx);
				return;
			}

			const action = tokens[0].toLowerCase();
			if (action === "help") {
				ctx.ui.notify(helpText(), "info");
				return;
			}
			if (action === "show" || action === "status") {
				ctx.ui.notify(configSummary(config), "info");
				return;
			}
			if (action === "off") {
				offUntilNextRun = true;
				await refreshLight(true);
				ctx.ui.notify("blink1-pi is off until the next agent run.", "info");
				return;
			}
			if (action === "reset") {
				config = defaultConfig();
				await saveConfig();
				await refreshLight(true);
				ctx.ui.notify("blink1-pi settings reset to defaults.", "info");
				return;
			}
			if (action === "test") {
				if (!tokens[1]) {
					await testStages(STAGES, ctx);
					return;
				}
				const stage = normalizeStage(tokens[1]);
				if (!stage) {
					ctx.ui.notify(`Unknown stage: ${tokens[1]}`, "error");
					return;
				}
				await testStages([stage], ctx);
				return;
			}
			if (action === "set") {
				const stage = tokens[1] ? normalizeStage(tokens[1]) : undefined;
				if (!stage) {
					ctx.ui.notify("Usage: /blink1-pi set <idle|working|waiting|error> <color> [solid|blink|fade|frontback]", "error");
					return;
				}
				if (!tokens[2]) {
					await configureStageInteractively(stage, ctx);
					return;
				}

				const color = normalizeColor(tokens[2]);
				const requestedMode = tokens[3] ? normalizeMode(tokens[3]) : config.stages[stage].mode;
				if (!color) {
					ctx.ui.notify(`Invalid color: ${tokens[2]}. Use a named color, #RGB, or #RRGGBB.`, "error");
					return;
				}
				if (!requestedMode) {
					ctx.ui.notify(`Invalid mode: ${tokens[3]}. Use solid, blink, fade, or frontback.`, "error");
					return;
				}

				const mode: EffectMode = color === "000000" ? "solid" : requestedMode;
				config.stages[stage] = { color, mode };
				await saveConfig();
				await refreshLight(true);
				ctx.ui.notify(`${STAGE_LABELS[stage]} set to ${stageSettingsSummary(config.stages[stage])}`, "info");
				return;
			}

			ctx.ui.notify(helpText(), "warning");
		},
	});

	pi.on("session_start", async () => {
		await loadConfig();
		activeAsyncSubagentRuns.clear();
		active = false;
		waitingDepth = 0;
		runFailed = false;
		shuttingDown = false;
		offUntilNextRun = false;
		previewStage = undefined;
		await refreshLight(true);
	});

	pi.on("agent_start", async () => {
		active = true;
		runFailed = false;
		offUntilNextRun = false;
		await refreshLight();
	});

	pi.on("ui_prompt_start", async () => {
		waitingDepth++;
		await refreshLight();
	});

	pi.on("ui_prompt_end", async () => {
		waitingDepth = Math.max(0, waitingDepth - 1);
		await refreshLight();
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;

		if (event.message.stopReason === "error" || event.message.stopReason === "length") {
			runFailed = true;
			await refreshLight();
		} else if (event.message.stopReason === "stop" || event.message.stopReason === "aborted") {
			runFailed = false;
		}
	});

	pi.on("session_compact_failed", async (event) => {
		if (event.aborted) return;
		runFailed = true;
		await refreshLight();
	});

	pi.on("agent_settled", async () => {
		active = false;
		await refreshLight();
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		active = false;
		activeAsyncSubagentRuns.clear();
		waitingDepth = 0;
		previewStage = undefined;
		await refreshLight(true);
		for (const unsubscribe of subagentEventUnsubscribes) unsubscribe();
	});
}

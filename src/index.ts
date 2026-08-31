/**
 * pi-quick-context
 *
 * Prints the session context inline in the chat, like /hotkeys:
 * loaded context files, skills, prompt templates, extension candidates, active tools,
 * session identity, and keybinding hints. Works independently of quietStartup.
 *
 * Usage:
 *   /context            Full context (session, keys, files, skills, prompts, extensions, tools)
 *   /context skills     All skill names
 *   /context prompts    All prompt template names
 *   /context extensions All enabled extension candidates
 *   Ctrl+Shift+H        Same as /context
 *
 * Skills, prompts, and tools come from pi's live runtime. Context files use
 * live system-prompt options when available, falling back to the effective
 * system prompt string. Extension candidates come from pi's settings-aware
 * package resolver.
 *
 * Install:
 *   pi install ~/Developer/pi-quick-context        # local checkout
 *   pi install git:github.com/<user>/pi-quick-context  # from GitHub
 *   pi install npm:pi-quick-context                # from npm
 */

import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	DefaultPackageManager,
	getAgentDir,
	keyHint,
	keyText,
	rawKeyHint,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { basename, dirname, relative } from "path";

/** Cap for skills in the full /context view; /context skills is uncapped. */
const SKILL_CAP = 40;

export function unescapeXml(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

/**
 * Recover loaded context files from the effective system prompt when
 * structured options are unavailable on the hotkey path.
 *
 * NOTE: This is a heuristic fallback that tracks the current pi prompt tags.
 * A pi format change breaks it silently; structured options always win.
 */
export function parseFromPrompt(prompt: string): {
	contextFiles: string[];
} {
	const contextFiles: string[] = [];
	for (const match of prompt.matchAll(/<project_instructions path="([^"]*)">/g)) {
		contextFiles.push(unescapeXml(match[1]));
	}
	return { contextFiles };
}

// ---------------------------------------------------------------------------
// Render helpers (ANSI-safe, width-aware)
// ---------------------------------------------------------------------------

// --- Display width -----------------------------------------------------------

/** Approximate terminal column width for a code point (0, 1, or 2 columns). */
export function isWideCodePoint(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
		(cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals .. Yijing hexagrams
		(cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
		(cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
		(cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
		(cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
		(cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
		(cp >= 0x1f300 && cp <= 0x1faff) || // Emoji (most)
		cp >= 0x20000 // CJK extensions B+
	);
}

export function charDisplayWidth(ch: string): number {
	// Combining marks, zero-width spaces, variation selectors, BOM: 0 columns.
	if (/[\u0300-\u036f\u200b-\u200f\ufe00-\ufe0f\ufeff]/.test(ch)) {
		return 0;
	}
	return isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1;
}

/** Visible column width of a line, ignoring ANSI escape sequences. */
export function displayWidth(text: string): number {
	let width = 0;
	let inEscape = false;
	for (const ch of text) {
		if (inEscape) {
			if (/[a-zA-Z]/.test(ch)) {
				inEscape = false;
			}
			continue;
		}
		if (ch === "\x1b") {
			inEscape = true;
			continue;
		}
		width += charDisplayWidth(ch);
	}
	return width;
}

// --- Wrapping / fitting -------------------------------------------------------

/** Wrap a list of short words into lines no wider than maxWidth columns. */
export function wrapWords(words: string[], maxWidth: number, prefix = ""): string[] {
	const lines: string[] = [];
	let current = prefix;
	let currentWidth = displayWidth(prefix);
	for (const word of words) {
		const sep = current === prefix || current === "" ? "" : " ";
		const wordWidth = displayWidth(word);
		if (currentWidth + sep.length + wordWidth > maxWidth && current !== prefix) {
			lines.push(current);
			current = `${prefix}${word}`;
			currentWidth = displayWidth(current);
		} else {
			current += sep + word;
			currentWidth += sep.length + wordWidth;
		}
	}
	if (current !== "") {
		lines.push(current);
	}
	return lines;
}

/**
 * Truncate a line to the given visual width, ignoring ANSI escape sequences.
 * Never cuts inside an escape sequence or a multibyte character. Re-closes
 * styling with a reset when truncation drops escape sequences, so colors do
 * not bleed past the ellipsis.
 */
export function fit(line: string, width: number): string {
	if (width <= 0) {
		return "";
	}
	const chars = Array.from(line); // Split into code points; surrogate pairs stay intact.
	let visual = 0;
	let cut = chars.length;
	let sawEscape = false;
	for (let i = 0; i < chars.length; i++) {
		if (chars[i] === "\x1b") {
			// Skip the full escape sequence: \x1b[ <params> <letter> (e.g. \x1b[38;2;128;128;128m).
			sawEscape = true;
			let j = i + 1;
			while (j < chars.length && !/[a-zA-Z]/.test(chars[j])) {
				j++;
			}
			i = j;
			continue;
		}
		visual += charDisplayWidth(chars[i]);
		if (visual > width - 1) {
			// Keep the last column for the ellipsis.
			cut = i;
			break;
		}
	}
	if (cut >= chars.length) {
		return line;
	}
	// Cut positions are always visible characters, so the kept prefix contains
	// only complete escape sequences; a reset safely closes any style whose
	// terminator was cut away.
	return `${chars.slice(0, cut).join("")}…${sawEscape ? "\x1b[0m" : ""}`;
}

// ---------------------------------------------------------------------------
// Resource enumeration
// ---------------------------------------------------------------------------

/** npm package name from a settings spec: "npm:pkg", "npm:pkg@1.0.0", "npm:@scope/pkg@1" */
export function npmName(spec: string): string {
	const name = spec.replace(/^npm:/, "");
	if (name.startsWith("@")) {
		const parts = name.split("@");
		return parts.slice(0, 2).join("@");
	}
	return name.split("@")[0];
}

/** Git clone path from a settings spec: "git:github.com/u/r@v1", "https://…", "ssh://…" */
export function gitPath(spec: string): string {
	const cleaned = spec
		.replace(/^git:/, "")
		.replace(/^ssh:\/\//, "")
		.replace(/^https?:\/\//, "")
		.replace(/^git@/, "")
		.replace(":", "/")
		.split("@")[0]
		.replace(/\.git$/, "");
	return cleaned
		.split("/")
		.filter(Boolean)
		.join("/");
}

/** List prompt template command names (without the leading slash). */
function listPrompts(pi: ExtensionAPI): string[] {
	return [...new Set(pi.getCommands().filter((command) => command.source === "prompt").map((command) => command.name))].sort();
}

/**
 * Extension display label, matching the startup header:
 * - a package's root ./index.ts renders as just the package name
 * - dir/index.ts renders as "package:dir"
 * - any other file renders as "package:filename"
 * - a plain file renders as its basename
 */
export function extensionLabel(pkg: string, rel: string): string {
	const norm = rel.replace(/^(\.\/)+/, "").replace(/^extensions\//, "");
	const base = basename(norm);
	if (base === "index.ts" || base === "index.js") {
		const dir = dirname(norm);
		return dir === "." ? pkg : `${pkg}:${dir}`;
	}
	return `${pkg}:${norm}`;
}

function resolvedExtensionLabel(
	path: string,
	metadata: { source: string; origin: "package" | "top-level"; baseDir?: string },
): string {
	const rel = relative(metadata.baseDir ?? dirname(path), path).replace(/\\/g, "/");
	if (metadata.source.startsWith("npm:")) {
		return extensionLabel(npmName(metadata.source), rel);
	}
	if (/^(git:|https?:\/\/|ssh:\/\/|git@)/.test(metadata.source)) {
		const parts = gitPath(metadata.source).split("/");
		return extensionLabel(parts.slice(1).join("/") || parts[0] || metadata.source, rel);
	}
	if (metadata.origin === "package" && metadata.baseDir) {
		return extensionLabel(basename(metadata.baseDir), rel);
	}
	const norm = rel.replace(/^extensions\//, "");
	const base = basename(norm);
	if (base !== "index.ts" && base !== "index.js") {
		return norm;
	}
	const dir = dirname(norm);
	return dir === "." ? basename(metadata.baseDir ?? dirname(path)) : dir;
}

/** Resolve enabled extension candidates without executing their factories. */
export async function listResolvedExtensions(cwd: string, agentDir: string, projectTrusted: boolean): Promise<string[]> {
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	const resolved = await packageManager.resolve(async () => "skip");
	const records = resolved.extensions
		.filter((resource) => resource.enabled)
		.map((resource) => ({
			resource,
			label: resolvedExtensionLabel(resource.path, resource.metadata),
		}));
	const labelCounts = new Map<string, number>();
	const scopedLabelCounts = new Map<string, number>();
	for (const record of records) {
		labelCounts.set(record.label, (labelCounts.get(record.label) ?? 0) + 1);
		const scopedLabel = `${record.resource.metadata.scope}:${record.label}`;
		scopedLabelCounts.set(scopedLabel, (scopedLabelCounts.get(scopedLabel) ?? 0) + 1);
	}
	return records.map((record, index) => {
		if (labelCounts.get(record.label) === 1) {
			return record.label;
		}
		const scopedLabel = `${record.resource.metadata.scope}:${record.label}`;
		if (scopedLabelCounts.get(scopedLabel) === 1) {
			return scopedLabel;
		}
		const segments = record.resource.path.replace(/\\/g, "/").split("/").filter(Boolean);
		for (let count = 2; count <= segments.length; count++) {
			const suffix = segments.slice(-count).join("/");
			const unique = records.every((other, otherIndex) => {
				if (otherIndex === index || other.label !== record.label || other.resource.metadata.scope !== record.resource.metadata.scope) {
					return true;
				}
				return !other.resource.path.replace(/\\/g, "/").endsWith(suffix);
			});
			if (unique) {
				return `${record.resource.metadata.scope}:${suffix}`;
			}
		}
		return `${record.resource.metadata.scope}:${record.resource.path.replace(/\\/g, "/")}`;
	});
}

/** List enabled extension candidates using pi's resolver. */
async function listExtensions(ctx: ExtensionContext): Promise<string[]> {
	try {
		return await listResolvedExtensions(ctx.cwd, getAgentDir(), ctx.isProjectTrusted());
	} catch {
		ctx.ui.notify("Could not resolve extension candidates.", "warning");
		return [];
	}
}

// ---------------------------------------------------------------------------
// Entry data
// ---------------------------------------------------------------------------

/** A generic section whose items are printed wrapped, one line per word-block. */
interface ItemSection {
	kind: "items";
	title: string;
	items: string[];
	/** Prefix each item with "/" when printed. */
	slash?: boolean;
	/** Per-item descriptions shown when the entry is expanded (ctrl+o). */
	descriptions?: Record<string, string>;
	/** Set when items were capped; rendered as a dim trailing line instead of a fake item. */
	truncatedTo?: string;
}

interface ContextEntryData {
	meta?: {
		modelLabel: string;
		thinking: string;
		cwd: string;
		sessionId: string;
		sessionName: string;
	};
	sections: ItemSection[];
}

/** First available list, preserving an authoritative empty result. */
export function firstAvailable<T>(...values: (T[] | undefined)[]): T[] {
	for (const value of values) {
		if (value !== undefined) {
			return value;
		}
	}
	return [];
}

function toHomePath(path: string): string {
	const home = process.env.HOME;
	if (home && path.startsWith(home + "/")) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

/** Gather skills and files through fallbacks, plus the authoritative live tools. */
function gatherResources(pi: ExtensionAPI, ctx: ExtensionContext, options?: BuildSystemPromptOptions) {
	const liveSkills = pi
		.getCommands()
		.filter((command) => command.source === "skill")
		.map((command) => ({
			name: command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name,
			description: command.description ?? "",
		}));
	const skills = firstAvailable(
		options?.skills?.map((skill) => ({ name: skill.name, description: skill.description })),
		liveSkills,
	);
	let parsedContextFiles: string[] = [];
	if (options?.contextFiles === undefined) {
		try {
			parsedContextFiles = parseFromPrompt(ctx.getSystemPrompt()).contextFiles;
		} catch {
			// getSystemPrompt may be unavailable in some modes.
		}
	}
	const contextFiles = firstAvailable(
		options?.contextFiles?.map((file) => file.path),
		parsedContextFiles,
	);
	const tools = pi.getActiveTools();
	return { skills, contextFiles, tools };
}

async function buildEntryData(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	args: string,
	options?: BuildSystemPromptOptions,
): Promise<ContextEntryData> {
	const resources = gatherResources(pi, ctx, options);
	const sections: ItemSection[] = [];
	const addSection = (
		title: string,
		items: string[],
		slash = false,
		descriptions?: Record<string, string>,
		truncatedTo?: string,
	) => {
		sections.push({ kind: "items", title, items, slash, descriptions, truncatedTo });
	};

	switch (args) {
		case "skills":
			addSection(
				`Skills (${resources.skills.length})`,
				resources.skills.map((skill) => skill.name),
				false,
				Object.fromEntries(resources.skills.map((skill) => [skill.name, skill.description])),
			);
			break; // /context skills is uncapped
		case "prompts":
			addSection("Prompts", listPrompts(pi), true);
			break;
		case "extensions":
			addSection("Extensions", await listExtensions(ctx));
			break;
		case "":
		default: {
			const model = ctx.model;
			const meta: ContextEntryData["meta"] = {
				modelLabel: model ? `${model.name || model.id} (${model.provider})` : "not set",
				thinking: ctx.thinkingLevel ?? "default",
				cwd: toHomePath(ctx.cwd),
				sessionId: ctx.sessionManager.getSessionId(),
				sessionName: ctx.sessionManager.getSessionName() ?? "",
			};
			const allSkills = resources.skills.map((skill) => skill.name);
			addSection(
				`Skills (${resources.skills.length})`,
				allSkills.slice(0, SKILL_CAP),
				false,
				Object.fromEntries(resources.skills.map((skill) => [skill.name, skill.description])),
				allSkills.length > SKILL_CAP
					? `+${allSkills.length - SKILL_CAP} more — run /context skills for all`
					: undefined,
			);
			addSection("Context Files", resources.contextFiles.map((path) => toHomePath(path)));
			addSection("Prompts", listPrompts(pi), true);
			addSection("Extensions", await listExtensions(ctx));
			addSection("Tools", resources.tools);
			return { meta, sections };
		}
	}
	return { sections };
}

async function printContext(pi: ExtensionAPI, ctx: ExtensionContext, args: string, options?: BuildSystemPromptOptions): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("The context print is only available in interactive mode.", "warning");
		return;
	}
	pi.appendEntry("context-header", await buildEntryData(pi, ctx, args, options));
}

export default function (pi: ExtensionAPI) {
	// Inline rendering (like /hotkeys): entries are TUI-only, never sent to the model.
	pi.registerEntryRenderer("context-header", (entry, { expanded }, theme: Theme) => {
		// Entry data may come from an older session file written by a previous
		// version; tolerate missing/malformed fields instead of crashing.
		const data = (entry.data ?? {}) as Partial<ContextEntryData>;
		const sections = Array.isArray(data.sections) ? data.sections : [];
		return {
			render(width: number): string[] {
				const lines: string[] = [];
				const section = (title: string, count?: number) =>
					lines.push(theme.fg("mdHeading", `[${title}${count !== undefined ? ` (${count})` : ""}]`));

				// Session block.
				if (data.meta) {
					section("Session");
					const kv = (label: string, value: string) =>
						lines.push(`  ${theme.fg("dim", `${label}:`)} ${value}`);
					kv("Model", data.meta.modelLabel);
					kv("Thinking", data.meta.thinking);
					kv("Cwd", data.meta.cwd);
					kv("Session", data.meta.sessionName ? `${data.meta.sessionName} (${data.meta.sessionId})` : data.meta.sessionId);
					lines.push("");
				}

				// Keys block (config-aware keybinding hints).
				section("Keys");
				lines.push(
					`  ${[
						keyHint("app.interrupt", "interrupt"),
						rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
						rawKeyHint("/", "commands"),
						rawKeyHint("!", "bash"),
						keyHint("app.tools.expand", "more"),
					].join(theme.fg("muted", " · "))}`,
				);
				lines.push(
					`  ${[
						keyHint("app.model.cycleForward", "model"),
						keyHint("app.thinking.toggle", "thinking"),
						keyHint("app.editor.external", "editor"),
					].join(theme.fg("muted", " · "))}`,
				);
				lines.push(`  ${theme.fg("dim", `Run ${theme.fg("accent", "/hotkeys")} for all shortcuts.`)}`);
				lines.push("");

				// Generic sections.
				for (const itemSection of sections) {
					if (!itemSection || !Array.isArray(itemSection.items)) {
						continue;
					}
					section(itemSection.title);
					if (itemSection.items.length === 0) {
						lines.push(`  ${theme.fg("dim", "none")}`);
						lines.push("");
						continue;
					}
					if (expanded && itemSection.descriptions) {
						for (const item of itemSection.items) {
							const desc = itemSection.descriptions[item] ?? "";
							const suffix = desc ? ` — ${desc}` : "";
							lines.push(fit(`  ${item}${suffix}`, width));
						}
					} else {
						const words = itemSection.items.map((item) => (itemSection.slash ? `/${item}` : item));
						lines.push(...wrapWords(words, Math.max(0, width - 2), "  "));
					}
					if (itemSection.truncatedTo) {
						lines.push(`  ${theme.fg("dim", itemSection.truncatedTo)}`);
					}
					lines.push("");
				}

				return lines.map((line) => fit(line, width));
			},
			invalidate() {},
		};
	});

	pi.registerCommand("context", {
		description: "Print session context inline: files, skills, prompts, extensions, tools. Usage: /context [skills|prompts|extensions]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg !== "" && arg !== "skills" && arg !== "prompts" && arg !== "extensions") {
				ctx.ui.notify("Usage: /context [skills|prompts|extensions]", "warning");
				return;
			}
			await printContext(pi, ctx, arg, ctx.getSystemPromptOptions());
		},
	});

	pi.registerShortcut("ctrl+shift+h", {
		description: "Print session context (same as /context)",
		handler: async (ctx: ExtensionContext) => {
			await printContext(pi, ctx, "");
		},
	});
}

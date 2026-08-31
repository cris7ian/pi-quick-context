/**
 * pi-quick-context
 *
 * Prints the session context inline in the chat, like /hotkeys:
 * loaded context files, skills, prompt templates, extensions, active tools,
 * session identity, and keybinding hints. Works independently of quietStartup.
 *
 * Usage:
 *   /context            Full context (session, keys, files, skills, prompts, extensions, tools)
 *   /context skills     All skill names
 *   /context prompts    All prompt template names
 *   /context extensions All loaded extensions
 *   Ctrl+Shift+H        Same as /context
 *
 * Skills / context files / tools come from the live system-prompt options
 * when available, falling back to the effective system prompt string.
 * Prompts and extensions are enumerated from the agent config, project,
 * settings, and installed packages (npm and git) - the same sources the
 * startup header uses.
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
	Skill,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir, keyHint, keyText, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";

/** Cached snapshot of system-prompt options, captured on each before_agent_start. */
interface ContextSnapshot {
	contextFiles: string[];
	skills: { name: string; description: string }[];
	selectedTools: string[];
}

let snapshot: ContextSnapshot | undefined;

/** Cap for skills in the full /context view; /context skills is uncapped. */
const SKILL_CAP = 40;

function captureSnapshot(options: BuildSystemPromptOptions): void {
	snapshot = {
		contextFiles: (options.contextFiles ?? []).map((file) => file.path),
		skills: (options.skills ?? []).map((skill: Skill) => ({
			name: skill.name,
			description: skill.description,
		})),
		selectedTools: options.selectedTools ?? [],
	};
}

function unescapeXml(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

/**
 * Recover loaded skills, context files, and tools from the effective system
 * prompt string when structured options are unavailable (hotkey path, fresh
 * session). Skills appear as <skill><name>…</name>; context files as path="…".
 */
function parseFromPrompt(prompt: string): {
	skills: string[];
	contextFiles: string[];
	tools: string[];
} {
	const skills: string[] = [];
	for (const match of prompt.matchAll(/<skill>\s*<name>([^<]+)<\/name>/g)) {
		skills.push(unescapeXml(match[1]));
	}
	const contextFiles: string[] = [];
	for (const match of prompt.matchAll(/<project_instructions path="([^"]*)">/g)) {
		contextFiles.push(unescapeXml(match[1]));
	}
	const tools: string[] = [];
	const toolsSection = prompt.match(/Available tools:\n((?:- .*\n?)+)/)?.[1] ?? "";
	for (const match of toolsSection.matchAll(/^- ([A-Za-z0-9_.-]+):/gm)) {
		tools.push(match[1]);
	}
	return { skills, contextFiles, tools };
}

// ---------------------------------------------------------------------------
// Render helpers (ANSI-safe, width-aware)
// ---------------------------------------------------------------------------

/** Wrap a list of short words into lines no wider than maxWidth. */
function wrapWords(words: string[], maxWidth: number, prefix = ""): string[] {
	const lines: string[] = [];
	let current = prefix;
	for (const word of words) {
		const sep = current === prefix || current === "" ? "" : " ";
		if (current.length + sep.length + word.length > maxWidth && current !== prefix) {
			lines.push(current);
			current = `${prefix}${word}`;
		} else {
			current += sep + word;
		}
	}
	if (current !== "") {
		lines.push(current);
	}
	return lines;
}

/**
 * Truncate a line to the given visual width, ignoring ANSI escape sequences.
 * Never cuts inside an escape sequence or a multibyte character.
 */
function fit(line: string, width: number): string {
	if (width <= 0) {
		return "";
	}
	const chars = Array.from(line); // Split into code points; surrogate pairs stay intact.
	let visual = 0;
	let cut = chars.length;
	for (let i = 0; i < chars.length; i++) {
		if (chars[i] === "\x1b") {
			// Skip the full escape sequence: \x1b[ <params> <letter> (e.g. \x1b[38;2;128;128;128m).
			let j = i + 1;
			while (j < chars.length && !/[a-zA-Z]/.test(chars[j])) {
				j++;
			}
			i = j;
			continue;
		}
		visual++;
		if (visual > width - 1) {
			// Keep the last column for the ellipsis.
			cut = i;
			break;
		}
	}
	if (cut >= chars.length) {
		return line;
	}
	return `${chars.slice(0, cut).join("")}…`;
}

// ---------------------------------------------------------------------------
// Resource enumeration (prompts, extensions) from disk + settings
// ---------------------------------------------------------------------------

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/** Read global and project settings; project wins on conflicts. */
function readSettings(cwd: string): Record<string, unknown> {
	const globalSettings = readJson(join(getAgentDir(), "settings.json")) ?? {};
	const projectSettings = readJson(join(cwd, CONFIG_DIR_NAME, "settings.json")) ?? {};
	return { ...globalSettings, ...projectSettings };
}

interface PackageInfo {
	dir: string;
	/** Display name from package.json (scope-preserving, e.g. "@juicesharp/rpiv-todo"). */
	name: string;
	extensions: string[];
	prompts: string[];
}

/** Read extension/prompt manifest entries from a package directory. */
function packageFromDir(dir: string): PackageInfo | null {
	const pkgJson = readJson(join(dir, "package.json"));
	if (!pkgJson) {
		return null;
	}
	const pi = (pkgJson.pi ?? {}) as Record<string, unknown>;
	const name = typeof pkgJson.name === "string" ? pkgJson.name : basename(dir);
	return {
		dir,
		name,
		extensions: Array.isArray(pi.extensions) ? (pi.extensions as string[]).map(String) : [],
		prompts: Array.isArray(pi.prompts) ? (pi.prompts as string[]).map(String) : [],
	};
}

/** npm package name from a settings spec: "npm:pkg", "npm:pkg@1.0.0", "npm:@scope/pkg@1" */
function npmName(spec: string): string {
	const name = spec.replace(/^npm:/, "");
	if (name.startsWith("@")) {
		const parts = name.split("@");
		return parts.slice(0, 2).join("@");
	}
	return name.split("@")[0];
}

/** Git clone path from a settings spec: "git:github.com/u/r@v1", "https://…", "ssh://…" */
function gitPath(spec: string): string {
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

/** Resolve a settings path: absolute first, then relative to cwd, then to the agent dir. */
function resolveSettingsPath(path: string, cwd: string): string | undefined {
	const candidates = [
		path.startsWith("~") ? join(process.env.HOME ?? "", path.slice(1)) : path,
		resolve(cwd, path),
		resolve(getAgentDir(), path),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

/**
 * Enumerate installed packages referenced in settings, resolving npm, git, and
 * local-path installs from both the agent dir and the project (user default + -l).
 */
function findPackages(settings: Record<string, unknown>, cwd: string): PackageInfo[] {
	const roots = [
		{ kind: "npm", dir: join(getAgentDir(), "npm", "node_modules") },
		{ kind: "git", dir: join(getAgentDir(), "git") },
		{ kind: "npm", dir: join(cwd, CONFIG_DIR_NAME, "npm", "node_modules") },
		{ kind: "git", dir: join(cwd, CONFIG_DIR_NAME, "git") },
	] as const;
	const packages: PackageInfo[] = [];
	const seen = new Set<string>();
	const settingsPackages = (settings.packages ?? []) as string[];
	for (const entry of settingsPackages) {
		const spec = String(entry);
		const isRemoteSpec = /^(npm:|git:|https?:\/\/|ssh:\/\/)/.test(spec);
		if (!isRemoteSpec) {
			// Local path installs (absolute, or relative to the settings file).
			const dir = resolveSettingsPath(spec, cwd);
			if (dir) {
				const pkg = packageFromDir(dir);
				if (pkg && !seen.has(dir)) {
					seen.add(dir);
					packages.push(pkg);
				}
			}
			continue;
		}
		for (const root of roots) {
			if (!existsSync(root.dir)) {
				continue;
			}
			const dir =
				root.kind === "npm"
					? join(root.dir, npmName(spec))
					: join(root.dir, gitPath(spec));
			if (!existsSync(dir)) {
				continue;
			}
			const pkg = packageFromDir(dir);
			if (!pkg || seen.has(dir)) {
				break;
			}
			seen.add(dir);
			packages.push(pkg);
			break;
		}
	}
	return packages;
}

/** Add .md filenames (without extension) from a directory to a set. */
function addPromptDir(names: Set<string>, dir: string): void {
	if (!existsSync(dir)) {
		return;
	}
	for (const file of readdirSync(dir)) {
		if (file.endsWith(".md")) {
			const name = file.slice(0, -3);
			if (/^[a-z0-9-]+$/.test(name)) {
				names.add(name);
			}
		}
	}
}

/** List prompt template command names (without the leading slash). */
function listPrompts(cwd: string): string[] {
	const names = new Set<string>();
	const settings = readSettings(cwd);
	const packages = findPackages(settings, cwd);

	// Global, project, and package prompt directories.
	addPromptDir(names, join(getAgentDir(), "prompts"));
	addPromptDir(names, join(cwd, CONFIG_DIR_NAME, "prompts"));
	for (const pkg of packages) {
		for (const rel of pkg.prompts) {
			addPromptDir(names, join(pkg.dir, rel));
		}
	}

	// Settings `prompts` entries (files or directories).
	const settingsPrompts = (settings.prompts ?? []) as string[];
	for (const entry of settingsPrompts) {
		const candidate = resolveSettingsPath(String(entry), cwd);
		if (!candidate) {
			continue;
		}
		if (candidate.endsWith(".md")) {
			const name = basename(candidate, ".md");
			if (/^[a-z0-9-]+$/.test(name)) {
				names.add(name);
			}
		} else {
			addPromptDir(names, candidate);
		}
	}

	// Local extension-directory installs (package manifests uncovered by findPackages).
	const settingsExtensions = (settings.extensions ?? []) as string[];
	for (const entry of settingsExtensions) {
		const resolved = join(cwd, String(entry));
		if (!existsSync(resolved)) {
			continue;
		}
		const pkg = packageFromDir(resolved);
		if (pkg) {
			for (const rel of pkg.prompts) {
				addPromptDir(names, join(pkg.dir, rel));
			}
		}
	}

	return [...names].sort();
}

/**
 * Extension display label, matching the startup header:
 * - a package's root ./index.ts renders as just the package name
 * - dir/index.ts renders as "package:dir"
 * - any other file renders as "package:filename"
 * - a plain file renders as its basename
 */
function extensionLabel(pkg: string, rel: string): string {
	const norm = rel.replace(/^\.\//, "");
	const base = basename(norm);
	if (base === "index.ts") {
		const dir = dirname(norm);
		return dir === "." ? pkg : `${pkg}:${dir}`;
	}
	return `${pkg}:${base}`;
}

/** List loaded extensions, in the startup header's display format. */
function listExtensions(cwd: string): string[] {
	const settings = readSettings(cwd);
	const labels: string[] = [];
	const seen = new Set<string>();
	const add = (label: string) => {
		if (!seen.has(label)) {
			seen.add(label);
			labels.push(label);
		}
	};

	// Agent + project extension directories.
	for (const dir of [join(getAgentDir(), "extensions"), join(cwd, CONFIG_DIR_NAME, "extensions")]) {
		if (!existsSync(dir)) {
			continue;
		}
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry);
			if (entry.endsWith(".ts")) {
				add(entry);
			} else if (existsSync(join(path, "index.ts"))) {
				add(entry);
			}
		}
	}

	// Packages from settings.
	for (const pkg of findPackages(settings, cwd)) {
		if (pkg.extensions.length === 0) {
			add(pkg.name);
			continue;
		}
		for (const rel of pkg.extensions) {
			add(extensionLabel(pkg.name, rel));
		}
	}

	// Settings `extensions` entries: directories use package manifests, files show as basename.
	const settingsExtensions = (settings.extensions ?? []) as string[];
	for (const entry of settingsExtensions) {
		const resolved = resolveSettingsPath(String(entry), cwd);
		if (!resolved) {
			continue;
		}
		const pkg = packageFromDir(resolved);
		if (pkg) {
			if (pkg.extensions.length === 0) {
				add(pkg.name);
				continue;
			}
			for (const rel of pkg.extensions) {
				add(extensionLabel(pkg.name, rel));
			}
		} else if (resolved.endsWith(".ts")) {
			add(basename(resolved));
		}
	}

	return labels;
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

/** First non-empty list, preferring structured sources over prompt parsing. */
function firstNonEmpty<T>(...values: (T[] | undefined)[]): T[] {
	for (const value of values) {
		if (value && value.length > 0) {
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

/** Gather live skills / context files / tools (structured options > snapshot > prompt). */
function gatherResources(ctx: ExtensionContext, options?: BuildSystemPromptOptions) {
	let parsed: { skills: string[]; contextFiles: string[]; tools: string[] } = {
		skills: [],
		contextFiles: [],
		tools: [],
	};
	try {
		parsed = parseFromPrompt(ctx.getSystemPrompt());
	} catch {
		// getSystemPrompt may be unavailable in some modes; leave parsed empty.
	}
	const skills = firstNonEmpty(
		options?.skills?.map((skill) => ({ name: skill.name, description: skill.description })),
		snapshot?.skills,
		parsed.skills.map((name) => ({ name, description: "" })),
	);
	const contextFiles = firstNonEmpty(
		options?.contextFiles?.map((file) => file.path),
		snapshot?.contextFiles,
		parsed.contextFiles,
	);
	const tools = firstNonEmpty(options?.selectedTools, snapshot?.selectedTools, parsed.tools);
	return { skills, contextFiles, tools };
}

function buildEntryData(
	ctx: ExtensionContext,
	args: string,
	options?: BuildSystemPromptOptions,
): ContextEntryData {
	const resources = gatherResources(ctx, options);
	const sections: ItemSection[] = [];
	const addSection = (title: string, items: string[], slash = false, descriptions?: Record<string, string>) => {
		sections.push({ kind: "items", title, items, slash, descriptions });
	};

	switch (args) {
		case "skills":
			addSection(
				`Skills (${resources.skills.length})`,
				resources.skills.map((skill) => skill.name),
				false,
				Object.fromEntries(resources.skills.map((skill) => [skill.name, skill.description])),
			);
			break;
		case "prompts":
			addSection("Prompts", listPrompts(ctx.cwd), true);
			break;
		case "extensions":
			addSection("Extensions", listExtensions(ctx.cwd));
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
			const cappedSkills = allSkills.length > SKILL_CAP ? [...allSkills.slice(0, SKILL_CAP), `+${allSkills.length - SKILL_CAP} more (run /context skills for all)`] : allSkills;
			addSection(
				`Skills (${resources.skills.length})`,
				cappedSkills,
				false,
				Object.fromEntries(resources.skills.map((skill) => [skill.name, skill.description])),
			);
			addSection("Context Files", resources.contextFiles.map((path) => toHomePath(path)));
			addSection("Prompts", listPrompts(ctx.cwd), true);
			addSection("Extensions", listExtensions(ctx.cwd));
			addSection("Tools", resources.tools);
			return { meta, sections };
		}
	}
	return { sections };
}

function printContext(pi: ExtensionAPI, ctx: ExtensionContext, args: string, options?: BuildSystemPromptOptions): void {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("The context print is only available in interactive mode.", "warning");
		return;
	}
	pi.appendEntry("context-header", buildEntryData(ctx, args, options));
}

export default function (pi: ExtensionAPI) {
	// Keep live data fresh whenever the agent is about to run.
	pi.on("before_agent_start", (event) => {
		captureSnapshot(event.systemPromptOptions);
	});

	// Inline rendering (like /hotkeys): entries are TUI-only, never sent to the model.
	pi.registerEntryRenderer("context-header", (entry, { expanded }, theme: Theme) => {
		const data = entry.data as ContextEntryData;
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
				for (const itemSection of data.sections) {
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
						lines.push("");
						continue;
					}
					const words = itemSection.items.map((item) => (itemSection.slash ? `/${item}` : item));
					lines.push(...wrapWords(words, Math.max(0, width - 2), "  "));
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
			printContext(pi, ctx, arg, ctx.getSystemPromptOptions());
		},
	});

	pi.registerShortcut("ctrl+shift+h", {
		description: "Print session context (same as /context)",
		handler: (ctx: ExtensionContext) => {
			printContext(pi, ctx, "");
		},
	});
}
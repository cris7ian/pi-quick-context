/**
 * Tests for the extension behavior and pure helpers in src/index.ts.
 *
 * The functions under test are exported from the extension module; the pi
 * extension loader only consumes the default export, so the named exports are
 * test-only surface.
 */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";

import registerQuickContext, {
	displayWidth,
	extensionLabel,
	firstAvailable,
	fit,
	gitPath,
	listResolvedExtensions,
	npmName,
	parseFromPrompt,
	unescapeXml,
	wrapWords,
} from "../src/index.ts";

const tempDirs: string[] = [];

interface ExtensionHarness {
	appended: unknown[];
	command: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	shortcut: (ctx: ExtensionContext) => Promise<void> | void;
}

function createExtensionHarness(commands: SlashCommandInfo[], activeTools: string[]): ExtensionHarness {
	const appended: unknown[] = [];
	let command: ExtensionHarness["command"] | undefined;
	let shortcut: ExtensionHarness["shortcut"] | undefined;
	const pi = {
		on() {},
		registerEntryRenderer() {},
		registerCommand(_name: string, options: { handler: ExtensionHarness["command"] }) {
			command = options.handler;
		},
		registerShortcut(_key: string, options: { handler: ExtensionHarness["shortcut"] }) {
			shortcut = options.handler;
		},
		appendEntry(_type: string, data: unknown) {
			appended.push(data);
		},
		getCommands: () => commands,
		getActiveTools: () => activeTools,
	} as unknown as ExtensionAPI;
	registerQuickContext(pi);
	assert.ok(command);
	assert.ok(shortcut);
	return { appended, command, shortcut };
}

function createContext(cwd: string, options: BuildSystemPromptOptions, systemPrompt = ""): ExtensionCommandContext {
	return {
		mode: "tui",
		cwd,
		ui: { notify() {} },
		getSystemPrompt: () => systemPrompt,
		getSystemPromptOptions: () => options,
		isProjectTrusted: () => true,
		sessionManager: {
			getSessionId: () => "session-id",
			getSessionName: () => undefined,
		},
	} as unknown as ExtensionCommandContext;
}

function createShortcutContext(cwd: string, systemPrompt = ""): ExtensionContext {
	return {
		mode: "tui",
		cwd,
		ui: { notify() {} },
		getSystemPrompt: () => systemPrompt,
		isProjectTrusted: () => true,
		sessionManager: {
			getSessionId: () => "session-id",
			getSessionName: () => undefined,
		},
	} as unknown as ExtensionContext;
}

function createSkill(
	name: string,
	description: string,
): NonNullable<BuildSystemPromptOptions["skills"]>[number] {
	const filePath = `/${name}/SKILL.md`;
	return {
		name,
		description,
		filePath,
		baseDir: `/${name}`,
		disableModelInvocation: false,
		sourceInfo: { path: filePath, source: "test", scope: "user", origin: "top-level" },
	};
}

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-quick-context-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop() as string, { recursive: true, force: true });
	}
});

describe("displayWidth", () => {
	it("counts ASCII as one column", () => {
		assert.equal(displayWidth("abc"), 3);
	});

	it("counts CJK as two columns", () => {
		assert.equal(displayWidth("你好"), 4);
	});

	it("counts combining marks as zero columns", () => {
		assert.equal(displayWidth("e\u0301"), 1);
	});

	it("ignores ANSI escape sequences", () => {
		assert.equal(displayWidth("\x1b[38;2;128;128;128mab\x1b[0m"), 2);
	});
});

describe("wrapWords", () => {
	it("packs words up to maxWidth", () => {
		assert.deepEqual(wrapWords(["aa", "bb", "cc"], 5), ["aa bb", "cc"]);
	});

	it("wraps on display width, not code points", () => {
		// "你好" is 4 columns wide, so each word needs its own line at width 3.
		assert.deepEqual(wrapWords(["你", "好"], 3), ["你", "好"]);
	});

	it("keeps items even when a single word overflows", () => {
		assert.deepEqual(wrapWords(["toolongword"], 4), ["toolongword"]);
	});

	it("applies the prefix and counts it against the width", () => {
		assert.deepEqual(wrapWords(["aa", "bb", "cc"], 7, "  "), ["  aa bb", "  cc"]);
	});
});

describe("fit", () => {
	it("returns the line unchanged when it fits", () => {
		assert.equal(fit("ab", 10), "ab");
	});

	it("truncates and keeps the last column for the ellipsis", () => {
		const out = fit("abcdef", 4);
		assert.equal(displayWidth(out), 4);
		assert.ok(out.endsWith("…"));
	});

	it("never cuts inside an escape sequence", () => {
		const line = "a\x1b[31mbcdef\x1b[0m";
		const out = fit(line, 4);
		assert.ok(!out.includes("bcdef"));
		// Kept prefix must contain complete escape sequences only.
		assert.ok(/(\x1b\[[0-9;]*[a-zA-Z])/.test(out));
	});

	it("re-appends a reset when truncation drops escape sequences", () => {
		const out = fit("a\x1b[31mbcdef\x1b[0m", 4);
		assert.ok(out.endsWith("\x1b[0m"), `expected reset suffix, got ${JSON.stringify(out)}`);
	});

	it("keeps a fully styled short line untouched", () => {
		assert.equal(fit("\x1b[31mabc", 100), "\x1b[31mabc");
	});

	it("returns an empty string for non-positive widths", () => {
		assert.equal(fit("abc", 0), "");
		assert.equal(fit("abc", -1), "");
	});

	it("truncates by display width for CJK input", () => {
		// "你好世界" is 8 columns; width 5 keeps 2 CJK chars (4 cols) + ellipsis.
		const out = fit("你好世界", 5);
		assert.equal(out, "你好…");
	});
});

describe("unescapeXml", () => {
	it("decodes the five entities", () => {
		assert.equal(unescapeXml("a &quot;b&quot; &apos;c&apos; &lt;d&gt; &amp;"), 'a "b" \'c\' <d> &');
	});

	it("decodes &amp; last so double escapes are not double-decoded", () => {
		assert.equal(unescapeXml("&amp;lt;"), "&lt;");
	});
});

describe("npmName", () => {
	it("strips the npm: prefix and version", () => {
		assert.equal(npmName("npm:pkg@1.2.3"), "pkg");
	});

	it("keeps scoped names intact", () => {
		assert.equal(npmName("npm:@scope/pkg@1"), "@scope/pkg");
	});
});

describe("gitPath", () => {
	it("normalizes a git: shorthand with version", () => {
		assert.equal(gitPath("git:github.com/u/r@v1"), "github.com/u/r");
	});

	it("normalizes https and ssh URLs", () => {
		assert.equal(gitPath("https://github.com/u/r.git"), "github.com/u/r");
		assert.equal(gitPath("git@github.com:u/r.git"), "github.com/u/r");
	});
});

describe("extensionLabel", () => {
	it("renders a root index as the package name", () => {
		assert.equal(extensionLabel("pkg", "./index.ts"), "pkg");
		assert.equal(extensionLabel("pkg", "index.js"), "pkg");
	});

	it("renders a subdirectory index as package:dir", () => {
		assert.equal(extensionLabel("pkg", "./tools/index.ts"), "pkg:tools");
	});

	it("renders other files as package:filename", () => {
		assert.equal(extensionLabel("pkg", "./foo.ts"), "pkg:foo.ts");
	});

	it("strips repeated ./ prefixes", () => {
		assert.equal(extensionLabel("pkg", "././index.ts"), "pkg");
	});
});

describe("parseFromPrompt", () => {
	it("recovers context files from a system prompt", () => {
		const prompt = [
			'<project_instructions path="/tmp/a &amp; b.md">',
			"Some instructions.",
		].join("\n");
		const parsed = parseFromPrompt(prompt);
		assert.deepEqual(parsed.contextFiles, ["/tmp/a & b.md"]);
	});

	it("returns empty lists for an unrelated prompt", () => {
		const parsed = parseFromPrompt("Nothing to see here.");
		assert.deepEqual(parsed, { contextFiles: [] });
	});
});

describe("extension runtime inventory", () => {
	it("uses pi's loaded prompt commands without filtering valid names", async () => {
		const cwd = makeTempDir();
		const commands = [
			{ name: "Upper_Name", source: "prompt", sourceInfo: {} },
			{ name: "revisión", source: "prompt", sourceInfo: {} },
			{ name: "extension-command", source: "extension", sourceInfo: {} },
		] as SlashCommandInfo[];
		const harness = createExtensionHarness(commands, []);

		await harness.command("prompts", createContext(cwd, { cwd }));

		const data = harness.appended[0] as { sections: Array<{ title: string; items: string[] }> };
		assert.equal(data.sections.length, 1);
		assert.equal(data.sections[0]?.title, "Prompts");
		assert.deepEqual(data.sections[0]?.items, ["Upper_Name", "revisión"]);
	});

	it("uses the authoritative active tool list for the hotkey", async () => {
		const cwd = makeTempDir();
		const harness = createExtensionHarness([], []);
		const ctx = createShortcutContext(cwd);

		await harness.shortcut(ctx);

		const data = harness.appended[0] as { sections: Array<{ title: string; items: string[] }> };
		assert.deepEqual(data.sections.find((section) => section.title === "Tools")?.items, []);
	});

	it("does not resurrect stale skills or context files over explicit empty lists", async () => {
		const cwd = makeTempDir();
		const harness = createExtensionHarness(
			[{ name: "skill:fallback-skill", description: "Fallback", source: "skill", sourceInfo: {} } as SlashCommandInfo],
			[],
		);
		const fallbackPrompt = '<project_instructions path="/fallback/AGENTS.md">\nFallback\n</project_instructions>';

		await harness.command("", createContext(cwd, { cwd, skills: [], contextFiles: [] }, fallbackPrompt));

		const data = harness.appended[0] as { sections: Array<{ title: string; items: string[] }> };
		assert.deepEqual(data.sections.find((section) => section.title.startsWith("Skills"))?.items, []);
		assert.deepEqual(data.sections.find((section) => section.title === "Context Files")?.items, []);
	});

	it("reports identical current skills after resources change", async () => {
		const cwd = makeTempDir();
		const commands = [
			{ name: "skill:old-skill", description: "Old", source: "skill", sourceInfo: {} },
		] as SlashCommandInfo[];
		const harness = createExtensionHarness(commands, []);
		await harness.command(
			"skills",
			createContext(cwd, {
				cwd,
				skills: [createSkill("old-skill", "Old")],
			}),
		);

		commands.splice(
			0,
			commands.length,
			{ name: "skill:current-one", description: "One", source: "skill", sourceInfo: {} } as SlashCommandInfo,
			{ name: "skill:current-two", description: "Two", source: "skill", sourceInfo: {} } as SlashCommandInfo,
		);
		const currentOptions: BuildSystemPromptOptions = {
			cwd,
			skills: [createSkill("current-one", "One"), createSkill("current-two", "Two")],
		};
		await harness.command("skills", createContext(cwd, currentOptions));
		await harness.shortcut(createShortcutContext(cwd));

		const commandData = harness.appended[1] as { sections: Array<{ title: string; items: string[] }> };
		const shortcutData = harness.appended[2] as { sections: Array<{ title: string; items: string[] }> };
		const commandSkills = commandData.sections.find((section) => section.title.startsWith("Skills"));
		const shortcutSkills = shortcutData.sections.find((section) => section.title.startsWith("Skills"));
		assert.deepEqual(commandSkills, shortcutSkills);
		assert.equal(commandSkills?.title, "Skills (2)");
		assert.deepEqual(commandSkills?.items, ["current-one", "current-two"]);
	});
});

describe("listResolvedExtensions", () => {
	it("honors scopes, trust, package filters, and convention resources", async () => {
		const agentDir = makeTempDir();
		const cwd = makeTempDir();
		mkdirSync(join(agentDir, "extensions"));
		writeFileSync(join(agentDir, "extensions", "global.ts"), "");
		writeFileSync(join(agentDir, "extensions", "same.ts"), "");
		mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "extensions", "project.ts"), "");
		writeFileSync(join(cwd, ".pi", "extensions", "same.ts"), "");
		mkdirSync(join(agentDir, "a"));
		mkdirSync(join(agentDir, "b"));
		writeFileSync(join(agentDir, "a", "same.ts"), "");
		writeFileSync(join(agentDir, "b", "same.ts"), "");

		const filtered = join(agentDir, "filtered-package");
		mkdirSync(join(filtered, "extensions"), { recursive: true });
		writeFileSync(join(filtered, "extensions", "keep.ts"), "");
		writeFileSync(join(filtered, "extensions", "drop.ts"), "");
		writeFileSync(
			join(filtered, "package.json"),
			JSON.stringify({ name: "filtered-package", pi: { extensions: ["extensions/keep.ts", "extensions/drop.ts"] } }),
		);

		const promptOnly = join(agentDir, "prompt-only-package");
		mkdirSync(join(promptOnly, "prompts"), { recursive: true });
		writeFileSync(join(promptOnly, "prompts", "Upper_Name.md"), "");
		writeFileSync(join(promptOnly, "package.json"), JSON.stringify({ name: "prompt-only-package", pi: { prompts: ["prompts"] } }));
		const convention = join(agentDir, "convention-package");
		mkdirSync(join(convention, "extensions"), { recursive: true });
		writeFileSync(join(convention, "extensions", "index.ts"), "");
		writeFileSync(join(convention, "package.json"), JSON.stringify({ name: "convention-package" }));
		const nested = join(agentDir, "nested-package");
		mkdirSync(join(nested, "src"), { recursive: true });
		writeFileSync(join(nested, "src", "index.ts"), "");
		writeFileSync(join(nested, "package.json"), JSON.stringify({ name: "nested-package", pi: { extensions: ["src/index.ts"] } }));
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				extensions: ["a/same.ts", "b/same.ts"],
				packages: [
					{ source: "./filtered-package", extensions: ["extensions/keep.ts"] },
					"./prompt-only-package",
					"./convention-package",
					"./nested-package",
				],
			}),
		);

		const trusted = await listResolvedExtensions(cwd, agentDir, true);
		assert.ok(trusted.some((label) => label.includes("global")));
		assert.ok(trusted.some((label) => label.includes("project")));
		assert.ok(trusted.some((label) => label.includes("keep")));
		assert.ok(trusted.includes("convention-package"));
		assert.ok(trusted.includes("nested-package:src"));
		assert.ok(!trusted.some((label) => label.includes("drop") || label.includes("prompt-only")));
		const collisionLabels = trusted.filter((label) => label.endsWith("same.ts"));
		assert.equal(collisionLabels.length, 4);
		assert.equal(new Set(collisionLabels).size, 4);

		const untrusted = await listResolvedExtensions(cwd, agentDir, false);
		assert.ok(!untrusted.some((label) => label.includes("project")));
	});
});

describe("firstAvailable", () => {
	it("keeps an authoritative empty list", () => {
		assert.deepEqual(firstAvailable([], ["stale"]), []);
	});

	it("falls back only when a source is unavailable", () => {
		assert.deepEqual(firstAvailable(undefined, ["current"]), ["current"]);
	});
});

describe("runtime compatibility", () => {
	it("supports the same minimum Node version as pi", () => {
		const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			engines: { node: string };
		};
		const piPackageJson = JSON.parse(
			readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url), "utf8"),
		) as { engines: { node: string } };
		assert.equal(packageJson.engines.node, piPackageJson.engines.node);
	});
});

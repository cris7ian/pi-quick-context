/**
 * Tests for the pure helpers in src/index.ts.
 *
 * The functions under test are exported from the extension module; the pi
 * extension loader only consumes the default export, so the named exports are
 * test-only surface.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
	addPromptDir,
	displayWidth,
	extensionLabel,
	fit,
	gitPath,
	npmName,
	parseFromPrompt,
	resolveSettingsPath,
	stringArray,
	unescapeXml,
	wrapWords,
} from "../src/index.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-quick-context-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop() as string, { recursive: true, force: true });
	}
	delete process.env.HOME;
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
	it("recovers context files and tools from a system prompt", () => {
		const prompt = [
			'<project_instructions path="/tmp/a &amp; b.md">',
			"Some instructions.",
			"Available tools:",
			"- read: Read files",
			"- bash: Run commands",
		].join("\n");
		const parsed = parseFromPrompt(prompt);
		assert.deepEqual(parsed.contextFiles, ["/tmp/a & b.md"]);
		assert.deepEqual(parsed.tools, ["read", "bash"]);
	});

	it("recovers skill names and unescapes them", () => {
		const prompt = "<skill>\n<name>code &amp; review</name>\n</skill>";
		assert.deepEqual(parseFromPrompt(prompt).skills, ["code & review"]);
	});

	it("returns empty lists for an unrelated prompt", () => {
		const parsed = parseFromPrompt("Nothing to see here.");
		assert.deepEqual(parsed, { skills: [], contextFiles: [], tools: [] });
	});
});

describe("stringArray", () => {
	it("coerces array entries to strings", () => {
		assert.deepEqual(stringArray(["a", 2]), ["a", "2"]);
	});

	it("ignores a lone string (pi also rejects it)", () => {
		assert.deepEqual(stringArray("one"), []);
	});

	it("returns an empty array for undefined and other non-arrays", () => {
		assert.deepEqual(stringArray(undefined), []);
		assert.deepEqual(stringArray({ a: 1 }), []);
	});
});

describe("resolveSettingsPath", () => {
	it("resolves a relative path against cwd", () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "found.md"), "");
		assert.equal(resolveSettingsPath("found.md", dir), join(dir, "found.md"));
	});

	it("expands ~ to HOME", () => {
		const home = makeTempDir();
		mkdirSync(join(home, "sub"));
		writeFileSync(join(home, "sub", "file.md"), "");
		process.env.HOME = home;
		assert.equal(resolveSettingsPath("~/sub/file.md", "/nonexistent-cwd"), join(home, "sub", "file.md"));
		assert.equal(resolveSettingsPath("~", "/nonexistent-cwd"), home);
	});

	it("does not expand ~user", () => {
		const dir = makeTempDir();
		process.env.HOME = dir;
		assert.equal(resolveSettingsPath("~other/file.md", dir), undefined);
	});

	it("returns undefined when no candidate exists", () => {
		const dir = makeTempDir();
		assert.equal(resolveSettingsPath("missing.md", dir), undefined);
	});
});

describe("addPromptDir", () => {
	it("collects lowercase .md names without extension", () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "alpha.md"), "");
		writeFileSync(join(dir, "Beta.md"), ""); // uppercase: not a valid command name
		writeFileSync(join(dir, "notes.txt"), ""); // not .md
		const names = new Set<string>();
		addPromptDir(names, dir);
		assert.deepEqual([...names], ["alpha"]);
	});

	it("ignores missing directories", () => {
		const names = new Set<string>();
		addPromptDir(names, join(makeTempDir(), "nope"));
		assert.equal(names.size, 0);
	});
});

# AGENTS.md

## Project Overview

This package is a pi extension that renders session context as a TUI-only custom entry. It does not send the rendered content to the model.

## Commands

- Run tests: `npm test`
- Run the type check: `npm run typecheck`
- Load the extension locally: `pi -e src/index.ts`

## Architecture

- Use `pi.getCommands()` for loaded prompts and `pi.getActiveTools()` for active tools. Do not reconstruct these lists from disk or the system prompt.
- Read skills from `pi.getCommands()` on the hotkey path. Command system-prompt options remain authoritative, including an empty list.
- Read context files from command system-prompt options or the hotkey's current effective system prompt. Do not cache resource snapshots.
- Resolve extension candidates with `SettingsManager` and `DefaultPackageManager.resolve(() => "skip")`. The callback prevents missing packages from being installed.
- Pi does not expose its final loaded-extension list. Report enabled candidates and preserve this limitation in user-facing documentation.

## Constraints

- Do not instantiate or reload `DefaultResourceLoader` from this extension. That can execute extension factories twice.
- Keep runtime dependencies limited to the `@earendil-works/pi-coding-agent` peer package and Node.js built-ins.
- Keep the minimum Node.js version aligned with pi. Test the exact minimum version in CI.
- Test user-visible command and shortcut behavior through the registered extension handlers when practical.

# pi-quick-context

Print the session context inline in [pi](https://pi.dev), the same way `/hotkeys` does — without depending on the startup header or `quietStartup`.

That way you can set `quietStartup` to `true` for a clean ui but check the context on-demand without inspecting dofiles or spending tokens.

## What it shows

- **Session** — model, thinking level, cwd, session id
- **Keys** — config-aware keybinding hints (respects your `keybindings.json`)
- **Context Files** — loaded `AGENTS.md` / `CLAUDE.md` files
- **Skills** — all loaded skills
- **Prompts** — prompt templates from the agent dir, project, settings, and installed packages
- **Extensions** — enabled configured extensions in the startup header's label format (`pkg`, `pkg:file`, `pkg:dir`)
- **Tools** — the currently active tool set

Nothing the extension prints is sent to the model: content is rendered as a TUI-only custom entry.

## Usage

| Command | What it prints |
|---|---|
| `/context` | Full context: session, keys, context files, skills, prompts, extensions, tools |
| `/context skills` | All skill names (expand with `ctrl+o` to see descriptions) |
| `/context prompts` | All prompt template names |
| `/context extensions` | All enabled extension candidates |
| `Ctrl+Shift+H` | Same as `/context` |

## Install

```bash
# From GitHub
pi install git:github.com/cris7ian/pi-quick-context

# From npm
pi install npm:pi-quick-context
```

Then run `/reload` in an interactive pi session (or restart pi). Uninstall with `pi remove`.

## How it gets the data

- Skills, prompts, and tools come from pi's live runtime, so filtering, trust, reloads, and active-resource changes are already applied.
- Context files use live system-prompt options when available. The hotkey falls back to the current effective system prompt.
- Extensions use pi's settings-aware package resolver. It applies scopes, trust, filters, globs, conventions, and npm/git/local package resolution without loading extension code twice.

Pi does not currently expose the final loaded-extension list to extensions. The extension section therefore shows enabled candidates and cannot include temporary CLI or inline extensions, or exclude a candidate that failed during loading.

## Development

```bash
pi -e src/index.ts   # try it without installing
```

The entry point is `src/index.ts`. It has no runtime dependencies beyond the core `@earendil-works/pi-coding-agent` peer package.

## License

MIT

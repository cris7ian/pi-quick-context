# pi-quick-context

Print the session context inline in [pi](https://pi.dev), the same way `/hotkeys` does — without depending on the startup header or `quietStartup`.

That way you can set `quietStartup` to `true` for a clean ui but check the context on-demand without inspecting dofiles or spending tokens.

## What it shows

- **Session** — model, thinking level, cwd, session id
- **Keys** — config-aware keybinding hints (respects your `keybindings.json`)
- **Context Files** — loaded `AGENTS.md` / `CLAUDE.md` files
- **Skills** — all loaded skills
- **Prompts** — prompt templates from the agent dir, project, settings, and installed packages
- **Extensions** — loaded extensions in the startup header's label format (`pkg`, `pkg:file`, `pkg:dir`)
- **Tools** — the currently active tool set

Nothing the extension prints is sent to the model: content is rendered as a TUI-only custom entry.

## Usage

| Command | What it prints |
|---|---|
| `/context` | Full context: session, keys, context files, skills, prompts, extensions, tools |
| `/context skills` | All skill names (expand with `ctrl+o` to see descriptions) |
| `/context prompts` | All prompt template names |
| `/context extensions` | All loaded extensions |
| `Ctrl+Shift+H` | Same as `/context` |

## Install

```bash
# Local checkout (development)
pi install ~/Developer/pi-quick-context

# From GitHub
pi install git:github.com/<user>/pi-quick-context

# From npm
pi install npm:pi-quick-context
```

Then run `/reload` in an interactive pi session (or restart pi). Uninstall with `pi remove`.

## How it gets the data

- Skills, context files, and tools come from the live system-prompt options when available, falling back to a `before_agent_start` snapshot, then to parsing the effective system prompt string (so it works on a fresh session and from the hotkey).
- Prompts are enumerated from `~/.pi/agent/prompts`, `.pi/prompts`, settings `prompts` entries, and `pi.prompts` in installed npm/git packages.
- Extensions are enumerated from `~/.pi/agent/extensions`, `.pi/extensions`, settings `packages`/`extensions`, and package `pi.extensions` manifests for both npm and git installs.

## Development

```bash
pi -e src/index.ts   # try it without installing
```

The entry point is `src/index.ts`. It has no runtime dependencies beyond the core `@earendil-works/pi-coding-agent` peer package.

## License

MIT

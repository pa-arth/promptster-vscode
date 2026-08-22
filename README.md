# Promptster Assessment

Editor telemetry extension for [Promptster](https://promptster.dev) hiring assessments. Captures development process signals — file navigation, edit patterns, terminal commands — so hiring teams can evaluate how candidates work, not just what they produce.

## How It Works

1. A candidate receives an assessment link and runs `promptster start` in their workspace
2. The CLI writes `.promptster/session.json` with their API key, session ID, API URL, and the consent they gave
3. This extension reads that file and begins capturing development signals
4. Signals are sent to the Promptster backend for analysis in the hiring dashboard

**No manual configuration required, and no second consent screen** — the extension has no API URL of its own and no consent of its own. Both come from the session. If the session records no consent, the extension captures nothing and says so in the status bar.

## What Is Captured

| Signal | Details |
|--------|---------|
| **File navigation** | Which files you open, how long you view them, scroll depth |
| **Edit patterns** | Characters per typing burst, burst duration, paste size. Keystroke-interval timing only if you enabled cadence checks at `promptster start` |
| **Attention** | Idle periods in the editor (60s threshold). Not whether the editor window has focus |
| **Diagnostics** | Error/warning resolution counts per file |
| **Terminal commands** | Program and subcommand only (e.g. `git push`), exit code, duration — never the arguments, the full command line, or its output |
| **File lifecycle** | File creates and deletes |

## What Is NOT Captured

- File contents, source code, or diffs
- Clipboard text
- Terminal output
- AI prompt text
- Diagnostic error messages
- URLs or browser activity
- Anything outside the workspace
- Window focus, or whether you switched to another application

This list is enforced by a release gate, not by review: `test/gate/exclusionList.test.ts`
runs the real collectors against a fake editor whose files, pastes, command lines and
diagnostics are canary strings, and fails if any of them reach the wire.

## Privacy & Consent

- Capture begins only when the session records that you accepted the consent disclosure — the extension never asks a second time
- All file paths are workspace-relative (no home directory paths leak)
- Files opened outside the workspace are not reported at all — not even as a redacted path
- Files matching `.promptsterignore` patterns are excluded
- Capture can be paused/resumed at any time via the command palette

## Commands

| Command | Description |
|---------|-------------|
| `Promptster: Pause Capture` | Temporarily stop capturing signals |
| `Promptster: Resume Capture` | Resume after pausing |
| `Promptster: View Captured Signals` | See exactly what is being captured |
| `Promptster: Show Status` | View current capture status |

## Status Bar

The extension shows its state in the status bar:

- `$(eye) Promptster: Capturing` — actively capturing signals
- `$(eye-closed) Promptster: Paused` — capture paused by user
- `$(circle-slash) Promptster: Not capturing` — hover for the reason (no session, no recorded consent, expired, or paused)

## Requirements

- VS Code 1.85+ or Cursor
- An active Promptster assessment (provides the config file via CLI)

## For Hiring Teams

Visit the [Promptster dashboard](https://promptster.dev/dashboard) to view candidate session data, including:

- File reading patterns and exploration breadth
- Edit velocity and typing burst analysis
- Focus fragmentation and idle patterns
- Terminal command usage
- Diagnostic interaction and error resolution

## License

MIT

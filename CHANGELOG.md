# Changelog

## 0.2.0

Bug fixes, schema alignment with the backend canonical event format, and the first unit tests.

### Fixes
- Idle duration now reports the real elapsed time on `idle_end` (previously always ~0ms).
- `file_close` events now carry `dwellMs` when the closed document was the active file.
- Terminal commands no longer ship raw command lines. Each `command` event now sends a tokenized, secret-safe payload: `command` (program + subcommand only), `program`, `subcommand`, `tokenCount`, `hasFlags`, `hadPotentialSecret`.
- `transport.stop()` is now async and awaits the final flush so pending events aren't lost on pause or deactivate.

### Schema alignment
- `session_start` is emitted as a top-level canonical kind (was `editor_focus` + `subKind: 'session_start'`).
- `editor_focus` subKinds renamed `editor_gain`/`editor_blur` → `gain`/`blur`.
- Dropped `terminal_open`/`terminal_close` events (low signal).
- Dropped unused `_sourceExtension` flag on command events.

### Tests
- First test suite (42 tests, vitest): `commandRedactor`, `pathSanitizer`, `offlineQueue`.

## 0.1.0

Initial release.

- File reading and navigation tracking (open, close, tab switch, scroll depth)
- Edit pattern detection (typing bursts, paste, undo/redo)
- Focus and idle tracking (blur/gain, 60s idle threshold)
- Diagnostic interaction (error/warning resolution counts)
- Terminal command capture (command text, exit code, duration)
- File lifecycle events (create, delete)
- Auto-config from `.promptster/config.json`
- Consent dialog with signal details webview
- Offline queue with 1-hour TTL
- Pause/resume capture via command palette
- Status bar indicator

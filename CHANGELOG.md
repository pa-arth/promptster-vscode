# Changelog

## 0.3.2

Packaging and contributor tooling. **No change to what the extension collects or
emits** — the `dist/` payload is byte-identical to 0.3.1's.

### The .vsix stops carrying repository machinery
The 0.3.1 artifact shipped `.github/workflows/ci.yml`, `RELEASING.md` and
`pnpm-lock.yaml` inside the extension installed into every candidate's editor.
None of it is payload; our CI workflow in particular had no business sitting on
someone else's machine. `.github/`, `scripts/`, `dist-vsix/`, the lockfile and
RELEASING.md are now excluded, along with the emitted `.d.ts` declarations that
nothing in a `.vsix` consumes. `README.md` and `CHANGELOG.md` stay — a registry
listing renders them. Verified with `vsce ls`: 33 entries, and the only
non-`dist/` files left are `package.json`, `README.md`, `CHANGELOG.md`,
`.promptsterignore.default` and `assets/icon.png`.

### pnpm is pinned where a contributor reads it
`packageManager: pnpm@10.4.1` in `package.json` — the version CI already used,
so the build is unchanged. Nothing previously told a package manager this repo
was pnpm-only: `npm install` would have succeeded and written an untracked
`package-lock.json`, a second and untested dependency set. A local preinstall
guard rejects npm and yarn, rather than `npx --yes only-allow`, which runs
unpinned registry code with installer privileges on every install.

## 0.3.1

Delivery correctness in the transport, and the first CI this repository has had.

### Failed events are requeued; delivered ones are not re-sent
- `flush()` requeued `allEvents.slice(sent)` after `sendBatch` returned a COUNT
  of successes. Sends run three at a time and complete out of order, so that
  count cannot say which events landed: with one failure in a batch of four, the
  old code requeued an event already delivered and dropped the one that failed.
- The re-send half was not harmless. `raw_events` is idempotent on the event id,
  but `timeline_events` inserts with a fresh id and has no unique constraint on
  the source event, so a duplicate POST wrote a second row — and the replay's
  attention counts and dwell totals came out wrong.
- `sendBatch` now returns the failed events themselves, in the order they were
  given, so a retry preserves the order the candidate produced them in.
- The concurrency cap is held on the sender rather than per call. It exists
  because ingest is 100 req/min per API key and this sender spends one request
  per event, sharing that bucket with the CLI's hook binary.

### The test suite was red, and nothing said so
- `sessionLifecycle.test.ts` hard-coded `expiresAt: '2026-08-22T10:00:00Z'`.
  Once that date passed, `isExpired` correctly refused the session and every
  "did it capture?" assertion collapsed to zero — nine failures, none of them
  about the code under test. The default fixture is now relative to now.
- Added CI: typecheck and the full suite on push, pull request, and nightly.
  There were no workflows at all before this. The nightly run is what turns "a
  fixture rots on a date" into a message rather than a surprise.

### Documented
- `RELEASING.md` now records that `Promptster.promptster@0.1.0` is still live on
  Open VSX, what that build does that the candidate promise disclaims, and the
  two routes to resolving it.

## 0.3.0

Editor attention capture — the extension is wired to the session, honours what it
publishes, and no longer manufactures attention on reattach.
See `openspec/changes/editor-attention-capture`.

### The extension can now actually activate
- Reads `.promptster/session.json`, which is what `promptster start` writes.
  `.promptster/config.json` was never written by anything, so the extension had
  never activated on a real machine. `config.json` is still read as a fallback.
- Accepts the CLI's `key` field for the candidate key (previously only `apiKey`).
- Stops capturing once the candidate key expires — with a guard for Go's zero
  time (`0001-01-01T00:00:00Z`), which would otherwise expire every session.

### Consent comes from the session
- No second consent dialog. Capture begins only when the session records that
  the candidate accepted the canonical disclosure, and the extension never asks.
- Consent is no longer a machine-wide `globalState` flag: it was shared across
  assessments, so one session's consent covered the next one.
- A pause now survives a reload. It was a module variable, so pause → reload
  silently resumed capture.
- The status bar says why it is not capturing, rather than "Not configured".

### Reattach idempotence
- `session_start` is emitted once per session, not once per attach.
- Files reported by a previous attach are not re-reported when the editor
  restores its open editors, and `isNewFile` stays truthful across a reload.
- A rewrite of `session.json` (the CLI does several per session) no longer
  restarts capture.

### Privacy
- Out-of-workspace files are dropped entirely. They were emitted with the path
  redacted to `<external>`, which still shipped their language, line count,
  dwell, scroll depth and typing volume.
- `source.cwd` no longer carries the absolute workspace path on every event.
- `.promptsterignore` is actually read. `loadIgnorePatterns()` was a stub.
- Window focus/blur is no longer captured — the public candidate promise
  disclaims focus tracking by name.
- Keystroke-interval timing ships only under the cadence opt-in.

### Tests
- `test/gate/exclusionList.test.ts`: the published exclusion list is now a
  release gate, run against the real collectors driven by a fake VSCode host.
- `test/integration/sessionLifecycle.test.ts`: session config, consent and
  reattach idempotence, driven through the real extension entry point.
- 98 tests.

### For `promptster doctor`
- Writes `.promptster/editor-capture.json` on every reconcile: extension
  version, editor, session id, whether it is capturing, and why not when it is
  not. An installed-but-dormant extension produces a session with no attention
  events — indistinguishable from a candidate who opened no files — so
  "present" is not a sufficient check and the extension has to say so itself.

### Release
- `scripts/build-vsix.sh` builds the `.vsix` reproducibly (fixed zip entry order,
  `SOURCE_DATE_EPOCH` from the commit date, fixed permissions) and writes a
  `.sha256` beside it. Verified: two builds of one commit, with mtimes touched
  in between, produce identical bytes. `--tag` creates the `vN.N.N` tag with the
  checksum in the tag message.
- The artifact was never committed — `*.vsix` is gitignored and
  `promptster-0.1.0.vsix` existed untracked on one machine, a version behind its
  source and unattributable to any commit.

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

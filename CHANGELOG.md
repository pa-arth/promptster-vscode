# Changelog

## 0.3.15

### One agent terminal per session, whatever the browser
Reopening a hosted box from another browser, an incognito window or after
clearing site data launched another Claude Code terminal and re-sent
`session_start`. The once-per-session latches lived only in `globalState`,
which code-server keeps in the browser's IndexedDB, not on the box. Found on a
live 1.13.1 box (session d35c34cc): two reopens left three *Promptster
Assessment* terminals and four `session_start` events. Both latches are now
claimed by exclusively creating `.promptster/editor-latches/<session>.<latch>`
in the workspace, which every window shares and which is atomic across the
separate extension host each window gets. A failed browser-state write no
longer cancels a won claim. Sessions already running when this ships are only
partly covered: an older build kept the latch in one browser, so the marker is
written when that browser reattaches, and a different browser that attaches
first can still launch once more.

## 0.3.14

### Check-ins switched on mid-session arrive
While an assessment's check-ins are off, the view re-asks every 5 minutes instead of
stopping for the session, so a recruiter who turns them on mid-session still reaches
the candidate. A 401 still stops until the session changes.

### Mid-session check-ins (openspec `mid-session-check-ins`, tasks 2.1–2.3)
When the hiring team turns check-ins on, Jordan (engineering lead) appears first
in the Teammates view, on every hosted session — ticket-flow or not (on a
non-ticket-flow session Jordan is the only person). The view polls
`GET /v1/sessions/:id/check-ins` every 30s and stops on `check_ins_off` or 401
until the session changes. A new open question reveals the view without taking
keyboard focus (`WebviewView.show(true)`, or `promptster.teammates.focus` with
`{ preserveFocus: true }` when the view was never resolved), selects Jordan
unless the candidate is already in the panel, puts an unread dot on Jordan, and
shows a non-modal "Jordan checked in" notification with an Open action. Replies
to Jordan post to `/check-ins/messages`.

## 0.3.13

### The Assessment view appears on hosted boxes
The Assessment sidebar ("Review & submit") was gated on an `assessment.json`
in the workspace root, and nothing in the hosted lane writes one — not
provisioning, not ARM, not `promptster start --seeded`. So
`promptster.assessmentWorkspace` was false on every hosted box and candidates
could only submit with `promptster done` in a terminal. On a hosted session the
view now takes its title and problem key from the ARM-written session
(`assessmentTitle`, `issueId`), and uses a lone root-level `<key>.spec` as the
handoff when a ticket-flow stub is present. Without a spec, "Open ticket" reads
"Open task" and opens TASK.md; the handoff button is hidden. Laptop sessions
are unchanged.

### TASK.md is the first thing a hosted candidate sees
When the hosted agent terminal launches (once per session), TASK.md opens in the
rendered markdown preview. Provisioning now sets `workbench.startupEditor:
none`, so code-server's Welcome tab no longer claims the editor first.

### Tool caches are not file activity
`.pytest_cache/`, `__pycache__/`, `.mypy_cache/`, `.ruff_cache/`, `.hypothesis/`,
`.tox/`, `.nox/`, `.venv/`, `venv/`, `.cache/`, `.turbo/`, `.next/`,
`.nyc_output/`, `.gradle/` and `*.pyc`/`*.pyo` are now default-ignored. A
single `pytest` run produced a burst of `file_create` events for
`.pytest_cache` files the candidate never made.

## 0.3.12

### Agent writes are no longer candidate edits
A file the agent wrote while it was open in the editor came through as a
candidate `paste` of the agent's code: VS Code reloads the document from disk
and fires the same change event a keystroke does. A change that leaves the
document clean is now dropped — a keystroke or real paste always leaves it
dirty. File-watcher `file_create` / `file_delete` events are now stamped as a
system observation (`actor.type: system`, attribution `unknown`) instead of the
candidate: the watcher sees that a file appeared, not who made it, and the
agent's Write tool fires a create on every write. Found on hosted "CI queue
poller" sessions where files only Claude touched read as human-revised. The
backend reconciles already-stored sessions (promptster-backend
`authorshipReconcile`).

## 0.3.11

Reconciles the two histories: 0.3.7–0.3.10 shipped to hosted boxes from a local
`main` that was never pushed and never merged the 0.3.6 work on `origin/main`.
This build carries both.

### Budget in the status bar
Beside the clock: AI spend against the assessment's budget (`$3.21 / $25.00`),
read from `GET /v1/sessions/:id/budget` with the session key and refreshed once
a minute. The budget is the same cap the model proxy enforces. When it can't be
read the item is hidden rather than showing `$0`.

### Teammates: a reload mid-send
A Teammates panel that reloads while a message is in flight stays in its
waiting state instead of accepting a second message the extension would drop,
and the reply isn't shown twice.

### A countdown (first shipped here; landed as 0.3.6 on origin/main), and a time's-up notice before the editor disconnects
A timed session now shows the time left in the status bar (`42:13 left`). It
turns amber in the last five minutes and warns at 10, 5 and 1 minutes left. At
zero a modal says time is up, that work is being submitted automatically, and
that the editor will disconnect. This is the one chance to say so: right after
that the box pauses, the proxy drops the socket, and code-server can only show
"Reconnecting". The deadline is `startedAt + timeLimitMinutes` from
`session.json`, the same rule the CLI's watcher uses to submit, so the clock
and the submit agree. Untimed sessions show nothing.

## 0.3.6

Add native assessment navigation for ticket-flow workspaces: ticket and handoff files, company-assigned Codex or Claude Code terminals, and saved submission through the existing CLI. Reuse the hosted session’s agent terminal. Gate actions on the current session, consent, and expiry; recheck consent after submission confirmation. Correct the Teammates view’s webview declaration.

Validation: TypeScript compilation and 123 tests, including assigned-tool rejection, terminal reuse, and consent-change regressions.

## 0.3.5

First tagged build since 0.3.2. It covers 0.3.3–0.3.5, which were bumped in
`package.json` but never released.

### Teammates view for ticket-flow assessments (#11)
When the session sets `promptster.ticketFlow`, a Teammates view lists the
ticket's personas. The candidate can message them; threads are recorded as
`teammate_message` events through the persona endpoint. The view stays hidden on
every other assessment.

### Hosted assessments (#8, #9, #10)
The extension recognizes the hosted session token, launches the assessment's
agent automatically, and gives it focus when the box opens.

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

# Capture lifecycle

The product. Everything else in this extension supports it: read the session the
CLI wrote, decide whether capture is allowed, run the collectors, and say out
loud what you are doing.

## Sub-features

- **Activation** — `activationEvents: ["onStartupFinished"]`. There is no
  command-triggered activation and no `workspaceContains` clause: the extension
  loads in every window and then decides.
- **Session read** — `readSession()` in `src/config.ts` reads
  `.promptster/session.json`, then `.promptster/config.json`. The second is a
  compatibility path only; nothing in the CLI has ever written it.
- **Key aliases** — `fromJson()` accepts `sessionToken` (what hosted ARM writes),
  then `key`, `apiKey`, `api_key`. Missing `apiUrl`, key, or `sessionId` means
  the file is not usable and capture does not start.
- **Capture decision** — `captureDecision()` in `src/consent.ts`, four reasons,
  all of them correct dormant states. See [README.md](README.md).
- **Reconcile** — `reconcile()` in `src/extension.ts`, the idempotence boundary.
- **Capture state report** — `.promptster/editor-capture.json`, written
  write-then-rename by `src/captureState.ts` on every reconcile.
- **Setting `promptster.enabled`** — contributed, defaults `true`. **Read the
  gotcha below before you go near it.**
- **Hosted agent launch** — for sessions with `noSelfEvict: true`, the extension
  closes the editor's generic agent sidebar, reveals the Promptster container and
  opens a terminal running `claude` or `promptster codex`, exactly once per
  session.

## How to get to it (user POV)

Run `promptster start` in a directory, then open that directory in VS Code or
Cursor. The status bar shows `Promptster: Capturing`; opening files and typing
produces `editor_focus` / `editor_edit` events.

## Driving it with control-vscode

```bash
CV=.agents/skills/verify-vscode/control-vscode.mjs
node $CV build
node $CV workspace --dir /tmp/pv-ws
node $CV drive --workspace /tmp/pv-ws
node $CV state --workspace /tmp/pv-ws
```

Each dormant reason has a workspace that produces it:

```bash
node $CV workspace --dir /tmp/pv-noconsent --session consentAccepted=false
node $CV workspace --dir /tmp/pv-expired  --session expiresAt=2020-01-01T00:00:00Z
node $CV workspace --dir /tmp/pv-hosted   --session noSelfEvict=true
rm -rf /tmp/pv-none/.promptster && node $CV drive --workspace /tmp/pv-none
```

## Proves it works

From one `drive` run against a consented workspace, all of:

- `extension.found: true` **and** `extension.active: true`. If `activate()` threw,
  the host still starts and the extension is simply absent — nothing else errors.
- `captureStateBefore.capturing: true` with `sessionId` equal to the session you
  wrote and `reason` **absent**.
- `editor` and `extensionVersion` in the capture state match the editor you drove
  and the manifest version.
- Against `--session consentAccepted=false`: `capturing: false` and
  `reason: "consent-not-recorded"` — **and `sessionId` still present**. Present,
  activated, and saying it is dormant is precisely the state that has to be
  distinguishable from "not installed".

A run where `capturing` is `false` with no `reason`, or where the capture state
file is absent entirely on a workspace that has a session, is a fail.

## Gotchas

- **`promptster.enabled` is dead.** It is contributed in `package.json` with a
  description promising it will "Enable or disable Promptster telemetry capture",
  and **nothing in `src/` reads it** — `grep -rn getConfiguration src/` returns
  nothing. Unticking it in Settings changes nothing; capture continues. `drive`
  reports its value under `config` so you can see it move while the behavior does
  not. Verified 2026-09-16. This is a candidate-trust problem, not a cosmetic one:
  the surface offers an off switch that is not wired to anything. Do not report a
  proof as passing on the strength of this setting, and do not assume flipping it
  is a way to produce a dormant state — use consent or pause.
- **The host loads `dist/`, never `src/`.** `main` is `./dist/extension.js`. Edit
  a source file, skip `build`, drive, and you verified the previous build.
  `doctor` checks this and `drive` refuses on a stale build.
- **A rewrite of `session.json` is not a new session.** The CLI rewrites it
  several times per session. `isSameCapture()` compares only `sessionId`,
  `apiUrl`, `apiKey`, `consentAccepted`, `consentToIntegrity`; a change to
  anything else must leave capture running and must not re-emit `session_start`.
- **`session_start` is emitted once per session, not once per attach**, guarded
  by `sessionStartEmitted` in `SessionStore` (globalState). A reload that emitted
  a second start would put a second start on the candidate's timeline.
- **The Go zero time is not an expiry.** `encoding/json` marshals a zero
  `time.Time` as `0001-01-01T00:00:00Z`; `isExpired()` deliberately treats any
  year before 2000 as no expiry. A proof that "fixes" this by expiring the session
  kills every session.
- **A pause survives a reload.** Resuming is the candidate's call. If you pause in
  a drive run, the workspace stays paused for the next one — pass a fresh
  `--workspace`, or resume explicitly.
- **`.promptster/editor-capture.json` is local diagnostics only.** Nothing in it
  is sent anywhere, and `pathSanitizer` refuses to report paths under
  `.promptster/`, so writing it can never itself become a captured event.

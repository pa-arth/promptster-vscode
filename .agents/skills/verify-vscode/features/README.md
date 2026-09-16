# promptster-vscode — Feature Map

What a candidate can actually touch in this extension, and how an agent drives
it. Read this before driving; it costs far fewer tokens than re-deriving the
`contributes` block and the reconcile path from source.

Every drive command below is:

```bash
node .agents/skills/verify-vscode/control-vscode.mjs <cmd>
```

## The whole surface, from the real manifest

`package.json` → `contributes`. Nothing else is user-reachable.

| # | Feature | Contributed as | File |
|---|---------|----------------|------|
| 1 | [Capture lifecycle](capture-lifecycle.md) — the product | `activationEvents: ["onStartupFinished"]` | `src/extension.ts`, `src/config.ts`, `src/consent.ts`, `src/captureState.ts` |
| 2 | [Pause & resume](pause-resume.md) | `promptster.pause`, `promptster.resume` | `src/ui/commands.ts` |
| 3 | [Status & consent viewer](status-and-consent.md) | `promptster.viewDetails`, `promptster.showStatus`, `promptster.configure`, status bar | `src/ui/statusBar.ts`, `src/ui/consentWebview.ts` |
| 4 | [Assessment views & ticket](views-and-ticket.md) | views `promptster.assessment`, `promptster.teammates`; custom editor `promptster.ticket` | `src/ui/assessment.ts`, `src/ui/teammates.ts`, `src/ui/ticket.ts` |
| 5 | [promptster-cli integration](cli-integration.md) | not contributed — the install/detect path | `promptster-cli/editor_extension*.go`, `src/captureState.ts` |

There is exactly one contributed setting, `promptster.enabled`, and it is in
feature 1 — read its entry before you touch it.

## Before anything: is the session there?

**This extension does nothing without `.promptster/session.json`.** It has no
build-time API URL, no setting for one, and no consent state of its own
(`src/config.ts`, `src/consent.ts`). All of it comes from the file
`promptster start` writes.

So an agent driving a bare folder sees an extension that activates, decides
`no-session`, and correctly captures nothing — and can report "it works" having
verified only that it can stay quiet. Make a real workspace:

```bash
node .agents/skills/verify-vscode/control-vscode.mjs workspace --dir /tmp/pv-ws
node .agents/skills/verify-vscode/control-vscode.mjs drive --workspace /tmp/pv-ws
```

`expiresAt` in that generated session is **relative to now**. A hard-coded
expiry makes every future run a silent no-capture that looks like a broken
extension; that exact failure has happened here before (see the comment in
`test/integration/sessionLifecycle.test.ts`).

## The one gotcha that invalidates most proofs

**"Not capturing" is usually the extension working correctly.**
`captureDecision()` in `src/consent.ts` returns exactly four reasons, and each
one is a correct dormant state, not a bug:

| `reason` | Means | Correct? |
|----------|-------|----------|
| `no-session` | no usable `.promptster/session.json` in the workspace | yes |
| `consent-not-recorded` | the session file does not record `consentAccepted: true` | yes — the extension never asks on the candidate's behalf |
| `session-expired` | the candidate key aged out | yes |
| `paused` | the candidate ran `Promptster: Pause Capture` | yes |

A proof that treats any of these as a failure — or "fixes" a run by expecting
`capturing: true` where the extension is right to be dormant — is a false
finding. The thing that IS a bug is `capturing: false` with **no reason**, or a
`reason` that does not match the workspace you set up.

The mirror image is the one that costs money: **an extension that is installed
but never activated writes no capture state at all**, and produces a session
with no attention events, which on the review surface reads exactly like a
candidate who opened no files. Those two support opposite hiring decisions.
`present` is never a sufficient check — see [cli-integration.md](cli-integration.md).

## Two facts about this machine that are not bugs in the extension

- **`code` is not necessarily VS Code.** Here `/usr/local/bin/code` symlinks into
  `/Applications/Cursor.app`, and VS Code is not installed. `doctor` resolves it
  and says so. Drive Cursor; the extension supports it and reports
  `"editor": "cursor"` in the capture state via `detectIntegration()`.
- **Cursor reports `vscode.version` as `1.128.0`** while `cursor --version` says
  `3.20.17`. The manifest requires `engines.vscode ^1.85.0`, which the API
  version satisfies. Do not "fix" the engine range against the app version.

## Idempotence, which is the design of this extension

`reconcile()` (`src/extension.ts`) is the boundary. It runs on activation, on
resume, and on **every write to the session file** — and the CLI rewrites
`session.json` several times per session. A restart on each write would re-emit
`session_start` and re-report every open file, and every derived measure over
these events is a count, so a duplicate does not add noise: it **manufactures
attention that did not occur**.

Practical consequence for a proof: driving the same command twice, or reloading
the window, must not double anything. If you are verifying a change anywhere near
`reconcile()`, `isSameCapture()`, or `SessionStore`, the proof is "the count did
not move", not "the command ran".

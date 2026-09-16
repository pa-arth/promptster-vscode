# Pause & resume

The candidate's control over being recorded. The one part of this extension a
candidate is most likely to use under stress, and the one whose silent failure is
worst: a pause that reports success without stopping capture records someone who
believes they are not being recorded.

## Sub-features

- `promptster.pause` — "Promptster: Pause Capture". Sets `paused: true` on the
  session in `SessionStore` (globalState), then calls `reconcile()`, then shows
  "Promptster capture paused."
- `promptster.resume` — "Promptster: Resume Capture". Clears the flag, reconciles,
  shows "Promptster capture resumed."
- Status bar reflects it: `$(eye-closed) Promptster: Paused`.
- The pause is **persisted per session id**, so it survives an editor reload.

## How to get to it (user POV)

Command palette → "Promptster: Pause Capture" / "Promptster: Resume Capture".
Also surfaced in the status bar tooltip when paused.

## Driving it with control-vscode

```bash
CV=.agents/skills/verify-vscode/control-vscode.mjs
node $CV workspace --dir /tmp/pv-pause
node $CV drive --workspace /tmp/pv-pause --commands promptster.pause,promptster.resume
node $CV state --workspace /tmp/pv-pause
```

To prove persistence across a reload, drive twice against the same workspace —
the second `drive` is a fresh host on the same globalState:

```bash
node $CV drive --workspace /tmp/pv-pause --commands promptster.pause
node $CV drive --workspace /tmp/pv-pause     # no commands; just activate and report
```

## Proves it works

Not "the command resolved". The command handler resolving proves only that a
handler is registered. What proves it:

- After `promptster.pause`: `captureStateAfter.capturing === false` **and**
  `reason === "paused"`, and `drive` reports `captureStateChanged: true` for that
  step.
- After `promptster.resume`: `capturing === true` and `reason` absent.
- Across two `drive` runs on the same workspace, a pause from the first run is
  still reported by the second run's `captureStateBefore`. Resuming is the
  candidate's call, not the extension's.

A step with `ok: true` and `captureStateChanged: false` on a pause is a **fail** —
that is precisely the shape of a command that is registered, returns cleanly,
shows its confirmation toast, and does nothing. Measured side by side on a real
host, the two are told apart only by the side effect:

```
HEALTHY pause -> ok=True changed=True  capturing=False reason=paused
BROKEN  pause -> ok=True changed=False capturing=True  reason=None
```

`ok` is `true` in both. Never stop at `ok`.

`captureStateChanged` deliberately ignores `updatedAt`: `reconcile()` rewrites
that timestamp on every pass whether or not the decision changed, so comparing
whole files would report "changed" for a command that did nothing — the exact
failure the field exists to expose.

## Gotchas

- **Pause goes through `reconcile()`, not around it.** The handler sets the flag
  and reconciles; it never tears capture down directly. A change that stops
  capture from inside the command handler would leave a different status bar and
  a different reported capture state from every other way of not capturing, and
  the drive result would still look fine. Check the `reason` string, not just
  `capturing`.
- **Pause is keyed by session id.** `store.update(session.sessionId, …)`. A
  workspace with a different `sessionId` is not paused, even in the same editor
  profile. If you generated a fresh workspace, you get a fresh session id and a
  fresh unpaused state — that is correct, not a lost pause.
- **`onPause` falls back to `readSession()` when nothing is running.** Pausing a
  workspace that was never capturing still records the pause, and the capture
  state then reports `paused` rather than `no-session`. Both are correct; expect
  the one that matches your workspace.
- **Resume does not un-expire or un-consent anything.** Resuming a session whose
  key has expired leaves `capturing: false` with `reason: "session-expired"`.
  That is the extension working.
- The confirmation toasts (`showInformationMessage`) are not observable from the
  probe. Do not build a proof on them; the capture state is the observable.

# Status bar & consent viewer

What the extension says about itself to the candidate, in the editor. This is the
disclosure surface: it is the part of the product that has to be believed, so a
proof here is about the text being present and honest, not just a panel opening.

## Sub-features

- **Status bar item** (`src/ui/statusBar.ts`) — right-aligned, priority 100, four
  states: `$(eye) Promptster: Capturing`, `$(circle-slash) Promptster: Not
  capturing` (tooltip carries the reason), `$(eye-closed) Promptster: Paused`,
  `$(warning) Promptster: Error`. Its `command` is `promptster.viewDetails`, so
  clicking it opens the viewer.
- `promptster.viewDetails` — "Promptster: View Captured Signals". Opens the
  consent webview panel (`showConsentDetails`), titled "Promptster — Captured
  Signals", `enableScripts: false`.
- `promptster.showStatus` — "Promptster: Show Status". **Opens the same webview.**
  Two command ids, one handler, in `src/ui/commands.ts`.
- `promptster.configure` — "Promptster: Configure". Shows an information message
  explaining that the extension reads `.promptster/session.json`, written by
  `promptster start`. It configures nothing; it is a pointer.

## How to get to it (user POV)

Click the Promptster status bar item, or run any of the three commands from the
command palette.

## Driving it with control-vscode

```bash
CV=.agents/skills/verify-vscode/control-vscode.mjs
node $CV workspace --dir /tmp/pv-status
node $CV drive --workspace /tmp/pv-status \
  --commands promptster.viewDetails,promptster.showStatus,promptster.configure
```

For the status bar itself and the rendered webview text, there is no programmatic
read — see Gotchas. Use:

```bash
node $CV drive --workspace /tmp/pv-status --keep-open --commands promptster.viewDetails
```

and look at the window, or read `getConsentHtml()` in `src/ui/consentWebview.ts`
and check the rendered panel against it by eye.

## Proves it works

- `contributed` in the drive result has `promptster.viewDetails`,
  `promptster.showStatus` and `promptster.configure` all `true`. A contributed
  command missing from the live registry means `registerCommands` did not run,
  which means `activate()` threw before reaching it — everything downstream of
  that point is unverified regardless of how the rest of the run looks.
- Each of the three steps returns `ok: true` with no `error`. These commands
  create UI; a throw here surfaces as a step error, not as a silent no-op.
- `captureStateChanged: false` for all three is **correct**. These are viewers;
  none of them changes capture. Pause/resume is the feature where a `false` there
  is a fail — do not carry that expectation over.
- Visually (with `--keep-open`): the panel lists the captured signals AND the
  not-captured list, and the status bar shows a state consistent with the
  workspace you drove.

## Gotchas

- **`showStatus` and `viewDetails` are the same thing.** If you are verifying a
  change to one, drive both; a refactor that splits them is only proved by both
  ids still resolving to working panels, and a refactor that accidentally drops
  one leaves a command in the palette that throws.
- **`configure` does not configure.** It shows a message. There is no settings UI
  and, deliberately, no API URL setting — an extension pointed at the wrong
  backend is worse than one that does nothing. A proof that expects it to open
  settings is testing something that was removed on purpose.
- **The extension never raises a consent dialog.** It used to; that was wrong in
  both directions (re-asking damages the disclosure, and a globalState flag is
  per-machine, so consent for one assessment silently covered the next). Consent
  is a property of the session, recorded by the CLI. If you see a modal on
  activation, that is a regression, not a feature.
- **Webview content is not readable from the probe.** `vscode.window` gives no
  API to read a panel's rendered DOM from an extension test, and these panels have
  `enableScripts: false` so nothing inside can post out. `drive` can prove the
  command ran and did not throw; proving the *text* needs `--keep-open` and a
  human, or a unit test over `getConsentHtml()`. Say which one you did.
- **The status bar is not readable from the probe either**, for the same reason.
  `.promptster/editor-capture.json` carries the same state the status bar is
  rendering from — verify against that, and treat the status bar as a display of
  it rather than an independent fact.

# promptster-cli integration

Not a contributed feature — the seam. `promptster-cli` embeds this extension's
`.vsix`, installs it into every supported editor it finds, and later looks for it
again in `promptster doctor`. Install and detect are **two different code paths,
in a different repo, joined by a hard-coded string**. They break independently of
anything visible in an editor, and the failure is silent in the direction that
costs most.

Do not edit promptster-cli from this skill. Report what it should change.

## Sub-features

- **Detection** — `detectEditors()` in `promptster-cli/editor_extension.go`:
  `exec.LookPath("code")`, then `exec.LookPath("cursor")`, each with a macOS
  app-bundle fallback (`/Applications/<App>.app/Contents/Resources/app/bin/…`).
- **Install** — `runInstall()` shells `<cli> --install-extension <vsix> --force`,
  45s timeout, stdin nil. Non-fatal by construction: a candidate whose editor
  cannot take the `.vsix` still completes the assessment.
- **Recording** — `editorCaptureResult{status, installed, failed, detected,
  extensionVersion, vsixSha256, note}` goes onto the session as a `session_start`
  event so a reviewer can tell "no capture available" from "candidate opened no
  files".
- **Doctor** — `editor_extension_doctor.go` checks three things separately:
  installed (`--list-extensions --show-versions`, matched `EqualFold` against
  the constant `editorExtensionID = "promptster.promptster"`), activated
  (`.promptster/editor-capture.json` exists and is under 24h old), and capturing
  (`state.Capturing`, with `captureReasonHelp` for the reason).
- **This side of the seam** — `src/captureState.ts` writes that file, and
  `package.json`'s `publisher` + `name` produce the id the CLI matches on.

## How to get to it (user POV)

`promptster start PST-XXXX-XXXX` offers to install the extension; `promptster
doctor` reports whether attention capture is working.

## Driving it with control-vscode

```bash
CV=.agents/skills/verify-vscode/control-vscode.mjs
node $CV cli-detect                       # what the CLI would conclude here
node $CV package                          # reproducible .vsix (needs a clean tree)
node $CV install --vsix dist-vsix/promptster-<version>.vsix
node $CV doctor                           # installed? which version?
node $CV drive --workspace /tmp/pv-cli    # activate it so it reports a state
node $CV state --workspace /tmp/pv-cli    # what doctor would read
node $CV uninstall
```

`cli-detect` recomputes the CLI's conclusion using the CLI's own rules, without
running the CLI, so it works from this repo alone.

## Proves it works

- `cli-detect` returns `idMatchesCLI: true` — this checkout's
  `publisher.name` is exactly `promptster.promptster` (case-insensitively).
- After `install`, `doctor` reports `installed.<editor>.installed: true` with a
  `version` equal to the manifest version. A version mismatch is not an error but
  it is skew: a reviewer reading an attention track cannot tell which collector
  produced it.
- After a `drive` on a real workspace, `state --workspace <dir>` returns
  `present: true`, `stale: false`, and a `state.capturing` matching the session
  you built. That triple — installed, activated, capturing — is the whole check,
  and **all three must be asserted separately**.

## Gotchas

- **Installed is not activated, and it is the gap that matters.** An extension
  present in the editor but never activated in the workspace writes no
  `editor-capture.json`, produces a session with no attention events, and on the
  review surface is indistinguishable from a candidate who opened no files. Those
  two readings support opposite hiring decisions. Never accept `--list-extensions`
  as proof of capture.
- **The id is duplicated across two repos with no compile-time link.** Rename
  `publisher` or `name` in `package.json` and the `.vsix` still builds, still
  installs, still captures — and `promptster doctor` says "promptster.promptster
  is not installed" forever, telling the candidate to re-run `promptster start`,
  which will not help. `cli-detect` is the check for this; eval case
  `04-publisher-id-drift` is the measurement of whether an agent catches it.
- **`code` on PATH is not necessarily VS Code, and the CLI cannot tell.**
  `detectEditors()` matches on command name only. On this machine
  `/usr/local/bin/code` symlinks into `/Applications/Cursor.app` and no VS Code is
  installed, so the CLI would report `detected: ["vscode","cursor"]`, install the
  same `.vsix` into Cursor twice, and print "Editor extension installed into VS
  Code and Cursor" — naming an editor that is not on the machine. The session then
  records an editor that never existed. `doctor` and `cli-detect` flag this as
  `impersonated`. **Suggested fix for promptster-cli, not applied here:** after
  resolving the CLI path, `filepath.EvalSymlinks` it and take the editor identity
  from the containing `.app`, deduplicating by resolved path so one app is
  installed into once.
- **Staleness is 24h, and `updatedAt` is written on every reconcile.** A capture
  state older than that reads as "has not run recently in this workspace" even
  though the extension is installed and fine. If you are verifying against an old
  workspace, drive it again before reading the state.
- **`promptster doctor` needs a workspace.** With `workspace == ""` it reports
  installation only and returns. A doctor run from the wrong directory reports
  half the truth and looks clean.
- **Packaging refuses a dirty tree on purpose.** `scripts/build-vsix.sh` exits if
  `git status --porcelain` is non-empty, because a `.vsix` built from uncommitted
  changes has a checksum that identifies nothing and the CLI pins that checksum.
  Commit before packaging; do not work around it.

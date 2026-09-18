---
name: verify-vscode
description: Drive the Promptster VS Code extension (promptster-vscode, publisher Promptster, id Promptster.promptster) in a real Extension Development Host and capture proof. Use whenever a change to this extension needs to be shown working — "verify this", "prove it works", "did that actually ship", "does the CLI still see the extension" — or when reproducing a report that capture is not running, a command does nothing, or `promptster doctor` says the extension is not installed. `pnpm test` runs the collectors against a fake `vscode` module; this runs them inside a real editor.
---

# Verify the Promptster VS Code extension

`pnpm test` proves the collectors behave against `test/fakes/vscode.ts`. That
fake is good, but it is a fake: it cannot tell you that `activate()` throws in a
real host, that a command never got registered, that the manifest's `main` points
at a stale build, or that `promptster doctor` cannot find the extension it just
installed. This skill drives the real thing.

Everything runs through one CLI. Every command prints one JSON object; every
failure prints `{ok:false, error, hint}` where `hint` names the fix.

```bash
CV=".agents/skills/verify-vscode/control-vscode.mjs"   # from the repo root
node $CV help
```

No dependencies to install. The CLI is plain Node with no imports outside
`node:*`, so it runs on a fresh checkout before `pnpm install`.

## 1. Launch — a real Extension Development Host, non-interactively

This is the part worth knowing, because it is not obvious that it works:
**a genuine Extension Development Host can be launched and driven from a script
on this machine, with no human at the keyboard.** Verified, not assumed.

```bash
node $CV build                                              # dist/ is what loads, not src/
node $CV drive --commands promptster.pause,promptster.resume
```

`drive` does the whole round trip in one call and returns when it is done:

1. Refuses to start if `dist/` is older than `src/` (see §2).
2. Creates a throwaway workspace containing a live `.promptster/session.json`,
   unless you pass `--workspace <dir>`.
3. Launches the editor's Electron binary directly — not the `code` shim — with
   `--extensionDevelopmentPath=<repo>`, `--extensionTestsPath=<generated probe>`,
   and an isolated `--user-data-dir` / `--extensions-dir`.
4. The probe runs **inside the extension host**: it activates
   `Promptster.promptster`, enumerates the real command registry, invokes the
   commands you named, and reads `.promptster/editor-capture.json` before and
   after each one.
5. Kills the host by the pid it recorded and writes the result to the evidence
   directory.

A real run looks like this (abridged, from an actual execution):

```json
{ "ok": true, "editorDriven": "Cursor",
  "editor": { "appName": "Cursor", "apiVersion": "1.128.0" },
  "extension": { "id": "Promptster.promptster", "found": true, "active": true },
  "steps": [ { "command": "promptster.pause", "ok": true,
               "captureStateAfter": { "capturing": false, "reason": "paused" },
               "captureStateChanged": true } ] }
```

Useful flags: `--editor vscode|cursor`, `--workspace <dir>`, `--timeout <s>`,
`--settle <ms>`, `--keep-open` (leave the window up to look at it yourself),
`--allow-stale`.

### Two traps that will cost you an hour each

- **Keep `--user-data-dir` short.** The host opens a unix socket at
  `<user-data-dir>/<ver>-main.sock`, and macOS caps a socket path at 103
  characters. A scratch dir under `/private/tmp/claude-*/...` exceeds it and the
  host dies with `listen EINVAL` before any extension loads. That is why this CLI
  keeps its state in `~/.promptster-verify/vscode/` and not in a temp dir.
- **The host does not reliably exit when the probe finishes.** Cursor leaves the
  window open. `drive` polls for the result file and then kills the pid it
  started. Do not wait on the process.

### Which editor are you actually driving?

`code` on PATH is frequently **not** VS Code. On this machine
`/usr/local/bin/code` is a symlink into `/Applications/Cursor.app`, and there is
no VS Code installed at all. `doctor` resolves the symlink and says so; `drive`
auto-picks an editor that is really itself and whose app bundle exists.

The extension runs in both and reports which via `detectIntegration()`
(`src/utils/editorDetector.ts`), so a Cursor-only proof is a real proof — but say
in your report which editor you drove, because it lands in the capture state as
`"editor": "cursor"`.

## 2. Doctor — run it first

```bash
node $CV doctor
node $CV doctor --workspace /path/to/workspace
```

It answers one question: **is this checkout and this machine worth driving?**
Two of its checks exist because they catch proofs that look perfect and measure
nothing:

- **`build.current`** — `package.json` `main` is `./dist/extension.js`. The host
  never reads `src/`. Edit a source file, skip the compile, drive the host, and
  you have carefully verified the *previous* build while believing you verified
  your change. `drive` refuses to run on a stale `dist/` unless you pass
  `--allow-stale`.
- **`workspace.captureState`** — installed is not activated. An extension that is
  present but never activated produces a session with **no attention events,
  which on the review surface reads exactly like a candidate who opened no
  files**. Those two support opposite hiring decisions. Only the extension's own
  report separates them, and that report is `.promptster/editor-capture.json`.

`doctor` also reports what `promptster-cli` would conclude about this machine.
For the detail on that, use `cli-detect` (§4).

## 3. Drive

Read [`features/README.md`](features/README.md) first. It maps every contributed
command, view and setting to how a user reaches it and what end state proves it
works, and it names the ones that are **not** what they look like.

```bash
node $CV workspace --dir /tmp/pv-ws                       # a workspace with a session
node $CV workspace --dir /tmp/pv-ws --session consentAccepted=false   # ...or without consent
node $CV drive --workspace /tmp/pv-ws --commands promptster.pause
node $CV state --workspace /tmp/pv-ws                     # what the extension reported
```

The command ids are real and come from the `contributes.commands` block:
`promptster.configure`, `promptster.pause`, `promptster.resume`,
`promptster.viewDetails`, `promptster.showStatus`. `node $CV help` prints them
from the manifest, so it cannot drift.

**A workspace with no `.promptster/session.json` is not a test bed.** Without it
the extension activates, decides `no-session`, and correctly does nothing.
Driving that and reporting "the extension works" verifies only that it can stay
quiet. `workspace` writes a session whose `expiresAt` is relative to now — never
hard-code one, or every future run silently stops capturing.

## 4. The promptster-cli integration

The CLI installs this extension (`editor_extension.go`) and then looks for it
again (`editor_extension_doctor.go`). Those are two different code paths in a
**different repo**, matching on a string, and they break independently of
anything you can see in an editor.

```bash
node $CV cli-detect
```

It computes what `promptster-cli` would conclude, the way the CLI computes it:
`exec.LookPath` on `code`/`cursor` with the macOS bundle fallback, then
`--list-extensions --show-versions` matched case-insensitively against
`promptster.promptster`. It fails loudly when this checkout's
`publisher.name` no longer equals the id the CLI hard-codes — the state where
the `.vsix` installs perfectly, the extension captures perfectly, and
`promptster doctor` says "not installed" forever.

Do not edit promptster-cli from here. Report what it should change.

## 5. Proof standards

A proof that does not meet these is not evidence:

- **Compile first, or you are driving the old build.** `doctor` tells you;
  `drive` refuses. Never reach for `--allow-stale` to make a run go green.
- **Drive the command, then read the side effect.** A command that resolves
  proved only that a handler exists. `promptster.pause` is verified by
  `editor-capture.json` flipping to `capturing:false, reason:"paused"`, not by
  the call returning. `drive` reports `captureStateChanged` per step for exactly
  this reason.
- **Check `extension.active` and the command registry.** If `activate()` threw,
  the host still starts and commands are simply absent. `drive` returns
  `contributed`, a per-command present/absent map against the manifest; a `false`
  in there is a fail no matter how good the rest looks.
- **Not capturing is often correct.** `no-session`, `consent-not-recorded`,
  `session-expired` and `paused` are the extension working. See the gotcha
  section in [`features/README.md`](features/README.md). Never "fix" a proof by
  expecting `capturing:true` where the extension is right to be dormant.
- **Say which editor you drove**, and whether it was VS Code or Cursor.
- **Mocks only at the boundary that already exists.** The generated workspace
  points `apiUrl` at `http://127.0.0.1:9`, which refuses instantly; nothing
  leaves the machine. Do not verify transport behavior this way — `pnpm test`
  covers the sender and the offline queue properly.

## 5b. Attest on the PR, or it will not merge

Automerge requires a verify-vscode attestation naming the **head commit**.
Marking a PR ready for review used to be the only signal that a proof happened,
and nothing read it. Post this after the drive, from the branch:

```bash
gh pr comment <N> --body "<!-- verified: verify-vscode sha=$(git rev-parse HEAD) -->
Drove: <what you drove>. Evidence: <the paths you captured>."
```

The SHA is the whole point. Push another commit and the attestation stops
matching, so the PR blocks until you re-verify — verifying commit A and merging
commit B is the failure this closes. Automerge also needs Greptile at 5/5 with
no P1s; see `scripts/automerge-decision.mjs`.

This is still your own claim. It does not prove you drove anything — it means
not driving is now a thing you had to assert, not a thing you could skip.

## 6. Cleanup

```bash
node $CV cleanup
```

Kills the extension hosts **this CLI started**, by recorded pid, and only after
confirming the process command line still names this repo. Never by process
name: that would kill the editor the user is sitting in. It then removes the
run/workspace scratch dirs.

It does **not** remove evidence. Drive results stay in
`~/.promptster-verify/vscode/evidence/` (override with
`PROMPTSTER_VERIFY_EVIDENCE`). Report the evidence path in your summary — a
verification whose artifacts were torn down with the instance proved nothing.

Run `cleanup` after a failed iteration too. A host left alive holds an
extensions dir and a chunk of memory, and `doctor` will flag stragglers.

## 7. Helpers

Every shipped script is executable and invoked as shown.

| Path | What it is |
|------|-----------|
| `control-vscode.mjs` | the CLI above; `node $CV help` for the full surface |
| `features/` | the feature map — read before driving |
| `evals/run-eval.mjs` | `node .agents/skills/verify-vscode/evals/run-eval.mjs --agent claude` |
| `evals/cases/*.json` | injected-defect cases with planted ground truth |

`run-eval.mjs --validate` checks every case anchor still matches its source file
exactly once, without running an agent. Run it after any refactor; if an anchor
stops matching, fix the case, never loosen the anchor.

## 8. Keeping this skill honest

The feature map is only useful while it is true, and an agent trusts it, so a
stale map costs more than no map. When you drive a feature and find the map wrong
— a renamed command, a changed context key, a new gotcha — fix the map file in
the same change. `/maintain-verification-skill` runs that sweep.

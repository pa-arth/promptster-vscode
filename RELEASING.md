# Releasing promptster-vscode

The `.vsix` is not committed. `*.vsix` is gitignored, and for good reason: a
binary in the tree drifts from its source silently. Before this document existed
the repository's only artifact was `promptster-0.1.0.vsix`, untracked, on one
developer's machine, built from a commit nobody can now identify, while
`package.json` said `0.2.0`.

Instead the artifact is **rebuilt from a tag**, byte-for-byte, by anyone who
needs it, and whatever installs it pins its checksum.

## Cutting a release

1. Bump `version` in `package.json` and add the section to `CHANGELOG.md`.
2. Commit. The build refuses to run on a dirty tree — a `.vsix` built from
   uncommitted work has a checksum that identifies nothing.
3. ```sh
   pnpm run release        # scripts/build-vsix.sh --tag
   ```
   This typechecks, runs the full suite including the published-exclusion-list
   release gate, packages, normalises for reproducibility, writes
   `dist-vsix/promptster-<version>.vsix{,.sha256}`, and creates the `vN.N.N` tag
   with the checksum in the tag message.
4. `git push origin vN.N.N`
5. Give the artifact to whatever installs it, with its checksum. For the CLI:
   ```sh
   make -C ../promptster-cli embed-vsix \
     VSIX=../promptster-vscode/dist-vsix/promptster-<version>.vsix
   ```
   That regenerates `vsix/embedded.go` with the bytes and the pinned sha256, and
   a Go test asserts the two agree.

## Why the build is normalised

`vsce package` writes working-tree mtimes and filesystem ordering into the zip,
so two builds of the same commit differ. A checksum over that is a statement
about a moment, not about a source. `scripts/normalize-vsix.py` rewrites the zip
with entries sorted, every timestamp set to the commit date
(`SOURCE_DATE_EPOCH`), and fixed permissions, so the same commit produces the
same bytes on any machine.

To verify:

```sh
./scripts/build-vsix.sh && shasum -a 256 dist-vsix/*.vsix
touch src/*.ts
./scripts/build-vsix.sh && shasum -a 256 dist-vsix/*.vsix   # identical
```

## What the tag proves

The tag message carries the sha256. Given a tag, anyone can check out that
commit, rebuild, and confirm the artifact a candidate's editor was asked to
install is the one the tag names.

## The public registry copy — resolved for `latest`, still open for `0.1.0`

**The distribution path is the CLI, not a marketplace.** `promptster start`
sideloads the embedded `.vsix` with `--install-extension … --force` on every
run, so the extension version a candidate gets is bound to the CLI version they
installed. There is no auto-update and nothing to click in a marketplace.

That is the intended path, but it is not the only copy that exists:

| registry | what it serves | checked |
|---|---|---|
| VS Code Marketplace | **nothing** — `Promptster.promptster` is not published | 2026-08-23 |
| Open VSX (Cursor's registry) | **`latest` → `0.3.2`**; `0.3.1` and `0.1.0` still resolve by pin | 2026-08-26 |

### What was done, 2026-08-26

`0.3.2` published with the pinned devDependency rather than `pnpm dlx`:

```sh
pnpm install --frozen-lockfile
pnpm exec ovsx publish <path>/promptster-0.3.2.vsix -p "$OVSX_PAT" < /dev/null
```

Three things learned doing it, all of which cost time:

- **`ovsx publish` prints `Published` before the version exists.** The version
  endpoint 404'd for roughly **100 seconds** afterwards while the registry
  indexed. Do not read the CLI's success line as the observation; poll
  `https://open-vsx.org/api/Promptster/promptster/<version>` until it is 200.
- **The published bytes are ours, byte-for-byte.** Downloaded back and compared:
  `sha256 94bb2036…` matches `v0.3.2`'s tag message AND the artifact embedded in
  `promptster-cli`. The registry does not repackage, so the reproducibility
  chain holds all the way to what a registry install pulls.
- **`ovsx` writes the PAT clear-text to `~/.ovsx`** when it cannot open the OS
  credential store, and says so in one line that is easy to miss. Delete it
  after publishing. Passing the token via a shell variable assigned on the same
  line does NOT work — the variable is expanded before the assignment takes
  effect and `ovsx` falls through to an interactive prompt.

### What is still open

**`0.1.0` remains installable by pin**, and re-verified against the live
registry on **2026-08-26** — not carried over from the earlier note — that build:

- hooks `onDidChangeWindowState` and emits `editor_focus` from
  `dist/collectors/focus.js` — which the candidate promise disclaims by name,
  and which `editor-attention-capture` finding P-1 is the reason 0.3.0 does not
  emit;
- carries **no command redactor**: `dist/utils/` holds only `editorDetector`,
  `logger` and `pathSanitizer`, and `dist/collectors/terminal.js` contains zero
  occurrences of `redact`.

Publishing over it did not retract it and could not. **Removal goes through the
registry's admins** — publishers cannot delete a published version themselves.
That request has not been made; make it, and record the outcome here.

Note what publishing DID buy: anyone resolving `latest` — which is what a
`devcontainer.json` `customizations.vscode.extensions` entry does — now gets a
build that honours the promise. That matters because registry installation
becomes mandatory the moment a hosted lane ships, since it installs by registry
id and not from a local file.

**Whichever way this is resolved, record it here.** Nothing in this repository
recorded that a public copy existed, which is how it stayed at 0.1.0.

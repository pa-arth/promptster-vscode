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

## The public registry copy, and why it is a liability

**The distribution path is the CLI, not a marketplace.** `promptster start`
sideloads the embedded `.vsix` with `--install-extension … --force` on every
run, so the extension version a candidate gets is bound to the CLI version they
installed. There is no auto-update and nothing to click in a marketplace.

That is the intended path, but it is not the only copy that exists:

| registry | what it serves | checked |
|---|---|---|
| VS Code Marketplace | **nothing** — `Promptster.promptster` is not published | 2026-08-23 |
| Open VSX (Cursor's registry) | **`Promptster.promptster@0.1.0`** | 2026-08-23 |

`0.1.0` predates this document and the privacy work. Unpacked and checked on
2026-08-23, that published build:

- emits window **focus/blur** from `dist/collectors/focus.js` — which the
  candidate promise disclaims by name, and which `editor-attention-capture`
  finding P-1 is the reason 0.3.0 does not emit;
- carries **no command redactor** in `dist/collectors/terminal.js`.

So a build under our publisher name, installable by anyone today, does a thing
we publicly say we do not do. Two ways out, and they are not equivalent:

1. **Request removal** of the version from Open VSX. Publishers cannot delete a
   published version themselves; it goes through the registry's admins.
2. **Publish the current version over it** so `latest` resolves to a build that
   honours the promise:
   ```sh
   pnpm run release                       # builds dist-vsix/promptster-<version>.vsix
   pnpm dlx ovsx publish dist-vsix/promptster-<version>.vsix -p "$OVSX_PAT"
   ```
   This does **not** retract 0.1.0 — a pinned install of it still resolves.

Publishing to a registry at all becomes mandatory the moment a hosted lane
ships: `devcontainer.json`'s `customizations.vscode.extensions` installs by
registry id, not from a local file. Until then the CLI is the only path that is
actually exercised, and Open VSX is a copy nobody updates.

**Whichever way this is resolved, record it here.** Nothing in this repository
recorded that a public copy existed, which is how it stayed at 0.1.0.

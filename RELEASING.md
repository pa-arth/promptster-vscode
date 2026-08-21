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

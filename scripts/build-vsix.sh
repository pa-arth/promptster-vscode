#!/usr/bin/env bash
#
# Build the extension's .vsix reproducibly and record its checksum.
#
# "Reproducibly" is load-bearing, not decorative. Whatever installs this artifact
# pins its sha256 (promptster-cli embeds both), and a checksum only means
# something if the same source always produces the same bytes. `vsce package`
# alone does not: it records working-tree mtimes and filesystem ordering, so two
# builds of one commit differ.
#
# Usage:
#   scripts/build-vsix.sh              # build from the current commit
#   scripts/build-vsix.sh --tag        # ...and create the vN.N.N git tag
#
# Output:
#   dist-vsix/promptster-<version>.vsix
#   dist-vsix/promptster-<version>.vsix.sha256
#
set -euo pipefail

cd "$(dirname "$0")/.."

TAG_IT=0
[[ "${1:-}" == "--tag" ]] && TAG_IT=1

VERSION="$(node -p "require('./package.json').version")"
OUT_DIR="dist-vsix"
OUT="${OUT_DIR}/promptster-${VERSION}.vsix"

# The artifact must be attributable to a commit. A .vsix built from a dirty tree
# has a checksum that identifies nothing.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is dirty — commit before building a release artifact" >&2
  git status --short >&2
  exit 1
fi

COMMIT="$(git rev-parse HEAD)"
# Fixed timestamp for every zip entry: the commit date. Same commit, same bytes,
# on any machine, on any day.
export SOURCE_DATE_EPOCH="$(git show -s --format=%ct HEAD)"

echo "==> promptster-vscode ${VERSION} @ ${COMMIT:0:12} (SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH})"

echo "==> typecheck"
pnpm run compile

echo "==> tests (includes the published-exclusion-list release gate)"
pnpm test

echo "==> package"
rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}"
pnpm exec vsce package --no-dependencies --out "${OUT}"

echo "==> normalize for reproducibility"
python3 scripts/normalize-vsix.py "${OUT}" "${SOURCE_DATE_EPOCH}"

SHA="$(shasum -a 256 "${OUT}" | cut -d' ' -f1)"
cat > "${OUT}.sha256" <<EOF
${SHA}  promptster-${VERSION}.vsix
EOF

cat <<EOF

==> built ${OUT}
    version  ${VERSION}
    commit   ${COMMIT}
    sha256   ${SHA}

Whatever installs this must pin that sha256. For promptster-cli:
    make -C ../promptster-cli embed-vsix VSIX=$(pwd)/${OUT}
EOF

if [[ "${TAG_IT}" == "1" ]]; then
  TAG="v${VERSION}"
  if git rev-parse "${TAG}" >/dev/null 2>&1; then
    echo "error: tag ${TAG} already exists — bump the version in package.json" >&2
    exit 1
  fi
  git tag -a "${TAG}" -m "promptster-vscode ${VERSION}

sha256(promptster-${VERSION}.vsix) = ${SHA}"
  echo "==> tagged ${TAG} (push with: git push origin ${TAG})"
fi

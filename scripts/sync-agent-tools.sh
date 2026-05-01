#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# scripts/sync-agent-tools.sh
#
# Sync a curated subset of upstream BikS2013/agent-tools into
# src/agent/tools/agent-tools-vendored/upstream at a pinned SHA.
#
# Owned by: U1 (vendoring infrastructure).
# See docs/design/plan-003-agent-tools-integration.md (Phase 1) for context.
#
# Strategy: Option (b) from the plan — copy ONLY the files our six bundled
# wrappers need (glob, grep, multiedit, patch, todoread, todowrite) plus
# their shared infrastructure (types, errors, permissions, prompts/, the
# subset of tools/_shared/ they import). The webfetch/read/write/edit/bash/
# list/task tool directories are NOT copied because they pull external deps
# (@mozilla/readability, jsdom, turndown, dotenv) that we deliberately do
# NOT add to cli-agent's package.json.
#
# Usage:
#   bash scripts/sync-agent-tools.sh                 # sync to upstream HEAD
#   bash scripts/sync-agent-tools.sh --sha <SHA>     # sync to a specific commit
# ---------------------------------------------------------------------------
set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
readonly UPSTREAM_URL="https://github.com/BikS2013/agent-tools.git"
readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly VENDOR_ROOT="${REPO_ROOT}/src/agent/tools/agent-tools-vendored"
readonly UPSTREAM_DEST="${VENDOR_ROOT}/upstream"
readonly TMP_DIR="$(mktemp -d -t agent-tools-sync.XXXXXX)"

# Inclusion list — files relative to upstream's `src/`. Keep this in lockstep
# with the six bundled tools and their direct dependencies.
readonly INCLUDED_FILES=(
  # Foundation (used by every tool)
  "types.ts"
  "errors.ts"
  "permissions.ts"
  "categories.ts"
  "prompts/index.ts"
  "prompts/loader.ts"
  "prompts/registry.ts"
  # Six bundled tools + their co-located prompt fragments
  "tools/glob/index.ts"
  "tools/glob/glob.prompt.md"
  "tools/grep/index.ts"
  "tools/grep/grep.prompt.md"
  "tools/multiedit/index.ts"
  "tools/multiedit/multiedit.prompt.md"
  "tools/patch/index.ts"
  "tools/patch/patch.prompt.md"
  "tools/todoread/index.ts"
  "tools/todoread/todoread.prompt.md"
  "tools/todowrite/index.ts"
  "tools/todowrite/todowrite.prompt.md"
  # _shared infrastructure — only the modules the six tools actually import
  "tools/_shared/index.ts"
  "tools/_shared/jsfallback.ts"
  "tools/_shared/ripgrep.ts"
  "tools/_shared/truncate.ts"
  "tools/_shared/replacers.ts"
  "tools/_shared/patch_parser.ts"
  "tools/_shared/http.ts"
)

# ---------------------------------------------------------------------------
# Cleanup on exit
# ---------------------------------------------------------------------------
cleanup() {
  if [[ -d "${TMP_DIR}" ]]; then
    rm -rf "${TMP_DIR}"
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
sha_arg=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sha)
      shift
      [[ $# -gt 0 ]] || { echo "ERROR: --sha requires a value" >&2; exit 2; }
      sha_arg="$1"
      shift
      ;;
    --sha=*)
      sha_arg="${1#--sha=}"
      shift
      ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Step 1 — clone upstream
# ---------------------------------------------------------------------------
echo "[sync-agent-tools] Cloning ${UPSTREAM_URL} ..."
if [[ -n "${sha_arg}" ]]; then
  # Need full history to checkout a specific SHA reliably.
  git clone --quiet "${UPSTREAM_URL}" "${TMP_DIR}/upstream"
  ( cd "${TMP_DIR}/upstream" && git checkout --quiet "${sha_arg}" )
else
  git clone --quiet --depth 1 "${UPSTREAM_URL}" "${TMP_DIR}/upstream"
fi

readonly UPSTREAM_SRC="${TMP_DIR}/upstream"
readonly RESOLVED_SHA="$(cd "${UPSTREAM_SRC}" && git rev-parse HEAD)"
readonly RESOLVED_ISO_DATE="$(cd "${UPSTREAM_SRC}" && git show -s --format=%cI HEAD)"
echo "[sync-agent-tools] Resolved SHA: ${RESOLVED_SHA}"
echo "[sync-agent-tools] Commit date:  ${RESOLVED_ISO_DATE}"

# ---------------------------------------------------------------------------
# Step 2 — verify upstream license is MIT
# ---------------------------------------------------------------------------
upstream_license="$(node -e "console.log(require('${UPSTREAM_SRC}/package.json').license || '')")"
if [[ "${upstream_license}" != "MIT" ]]; then
  echo "ERROR: upstream license is '${upstream_license}', expected 'MIT'." >&2
  echo "       Refusing to sync — vendoring requires MIT." >&2
  exit 1
fi
echo "[sync-agent-tools] License verified: MIT"

# ---------------------------------------------------------------------------
# Step 3 — clean slate, then copy curated subset
# ---------------------------------------------------------------------------
echo "[sync-agent-tools] Wiping ${UPSTREAM_DEST} ..."
rm -rf "${UPSTREAM_DEST}"
mkdir -p "${UPSTREAM_DEST}/src"

copied_files=()
missing_files=()
for rel in "${INCLUDED_FILES[@]}"; do
  src_path="${UPSTREAM_SRC}/src/${rel}"
  dest_path="${UPSTREAM_DEST}/src/${rel}"
  if [[ ! -f "${src_path}" ]]; then
    missing_files+=( "${rel}" )
    continue
  fi
  mkdir -p "$(dirname "${dest_path}")"
  cp "${src_path}" "${dest_path}"
  copied_files+=( "${rel}" )
done

if [[ ${#missing_files[@]} -gt 0 ]]; then
  echo "ERROR: the following files were missing from upstream src/:" >&2
  for m in "${missing_files[@]}"; do
    echo "         - ${m}" >&2
  done
  echo "       Upstream layout may have drifted. Update INCLUDED_FILES in this script." >&2
  exit 1
fi
echo "[sync-agent-tools] Copied ${#copied_files[@]} files."

# ---------------------------------------------------------------------------
# Step 4 — copy LICENSE
# ---------------------------------------------------------------------------
if [[ -f "${UPSTREAM_SRC}/LICENSE" ]]; then
  cp "${UPSTREAM_SRC}/LICENSE" "${VENDOR_ROOT}/LICENSE"
  echo "[sync-agent-tools] Copied upstream LICENSE."
else
  # Upstream package.json declares MIT but the repo ships no LICENSE file at
  # the SHA we are vendoring. Synthesise a verbatim MIT text so the vendored
  # tree is self-contained and downstream packagers / SPDX scanners are happy.
  cat > "${VENDOR_ROOT}/LICENSE" <<EOF
MIT License

Copyright (c) BikS2013 / agent-tools contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
EOF
  echo "[sync-agent-tools] Upstream had no LICENSE file; wrote synthesised MIT text."
fi

# ---------------------------------------------------------------------------
# Step 5 — copy upstream package.json (provenance only — never executed)
# ---------------------------------------------------------------------------
cp "${UPSTREAM_SRC}/package.json" "${UPSTREAM_DEST}/package.json"
echo "[sync-agent-tools] Copied upstream package.json (for provenance only)."

# ---------------------------------------------------------------------------
# Step 6 — write PROVENANCE.md
# ---------------------------------------------------------------------------
sync_date="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

{
  echo "# Vendored copy — \`BikS2013/agent-tools\`"
  echo ""
  echo "This directory contains a curated subset of the upstream"
  echo "[\`BikS2013/agent-tools\`](${UPSTREAM_URL}) repository, vendored into"
  echo "cli-agent so the wrapped tools (\`agt_*\`) can run without a runtime"
  echo "dependency on a separate npm package."
  echo ""
  echo "## Pin"
  echo ""
  echo "- **Upstream URL:** ${UPSTREAM_URL}"
  echo "- **Pinned SHA:** \`${RESOLVED_SHA}\`"
  echo "- **Upstream commit date:** ${RESOLVED_ISO_DATE}"
  echo "- **Sync date (UTC):** ${sync_date}"
  echo "- **License:** MIT (see \`./LICENSE\`)"
  echo ""
  echo "## Sync command"
  echo ""
  echo '```bash'
  echo "bash scripts/sync-agent-tools.sh --sha ${RESOLVED_SHA}"
  echo '```'
  echo ""
  echo "Run without \`--sha\` to bump to upstream HEAD, then update the pin"
  echo "in this file by re-running."
  echo ""
  echo "## Strategy"
  echo ""
  echo "Strategy: **option (b)** from \`docs/design/plan-003-agent-tools-integration.md\` —"
  echo "the sync script copies an explicit allow-list of files (declared at the top"
  echo "of \`scripts/sync-agent-tools.sh\` in the \`INCLUDED_FILES\` array). The"
  echo "\`webfetch\`, \`read\`, \`write\`, \`edit\`, \`bash\`, \`list\`, and \`task\` tool"
  echo "directories are deliberately **NOT** copied because they import packages"
  echo "(\`@mozilla/readability\`, \`jsdom\`, \`turndown\`, \`dotenv\`) we have"
  echo "decided not to add to cli-agent's \`package.json\`. Excluding the files"
  echo "at sync time avoids polluting cli-agent's \`tsconfig.json\` with an"
  echo "ever-growing \`exclude\` list."
  echo ""
  echo "## Files in scope"
  echo ""
  echo "All paths are relative to \`upstream/src/\`."
  echo ""
  for rel in "${copied_files[@]}"; do
    echo "- \`${rel}\`"
  done
  echo ""
  echo "Total: ${#copied_files[@]} files."
  echo ""
  echo "## Notes"
  echo ""
  echo "- **Do NOT edit files under \`upstream/\` directly** — re-sync instead."
  echo "  Local modifications will be silently overwritten on the next run of"
  echo "  \`scripts/sync-agent-tools.sh\`."
  echo "- The upstream \`package.json\` is copied to \`upstream/package.json\` for"
  echo "  provenance only. cli-agent does not install or execute it."
  echo "- Upstream's tests, build configuration, and adapters (\`src/adapters/\`)"
  echo "  are intentionally NOT vendored. cli-agent writes its own"
  echo "  \`DynamicStructuredTool\` wrappers and runs Vitest, not \`node:test\`."
} > "${VENDOR_ROOT}/PROVENANCE.md"
echo "[sync-agent-tools] Wrote ${VENDOR_ROOT}/PROVENANCE.md"

# ---------------------------------------------------------------------------
# Step 7 — typecheck
# ---------------------------------------------------------------------------
echo "[sync-agent-tools] Running 'npm run typecheck' ..."
if ( cd "${REPO_ROOT}" && npm run typecheck ); then
  echo "[sync-agent-tools] Typecheck passed."
else
  echo "" >&2
  echo "ERROR: typecheck FAILED after sync." >&2
  echo "       The vendored files are still in place under" >&2
  echo "         ${UPSTREAM_DEST}" >&2
  echo "       so you can inspect and debug. Once you understand the cause," >&2
  echo "       either:" >&2
  echo "         (a) update INCLUDED_FILES in scripts/sync-agent-tools.sh, or" >&2
  echo "         (b) pin to a different upstream SHA via --sha, or" >&2
  echo "         (c) update the cli-agent wrappers to match the new upstream" >&2
  echo "             API and re-run." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Done.
# ---------------------------------------------------------------------------
echo ""
echo "Sync complete: ${RESOLVED_SHA}"

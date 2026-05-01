# Vendored copy — `BikS2013/agent-tools`

This directory contains a curated subset of the upstream
[`BikS2013/agent-tools`](https://github.com/BikS2013/agent-tools.git) repository, vendored into
cli-agent so the wrapped tools (`agt_*`) can run without a runtime
dependency on a separate npm package.

## Pin

- **Upstream URL:** https://github.com/BikS2013/agent-tools.git
- **Pinned SHA:** `b8ab63b2f4124325a31e00c9afd3645f02ffd072`
- **Upstream commit date:** 2026-04-30T22:47:56+03:00
- **Sync date (UTC):** 2026-04-30T22:53:59Z
- **License:** MIT (see `./LICENSE`)

## Sync command

```bash
bash scripts/sync-agent-tools.sh --sha b8ab63b2f4124325a31e00c9afd3645f02ffd072
```

Run without `--sha` to bump to upstream HEAD, then update the pin
in this file by re-running.

## Strategy

Strategy: **option (b)** from `docs/design/plan-003-agent-tools-integration.md` —
the sync script copies an explicit allow-list of files (declared at the top
of `scripts/sync-agent-tools.sh` in the `INCLUDED_FILES` array). The
`webfetch`, `read`, `write`, `edit`, `bash`, `list`, and `task` tool
directories are deliberately **NOT** copied because they import packages
(`@mozilla/readability`, `jsdom`, `turndown`, `dotenv`) we have
decided not to add to cli-agent's `package.json`. Excluding the files
at sync time avoids polluting cli-agent's `tsconfig.json` with an
ever-growing `exclude` list.

## Files in scope

All paths are relative to `upstream/src/`.

- `types.ts`
- `errors.ts`
- `permissions.ts`
- `categories.ts`
- `prompts/index.ts`
- `prompts/loader.ts`
- `prompts/registry.ts`
- `tools/glob/index.ts`
- `tools/glob/glob.prompt.md`
- `tools/grep/index.ts`
- `tools/grep/grep.prompt.md`
- `tools/multiedit/index.ts`
- `tools/multiedit/multiedit.prompt.md`
- `tools/patch/index.ts`
- `tools/patch/patch.prompt.md`
- `tools/todoread/index.ts`
- `tools/todoread/todoread.prompt.md`
- `tools/todowrite/index.ts`
- `tools/todowrite/todowrite.prompt.md`
- `tools/_shared/index.ts`
- `tools/_shared/jsfallback.ts`
- `tools/_shared/ripgrep.ts`
- `tools/_shared/truncate.ts`
- `tools/_shared/replacers.ts`
- `tools/_shared/patch_parser.ts`
- `tools/_shared/http.ts`

Total: 26 files.

## Notes

- **Do NOT edit files under `upstream/` directly** — re-sync instead.
  Local modifications will be silently overwritten on the next run of
  `scripts/sync-agent-tools.sh`.
- The upstream `package.json` is copied to `upstream/package.json` for
  provenance only. cli-agent does not install or execute it.
- Upstream's tests, build configuration, and adapters (`src/adapters/`)
  are intentionally NOT vendored. cli-agent writes its own
  `DynamicStructuredTool` wrappers and runs Vitest, not `node:test`.

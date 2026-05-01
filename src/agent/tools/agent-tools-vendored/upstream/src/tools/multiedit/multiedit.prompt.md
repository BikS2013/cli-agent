Apply an ordered list of exact string replacements to a single file atomically.

Usage:
- Provide an absolute `filePath` and an array of `edits`. Each edit has `oldString`, `newString`, and an optional `replaceAll` boolean (default false).
- The edits are applied sequentially in array order. Each edit operates on the result of the previous edit, which means a later edit may target text introduced by an earlier edit.
- The whole batch is atomic: if any edit's `oldString` cannot be located, the operation fails and the file on disk is left unchanged. Either every edit succeeds or none of them are written.
- Each edit follows the same matching semantics as the `edit` tool: an exact literal match is preferred, with progressive fallbacks (line-trimmed, block-anchor, whitespace-normalized, indentation-flexible, escape-normalized, trimmed boundary, context-aware). Ambiguous matches are rejected unless `replaceAll` is true.
- Preserve indentation exactly as it appears in the file (after any line-number prefixes from the read tool). Do not include line numbers in `oldString` or `newString`.
- Avoid emojis unless the user explicitly asked for them.

When to use multiedit vs edit:
- Use `edit` when you have a single, isolated replacement.
- Use `multiedit` when you need to apply two or more related replacements to the same file and you want them to land together (e.g. rename a symbol and update its callers in one call). One file lock, one diff, one permission check.
- If the edits target different files, call `multiedit` once per file or use `patch`.

Failure modes:
- If any single edit fails to match (zero matches, or multiple matches without `replaceAll`), the entire call fails atomically and reports the failing index. The file is not touched. No partial application is ever visible.
- `oldString === newString` for any edit is rejected.
- The edits array must contain at least one entry.
- Permission denial is reported once for the whole batch, before any matching is attempted.

Schema:
- `filePath`: absolute path to the file to modify (string, required).
- `edits`: non-empty array of objects, each with:
  - `oldString` (string, required) — the text to find. May be empty only on the first edit when the file is to be created (not supported in the generic multiedit; use `write` for new files).
  - `newString` (string, required) — the replacement text.
  - `replaceAll` (boolean, optional, default false) — when true, every occurrence in the current buffer is replaced.

The tool preserves the original line endings (`\n` or `\r\n`) and the original byte-order mark, if any, of the file on disk.

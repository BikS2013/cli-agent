---
schemaVersion: 2
toolName: file-cli
discoveredAt: "2026-05-02T00:00:00.000Z"
toolBinaryPath: "/usr/local/bin/file-cli"
toolBinaryDigest: "0000000000000000"
docDigest: "1111111111111111"
manRef: null
manPagePath: null
---

# file-cli — capability document

<!-- AUTO-GENERATED:START hash=2222222222222222 -->
## Synopsis

`file-cli` is a small POSIX CLI that lists, reads, and writes files
on the local filesystem. It supports plain UTF-8 and binary blobs.

## Subcommands

- `ls <path>` — list directory contents.
- `read <file>` — print file contents to stdout.
- `write <file> <text>` — overwrite a file with the given text.
- `digest <file>` — print the sha256 digest of a file.

## Common flags

- `--long` — long-listing format for `ls`.
- `--no-newline` — omit trailing newline for `read`.
- `--mode <0700>` — explicit POSIX mode for `write`.

## Examples

- `file-cli ls /tmp` — list `/tmp`.
- `file-cli read README.md` — print README contents.
- `file-cli write /tmp/x "hi"` — write `hi` to `/tmp/x`.

## Constraints

- No authentication required.
- Will refuse to overwrite a file outside `cfg.fileEdit.root` when
  invoked through cli-agent.
<!-- AUTO-GENERATED:END -->

<!-- USER-RECIPES:START -->
<!-- USER-RECIPES:END -->

<!-- USER-NOTES:START -->
<!-- USER-NOTES:END -->

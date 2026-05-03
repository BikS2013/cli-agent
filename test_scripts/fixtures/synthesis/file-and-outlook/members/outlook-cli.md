---
schemaVersion: 2
toolName: outlook-cli
discoveredAt: "2026-05-02T00:00:00.000Z"
toolBinaryPath: "/usr/local/bin/outlook-cli"
toolBinaryDigest: "3333333333333333"
docDigest: "4444444444444444"
manRef: null
manPagePath: null
---

# outlook-cli — capability document

<!-- AUTO-GENERATED:START hash=5555555555555555 -->
## Synopsis

`outlook-cli` is a thin wrapper around the Microsoft Graph mail API
that authenticates against an Entra ID tenant and exposes simple
read / send subcommands.

## Subcommands

- `auth` — interactive device-code login.
- `send` — send an email; required flags: `--to`, `--subject`.
- `list` — list inbox messages; supports `--folder`, `--top`.
- `read <id>` — fetch the full body of a message by id.

## Common flags

- `--to <addr>` — recipient address (repeatable).
- `--subject <text>` — message subject.
- `--body-file <path>` — path to a file whose contents become the body.
- `--folder <name>` — folder to list/read from. Default: Inbox.

## Examples

- `outlook-cli auth` — sign in.
- `outlook-cli send --to a@example.com --subject hi --body-file note.txt`
- `outlook-cli list --top 10` — show the most recent ten inbox items.

## Constraints

- Requires a successful `outlook-cli auth` first; tokens are cached
  in `~/.tool-agents/outlook-cli/`.
- Subject to the tenant's Microsoft Graph rate limits.
- Cannot delete messages; v1 read+send only.
<!-- AUTO-GENERATED:END -->

<!-- USER-RECIPES:START -->
<!-- USER-RECIPES:END -->

<!-- USER-NOTES:START -->
<!-- USER-NOTES:END -->

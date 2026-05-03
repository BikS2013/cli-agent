## Synopsis

The `email-assistant` composite combines `file-cli` (filesystem read/write) with `outlook-cli` (Microsoft Graph email send/receive) so an agent can package files into outbound email and unpack inbound attachments to disk.

## Cross-tool intents

- email a file to a recipient
- save an inbound message body to disk
- compute a file digest and email it for verification
- list inbox and dump matching messages to disk

## Parameter glossary

- `path` (file-cli): filesystem path the local CLI operates on.
- `--to` (outlook-cli): recipient email address; repeatable for multi-recipient.
- `--subject` (outlook-cli): subject line of an outbound email.
- `--body-file` (outlook-cli): path on disk whose contents become the email body.
- `--folder` (outlook-cli): name of the Outlook folder to list/read from.

## Cross-tool recipes

### Email a local file

Attach a file's text body to an outbound email. Use `file-cli read` for arbitrary file types or pass `--body-file` directly when the file is already in the right shape.

```sh
file-cli read <source-path> > /tmp/body.txt && outlook-cli send --to <recipient> --subject "<subject>" --body-file /tmp/body.txt
```

### Verify a file with its digest

Compute the file's digest and email it as plain text so a human recipient can independently verify the same file.

```sh
file-cli digest <source-path> > /tmp/digest.txt && outlook-cli send --to <recipient> --subject "sha256 of <source-path>" --body-file /tmp/digest.txt
```

### Save an inbound message body to disk

Fetch the full body of a message and persist it to a file. Useful for archiving important notifications.

```sh
outlook-cli read <message-id> > /tmp/msg.txt && file-cli write <archive-path> "$(cat /tmp/msg.txt)"
```

## Constraints and notes

- `outlook-cli` requires a successful `auth` round-trip before any send/read; cache lives in `~/.tool-agents/outlook-cli/`.
- `file-cli` write paths are restricted by `cfg.fileEdit.root` when invoked through cli-agent.
- Microsoft Graph rate limits apply to bulk inbox iteration; throttle accordingly.
- All examples use bracket-placeholders (`<source-path>`, `<recipient>`); the user supplies the real values at invocation time.

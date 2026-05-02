# test_scripts

Integration and smoke test scripts for cli-agent.

Unit tests (*.spec.ts files) live alongside source files in src/.

## Adding integration scripts

Place shell scripts or Node scripts here for end-to-end testing against real providers.
Name format: `NNN-<descriptive-name>.sh` or `NNN-<descriptive-name>.ts`.

Example (requires real OPENAI_API_KEY):
```bash
#!/bin/bash
# 001-smoke-openai.sh — verify one-shot response from OpenAI
node dist/cli.js --provider openai --model gpt-4o "Say hello in one word"
```

## Existing scripts

- `smoke-streaming-llm-events.ts` — end-to-end streaming smoke against the
  configured provider.
- `smoke-tui-banner-and-quit.ts` — TUI banner-render + quit smoke.
- `smoke-profile-cold-start.ts` — measures `cli-agent --help` cold-start
  (3 iterations; min/median/max in ms). Plan-005 AC-22 / NFR-PROF-001.
  Budget: ≤ 50 ms regression vs pre-feature baseline. Informational only —
  does NOT gate CI. Run with `npx tsx test_scripts/smoke-profile-cold-start.ts`
  after `npm run build`.

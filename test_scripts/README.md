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

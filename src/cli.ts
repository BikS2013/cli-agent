#!/usr/bin/env node
/**
 * cli-agent — main CLI entry point.
 *
 * Exit codes:
 *   0   Success
 *   1   Unexpected / unknown error
 *   2   Usage error (bad flag, missing prompt)
 *   3   Configuration error (missing required env var)
 *   4   Auth error
 *   5   Upstream / provider SDK error
 *   6   IO error
 *   130 SIGINT during interactive session
 */

import { Command } from 'commander';
import { runAgentCommand } from './commands/agent.js';
import { runShowCapabilities } from './commands/show-capabilities.js';
import { runRefreshCapabilities } from './commands/refresh-capabilities.js';
import { CliAgentError } from './errors.js';
import { redactString } from './util/redact.js';

const program = new Command();

program
  .name('cli-agent')
  .description('Generic LangGraph ReAct agent that wraps external CLI binaries.')
  .version('0.1.0');

/* ---------- Default command: agent run ---------- */
program
  .argument('[prompt]', 'One-shot prompt for the agent')
  .option('-i, --interactive', 'Start an interactive REPL session', false)
  .option('--tool <name>', 'CLI binary to wrap (repeatable)', collectTool, [] as string[])
  .option('-p, --provider <name>', 'LLM provider (openai|anthropic|gemini|azure-openai|azure-anthropic|ollama|litellm|mlx)')
  .option('-m, --model <id>', 'Model ID / deployment name')
  .option('--base-url <url>', 'Override provider base URL')
  .option('--config <path>', 'Path to config.json')
  .option('--env-file <path>', 'Path to .env file')
  .option('--max-steps <n>', 'Maximum ReAct steps', (v) => parseInt(v, 10))
  .option('--temperature <t>', 'Sampling temperature', (v) => parseFloat(v))
  .option('--system-prompt <path-or-name>', 'Select the BASE system prompt file. Resolution: absolute path → verbatim; bare filename → joined onto <capabilitiesDir>; relative path with separators → joined onto cwd. Omit to use the seeded default at <capabilitiesDir>/system-prompt.md.')
  .option('--system <text>', 'Append text to system prompt')
  .option('--system-file <path>', 'Append file contents to system prompt')
  .option('--per-tool-budget <bytes>', 'Per-tool result byte budget', (v) => parseInt(v, 10))
  .option('--allow-mutations', 'Enable mutating tools (file_write, file_edit, file_append)', false)
  .option('--bash-allow <csv>', 'Extra bash allowlist entries (csv or argv-regex:)')
  .option('--bash-allow-file <path>', 'File with bash allowlist entries (one per line)')
  .option('--bash-pass-secret <NAME>', 'Pass credential env var to child processes (repeatable)', collectTool, [] as string[])
  .option('--web-search-backend <id>', 'Web search backend (tavily|serpapi|brave|duckduckgo|custom-http)')
  .option('--introspect-depth <n>', 'Capability discovery depth', (v) => parseInt(v, 10))
  .option('--introspect-max-bytes <n>', 'Per-tool capability byte budget', (v) => parseInt(v, 10))
  .option('--introspect-timeout-ms <ms>', 'Per --help call timeout (ms)', (v) => parseInt(v, 10))
  .option('--introspect-total-budget-ms <ms>', 'Total capability discovery budget (ms)', (v) => parseInt(v, 10))
  .option('--introspect-skip-llm-below-bytes <n>', 'Skip the LLM extractor when top-level --help is smaller than this many bytes (0 disables)', (v) => parseInt(v, 10))
  .option('--refresh-capabilities', 'Force regenerate cached capability docs', false)
  .option('--verbose', 'Emit structured debug logs to stderr', false)
  .action(async (prompt: string | undefined, opts: Record<string, unknown>) => {
    await handleErrors(async () => {
      const tools = (opts['tool'] as string[]) ?? [];
      const bashAllow = opts['bashAllow']
        ? String(opts['bashAllow']).split(',').map((s: string) => s.trim())
        : undefined;
      const bashPassSecret = (opts['bashPassSecret'] as string[]) ?? [];

      await runAgentCommand(prompt ?? null, {
        interactive: opts['interactive'] as boolean | undefined,
        tools,
        provider: opts['provider'] as string | undefined,
        model: opts['model'] as string | undefined,
        baseUrl: opts['baseUrl'] as string | undefined,
        configFile: opts['config'] as string | undefined,
        envFile: opts['envFile'] as string | undefined,
        maxSteps: opts['maxSteps'] as number | undefined,
        temperature: opts['temperature'] as number | undefined,
        perToolBudget: opts['perToolBudget'] as number | undefined,
        allowMutations: opts['allowMutations'] as boolean | undefined,
        bashAllow,
        bashAllowFile: opts['bashAllowFile'] as string | undefined,
        bashPassSecret,
        webSearchBackend: opts['webSearchBackend'] as string | undefined,
        introspectDepth: opts['introspectDepth'] as number | undefined,
        introspectMaxBytes: opts['introspectMaxBytes'] as number | undefined,
        introspectTimeoutMs: opts['introspectTimeoutMs'] as number | undefined,
        introspectTotalBudgetMs: opts['introspectTotalBudgetMs'] as number | undefined,
        introspectSkipLlmBelowBytes: opts['introspectSkipLlmBelowBytes'] as number | undefined,
        refreshCapabilities: opts['refreshCapabilities'] as boolean | undefined,
        verbose: opts['verbose'] as boolean | undefined,
        system: opts['system'] as string | undefined,
        systemFile: opts['systemFile'] as string | undefined,
        systemPromptFile: opts['systemPrompt'] as string | undefined,
      });
    });
  });

/* ---------- show-capabilities subcommand ---------- */
program
  .command('show-capabilities')
  .description('Print the cached capability document for a wrapped tool.')
  .option('--tool <name>', 'Tool name to show')
  .action(async (opts: { tool?: string }) => {
    await handleErrors(async () => {
      await runShowCapabilities(opts.tool);
    });
  });

/* ---------- refresh-capabilities subcommand ---------- */
program
  .command('refresh-capabilities')
  .description('Re-run capability discovery for one or all configured tools.')
  .option('--tool <name>', 'Tool to refresh (omit for all configured tools)')
  .option('-p, --provider <name>', 'LLM provider')
  .option('-m, --model <id>', 'Model ID')
  .option('--config <path>', 'Path to config.json')
  .option('--env-file <path>', 'Path to .env file')
  .action(async (opts: Record<string, unknown>) => {
    await handleErrors(async () => {
      await runRefreshCapabilities(opts['tool'] as string | undefined, {
        provider: opts['provider'] as string | undefined,
        model: opts['model'] as string | undefined,
        configFile: opts['config'] as string | undefined,
        envFile: opts['envFile'] as string | undefined,
      });
    });
  });

/* ---------- Error handler ---------- */

async function handleErrors(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof CliAgentError) {
      process.stderr.write(redactString(`Error [${e.code}]: ${e.message}\n`));
      process.exit(e.exitCode);
    }
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(redactString(`Unexpected error: ${msg}\n`));
    process.exit(1);
  }
}

function collectTool(value: string, previous: string[]): string[] {
  return [...previous, value];
}

program.parseAsync(process.argv).catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(redactString(`Fatal: ${msg}\n`));
  process.exit(1);
});

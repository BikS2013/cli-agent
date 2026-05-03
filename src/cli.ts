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
import { runExtractRecipes } from './commands/extract-recipes.js';
import { runExtractToolPrompts } from './commands/extract-tool-prompts.js';
import { runShowToolPrompt } from './commands/show-tool-prompt.js';
import { runAuditToolPrompts } from './commands/audit-tool-prompts.js';
import { runProfileList } from './commands/profile/list.js';
import { runProfileShow } from './commands/profile/show.js';
import { runProfileCreate } from './commands/profile/create.js';
import { runProfileEdit } from './commands/profile/edit.js';
import { runProfileDelete } from './commands/profile/delete.js';
import { runProfileDryRun } from './commands/profile/dry-run.js';
import { runCompositeList } from './commands/composite/list.js';
import { runCompositeShow } from './commands/composite/show.js';
import { runCompositeDelete } from './commands/composite/delete.js';
import { handleSynthesize } from './commands/composite/synthesize.js';
import { CliAgentError, UsageError } from './errors.js';
import { redactString } from './util/redact.js';
import { mapAgentToolFlags } from './cli-agent-tools-flags.js';
import {
  parseCompositeFlags,
  enforceCompositeFlagMatrix,
} from './cli-composite-flags.js';
import { runComposite } from './agent/composite/run-composite.js';

// Re-export so existing import sites (and downstream tooling) can continue
// to load `mapAgentToolFlags` from the cli module if they wish, but tests
// should import it directly from `./cli-agent-tools-flags.js` to avoid
// triggering the Commander parse side-effect at the bottom of this file.
export { mapAgentToolFlags };

const program = new Command();

program
  .name('cli-agent')
  .description('Generic LangGraph ReAct agent that wraps external CLI binaries.')
  .version('0.3.0');

/**
 * Migrate from Commander's auto `-h, --help` to a manually registered
 * flag (plan-006 P4 / NFR-CMP-001).
 *
 * Commander v12 intercepts the auto-help BEFORE the `.action()` callback
 * fires, which prevents the `--treat-as-tool --help` composite branch
 * from running. Disabling `helpOption()` and re-registering `-h, --help`
 * as a regular boolean option moves the help interception into the
 * action handler — the byte stream of `cli-agent --help` is preserved
 * because the manual registration uses the same flag spelling and
 * description text Commander would have emitted (`display help for
 * command`). The byte-stability invariant is asserted by
 * `src/cli-help-baseline.spec.ts` against
 * `test_scripts/baselines/help-no-treat-as-tool.txt`.
 *
 * Subcommands receive the same migration locally (`.helpOption(false)`
 * + `.option('-h, --help', 'display help for command', false)` on each
 * `program.command(...)` chain) so subcommand `--help` continues to
 * work for non-composite contexts.
 */
program.helpOption(false);

/* ---------- Default command: agent run ---------- */
program
  .argument('[prompt]', 'One-shot prompt for the agent')
  .option('-i, --interactive', 'Start an interactive REPL session', false)
  .option('-r, --resume [threadId]', 'Resume a previous TUI thread (omit threadId to use the last active session from cursor.json)')
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
  // ---- Agent-tools pack (umbrella) ----
  .option('--agent-tools', 'Enable the agent-tools pack umbrella (default; rarely needed)')
  .option('--no-agent-tools', 'Disable the agent-tools pack umbrella (no agt_* tools registered)')
  // ---- Agent-tools pack (per-tool) ----
  .option('--enable-agt-glob', 'Enable agt_glob (default-on)')
  .option('--disable-agt-glob', 'Disable agt_glob')
  .option('--enable-agt-grep', 'Enable agt_grep (default-on)')
  .option('--disable-agt-grep', 'Disable agt_grep')
  .option('--enable-agt-multiedit', 'Enable agt_multiedit (default-on; mutation-gated)')
  .option('--disable-agt-multiedit', 'Disable agt_multiedit')
  .option('--enable-agt-patch', 'Enable agt_patch (default-on; mutation-gated)')
  .option('--disable-agt-patch', 'Disable agt_patch')
  .option('--enable-agt-todo-read', 'Enable agt_todo_read (default-off)')
  .option('--disable-agt-todo-read', 'Disable agt_todo_read')
  .option('--enable-agt-todo-write', 'Enable agt_todo_write (default-off)')
  .option('--disable-agt-todo-write', 'Disable agt_todo_write')
  // ---- Configuration profiles (plan-005) ----
  .option('--profile <name>', 'Activate a named configuration profile (env: CLI_AGENT_PROFILE)')
  // ---- Composite intelligent tools (plan-006 P6 / U-FLAGS) ----
  // The 10 flags below extend `cli-agent` into a composite-tool
  // synthesiser. Defaults are chosen so that an invocation WITHOUT
  // `--treat-as-tool` is byte-identical to today's behaviour
  // (NFR-CMP-001): every flag's effective value is `false`/null until
  // `--treat-as-tool` opts the user into composite mode. The flag
  // matrix (§14.H of project-design.md) is enforced by
  // `enforceCompositeFlagMatrix` at the top of the action handler.
  //
  // NB: defaults are intentionally OMITTED from `.option(...)` calls
  // (the third arg) to keep the `cli-agent --help` byte stream
  // baseline stable — Commander appends `(default: …)` to the help
  // line whenever a default is supplied. The help-baseline test
  // (`cli-help-baseline.spec.ts`) is regenerated as part of this
  // change to capture the new flag rows.
  .option('--treat-as-tool', 'Treat this cli-agent invocation as a composite tool (synthesise a single capability doc from the --tool members)')
  .option('--composite-name <id>', 'Explicit composite id; matches /^[a-z][a-z0-9_-]{0,62}$/. Omit to derive from member list')
  .option('--emit-doc', 'Emit the composite capability doc under <agentDir>/capabilities/composite/<id>.md (default ON whenever --treat-as-tool is set)')
  .option('--no-emit-doc', 'Suppress writing the composite capability doc (synthesis still runs; output goes to stdout only)')
  .option('--emit-wrapper', 'Emit a POSIX shim under <agentDir>/composites/<id>/<id> (form b)')
  .option('--emit-wrapper-on-path', 'Additionally place a symlink at ~/.local/bin/<id> (requires --emit-wrapper)')
  .option('--register-virtual', 'Register the composite as a virtual tool — writes <agentDir>/composites/<id>/manifest.json (form c)')
  .option('--regenerate-capabilities', 'Force re-synthesis even on cache hit; preserves USER-RECIPES / USER-NOTES blocks (distinct from --refresh-capabilities — see ADR-CMP-3)')
  .option('--dry-run-synthesis', 'Print the stage prompts + digests; do NOT call the LLM and do NOT write the cache')
  .option('--synthesis-budget-tokens <n>', 'Combined Stage-1 + Stage-2 token cap for the synthesis pipeline (env CLI_AGENT_COMPOSITE_BUDGET; default 32768)', (v) => parseInt(v, 10))
  .option('--force-overwrite', 'Overwrite an existing composite of the same name without prompting')
  // Manual help registration (plan-006 P4 / NFR-CMP-001). Description
  // text mirrors Commander's auto-help wording verbatim so the
  // `--help` byte stream stays byte-identical to the captured
  // baseline. NB: the third arg (default) is intentionally omitted
  // — supplying it would make Commander append `(default: false)` to
  // the help line, drifting the byte stream. The opts read
  // `opts['help'] === undefined | true`, which the truthy check below
  // already handles correctly. The `--treat-as-tool --help`
  // composite branch is intercepted inside the action handler below.
  .option('-h, --help', 'display help for command')
  .action(async (prompt: string | undefined, opts: Record<string, unknown>) => {
    await handleErrors(async () => {
      const tools = (opts['tool'] as string[]) ?? [];

      // Composite-flag matrix enforcement (plan-006 U-FLAGS / §14.H).
      // Runs BEFORE the help branch so a forbidden flag combination
      // is reported with a uniform UsageError (exit 2) regardless of
      // whether `--help` was set. For a normal cli-agent invocation
      // (no composite flag at all) this is a fast-path no-op —
      // preserves NFR-CMP-001 byte-stability of the existing surface.
      const compositeFlags = parseCompositeFlags(opts);
      enforceCompositeFlagMatrix(compositeFlags, {
        tools,
        help: opts['help'] === true,
        resume: opts['resume'] as boolean | string | undefined,
      });

      // Help interception (plan-006 P4). The default command's `--help`
      // flag is now a manual option (NOT Commander's built-in), so the
      // composite branch can short-circuit BEFORE the agent's normal
      // prompt-handling path runs. Three cases:
      //
      //   1. `--help` + `--treat-as-tool` + at least one `--tool`
      //      → hand off to the composite synthesis pipeline.
      //   2. `--help` + `--treat-as-tool` + no `--tool`
      //      → UsageError (composite synthesis needs members).
      //   3. `--help` (no `--treat-as-tool`)
      //      → preserve Commander's normal help byte stream.
      if (opts['help']) {
        if (opts['treatAsTool']) {
          if (tools.length === 0) {
            throw new UsageError(
              'composite synthesis requires at least one --tool argument',
            );
          }
          await runComposite({ ...opts, tools, mode: 'help-synthesis' });
          return;
        }
        program.outputHelp();
        process.exit(0);
      }

      const bashAllow = opts['bashAllow']
        ? String(opts['bashAllow']).split(',').map((s: string) => s.trim())
        : undefined;
      const bashPassSecret = (opts['bashPassSecret'] as string[]) ?? [];
      const agentTools = mapAgentToolFlags(opts);

      await runAgentCommand(prompt ?? null, {
        interactive: opts['interactive'] as boolean | undefined,
        resume: opts['resume'] as boolean | string | undefined,
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
        agentTools,
        profile: opts['profile'] as string | undefined,
      });
    });
  });

/**
 * Apply the plan-006 P4 `helpOption(false)` migration to a subcommand.
 *
 * Commander v12's auto `-h, --help` is disabled and a manual `-h,
 * --help` boolean option is registered with the same description text
 * Commander would have emitted, so the subcommand's `--help` byte
 * output stays byte-identical. The action handler MUST call
 * `maybePrintSubcommandHelp(this, opts)` at the top to honour the
 * manual flag.
 */
function migrateSubcommandHelp(cmd: Command): Command {
  cmd.helpOption(false);
  // Default value intentionally omitted — see the parent program's
  // `-h, --help` registration above for the byte-stability rationale.
  cmd.option('-h, --help', 'display help for command');
  return cmd;
}

/**
 * Subcommand action prologue: when `--help` is set, print the
 * subcommand's help text and exit 0. Returns true when help was
 * handled (caller should `return` immediately) and false otherwise.
 *
 * Parent-shadowing note: because the parent `cli-agent` program also
 * defines `-h, --help` (the help-interception machinery for
 * `--treat-as-tool --help`), Commander v12 routes a bare `--help`
 * appearing AFTER a subcommand name into the PARENT's opts rather
 * than the subcommand's. We therefore consult `optsWithGlobals()` so
 * either origin triggers the help path. The same pattern is already
 * used for `--tool` shadow recovery throughout the file.
 */
function maybePrintSubcommandHelp(cmd: Command, opts: Record<string, unknown>): boolean {
  const merged = cmd.optsWithGlobals() as Record<string, unknown>;
  if (opts['help'] || merged['help']) {
    cmd.outputHelp();
    process.exit(0);
  }
  return false;
}

/* ---------- show-capabilities subcommand ---------- */
migrateSubcommandHelp(
  program
    .command('show-capabilities')
    .description('Print the cached capability document for a wrapped tool.')
    .option('--tool <name>', 'Tool name to show'),
).action(async function (this: Command, opts: { tool?: string; help?: boolean }) {
  await handleErrors(async () => {
    if (maybePrintSubcommandHelp(this, opts as Record<string, unknown>)) return;
    // Parent program also defines `--tool` (repeatable aggregator). When the
    // user types `cli-agent show-capabilities --tool foo`, Commander routes
    // the value into the parent's parsed opts, leaving `opts.tool` undefined
    // here. Recover it from the merged globals.
    const merged = this.optsWithGlobals() as Record<string, unknown>;
    const toolName = opts.tool ?? pickFirstTool(merged['tool']);
    await runShowCapabilities(toolName);
  });
});

/* ---------- refresh-capabilities subcommand ---------- */
migrateSubcommandHelp(
  program
    .command('refresh-capabilities')
    .description('Re-run capability discovery for one or all configured tools.')
    .option('--tool <name>', 'Tool to refresh (omit for all configured tools)')
    .option('-p, --provider <name>', 'LLM provider')
    .option('-m, --model <id>', 'Model ID')
    .option('--config <path>', 'Path to config.json')
    .option('--env-file <path>', 'Path to .env file'),
).action(async function (this: Command, opts: Record<string, unknown>) {
  await handleErrors(async () => {
    if (maybePrintSubcommandHelp(this, opts)) return;
    // See note in `show-capabilities`: parent's `--tool` shadows ours.
    const merged = this.optsWithGlobals();
    const toolName =
      (opts['tool'] as string | undefined) ?? pickFirstTool(merged['tool']);
    await runRefreshCapabilities(toolName, {
      provider: opts['provider'] as string | undefined,
      model: opts['model'] as string | undefined,
      configFile: opts['config'] as string | undefined,
      envFile: opts['envFile'] as string | undefined,
    });
  });
});

/* ---------- extract-recipes subcommand ---------- */
migrateSubcommandHelp(
  program
    .command('extract-recipes')
    .description('Propose canonical recipes for a wrapped tool. Default: write between the USER-RECIPES markers in the capability doc (replaces inner content). Use --stdout to print without writing, --append to keep existing recipes.')
    .option('--tool <name>', 'Tool to propose recipes for')
    .option('--max-recipes <n>', 'Maximum number of recipes (default 8, hard cap 20)', (v) => parseInt(v, 10))
    .option('--stdout', 'Print the proposal to stdout instead of writing to the capability doc', false)
    .option('--append', 'Keep any existing recipes and append the new ones instead of replacing', false)
    .option('-p, --provider <name>', 'LLM provider')
    .option('-m, --model <id>', 'Model ID')
    .option('--config <path>', 'Path to config.json')
    .option('--env-file <path>', 'Path to .env file'),
).action(async function (this: Command, opts: Record<string, unknown>) {
  await handleErrors(async () => {
    if (maybePrintSubcommandHelp(this, opts)) return;
    // Recover from parent --tool shadowing — same pattern as
    // refresh-capabilities and show-capabilities.
    const merged = this.optsWithGlobals();
    const toolName =
      (opts['tool'] as string | undefined) ?? pickFirstTool(merged['tool']);
    await runExtractRecipes(toolName, {
      maxRecipes: opts['maxRecipes'] as number | undefined,
      stdout: opts['stdout'] as boolean | undefined,
      append: opts['append'] as boolean | undefined,
      provider: opts['provider'] as string | undefined,
      model: opts['model'] as string | undefined,
      configFile: opts['config'] as string | undefined,
      envFile: opts['envFile'] as string | undefined,
    });
  });
});

/* ---------- extract-tool-prompts subcommand ---------- */
migrateSubcommandHelp(
  program
    .command('extract-tool-prompts')
    .description('Write/refresh per-tool overlay markdown files under <agentDir>/tool-prompts/.')
    .option('--force', 'Overwrite existing overlay files (default: skip)', false)
    .option('--config <path>', 'Path to config.json')
    .option('--env-file <path>', 'Path to .env file'),
).action(async function (this: Command, opts: Record<string, unknown>) {
  await handleErrors(async () => {
    if (maybePrintSubcommandHelp(this, opts)) return;
    // Recover from any parent-shadowing — parent program owns no
    // overlapping flags, but we keep the pattern consistent so future
    // additions don't regress.
    const merged = this.optsWithGlobals();
    void merged;
    await runExtractToolPrompts({
      force: opts['force'] as boolean | undefined,
      configFile: opts['config'] as string | undefined,
      envFile: opts['envFile'] as string | undefined,
    });
  });
});

/* ---------- show-tool-prompt subcommand ---------- */
migrateSubcommandHelp(
  program
    .command('show-tool-prompt')
    .description('Print the effective (overlay-merged) prompt block for a tool.')
    .option('--tool <name>', 'Tool name to show')
    .option('--config <path>', 'Path to config.json')
    .option('--env-file <path>', 'Path to .env file'),
).action(async function (this: Command, opts: Record<string, unknown>) {
  await handleErrors(async () => {
    if (maybePrintSubcommandHelp(this, opts)) return;
    // Parent program also defines `--tool` (repeatable aggregator).
    // Recover from the merged globals when our local capture is undefined.
    const merged = this.optsWithGlobals() as Record<string, unknown>;
    const toolName =
      (opts['tool'] as string | undefined) ?? pickFirstTool(merged['tool']);
    await runShowToolPrompt(toolName, {
      configFile: opts['config'] as string | undefined,
      envFile: opts['envFile'] as string | undefined,
    });
  });
});

/* ---------- audit-tool-prompts subcommand ---------- */
migrateSubcommandHelp(
  program
    .command('audit-tool-prompts')
    .description('Cross-check overlay files against the current built-in registry.')
    .option('--strict', 'Exit non-zero on any drift warning', false)
    .option('--config <path>', 'Path to config.json')
    .option('--env-file <path>', 'Path to .env file'),
).action(async function (this: Command, opts: Record<string, unknown>) {
  await handleErrors(async () => {
    if (maybePrintSubcommandHelp(this, opts)) return;
    await runAuditToolPrompts({
      strict: opts['strict'] as boolean | undefined,
      configFile: opts['config'] as string | undefined,
      envFile: opts['envFile'] as string | undefined,
    });
  });
});

/* ---------- Configuration profile subcommands (plan-005 P5 stubs) ----------
 *
 * These stub registrations make `cli-agent --help` advertise the surface
 * and reserve the wiring; the U-CLI parallel coder fills the handlers in
 * P6. Each stub throws a "not implemented" error so a user who tries them
 * before P6 is complete sees a clear message.
 */
migrateSubcommandHelp(
  program
    .command('profile-list')
    .alias('profiles')
    .description('List configuration profiles (FR-PROF-008).')
    .option('--json', 'Emit machine-readable JSON output', false),
).action(async function (this: Command, opts: Record<string, unknown>) {
  await handleErrors(async () => {
    if (maybePrintSubcommandHelp(this, opts)) return;
    await runProfileList({ json: opts['json'] as boolean | undefined });
  });
});

migrateSubcommandHelp(
  program
    .command('profile-show <name>')
    .description('Print a configuration profile (raw + parsed) (FR-PROF-009).')
    .option('--json', 'Emit machine-readable JSON output', false),
).action(async function (this: Command, name: string, opts: Record<string, unknown>) {
  await handleErrors(async () => {
    if (maybePrintSubcommandHelp(this, opts)) return;
    await runProfileShow(name, { json: opts['json'] as boolean | undefined });
  });
});

migrateSubcommandHelp(
  program
    .command('profile-create <name>')
    .description('Scaffold a new configuration profile (FR-PROF-010).')
    .option('--from-current', 'Capture the current resolved config', false)
    .option('--description <text>', 'Description for the new profile')
    .option('--force', 'Overwrite an existing profile', false),
).action(async function (this: Command, name: string, opts: Record<string, unknown>) {
  await handleErrors(async () => {
    if (maybePrintSubcommandHelp(this, opts)) return;
    await runProfileCreate(name, {
      fromCurrent: opts['fromCurrent'] as boolean | undefined,
      description: opts['description'] as string | undefined,
      force: opts['force'] as boolean | undefined,
    });
  });
});

// `profile-edit` is the only subcommand with NO `.option(...)` calls
// of its own. Adding a manual `-h, --help` option here would force
// Commander to start emitting `[options]` in this command's usage
// line (drifting the parent `cli-agent --help` byte stream — a
// regression of NFR-CMP-001). Commander's auto-help is correct for
// this command (it has no composite implication), so we deliberately
// skip the migration here. The plan-006 forward-looking driver for
// migrating subcommands is the future composite-* subcommands
// (U-CMD), which all have their own options and therefore already
// show `[options]`; profile-edit is exempted as documented in P4.
program
  .command('profile-edit <name>')
  .description('Open a configuration profile in $EDITOR (FR-PROF-011).')
  .action(async (name: string) => {
    await handleErrors(async () => {
      await runProfileEdit(name);
    });
  });

migrateSubcommandHelp(
  program
    .command('profile-delete <name>')
    .alias('profile-rm')
    .description('Delete a configuration profile (FR-PROF-012).')
    .option('--yes', 'Skip the confirmation prompt', false),
).action(async function (this: Command, name: string, opts: Record<string, unknown>) {
  await handleErrors(async () => {
    if (maybePrintSubcommandHelp(this, opts)) return;
    await runProfileDelete(name, { yes: opts['yes'] as boolean | undefined });
  });
});

migrateSubcommandHelp(
  program
    .command('profile-dry-run')
    .description('Resolve config + tool scoping; print effective state without launching the LLM (FR-PROF-013).')
    .option('--profile <name>', 'Activate a named configuration profile')
    .option('--json', 'Emit machine-readable JSON output', false),
).action(async function (this: Command, opts: Record<string, unknown>) {
  await handleErrors(async () => {
    if (maybePrintSubcommandHelp(this, opts)) return;
    // Parent program also registers `--profile <name>` (for the default
    // agent command); recover the subcommand value by checking globals
    // when the local capture is undefined.
    const merged = this.optsWithGlobals() as Record<string, unknown>;
    const profile =
      (opts['profile'] as string | undefined) ??
      (merged['profile'] as string | undefined);
    await runProfileDryRun({
      profile,
      json: opts['json'] as boolean | undefined,
    });
  });
});

/* ---------- Composite intelligent tool subcommands (plan-006 P6 / U-CMD) ----------
 *
 * Sibling subcommands to the flag-driven `--treat-as-tool --help` path
 * (§14.E / FR-CMP-022). All four use the helpOption(false) +
 * manual `-h, --help` pattern (NFR-CMP-001) so subcommand `--help`
 * produces a byte-stable output.
 *
 * The parent program also registers `--tool <name>` (repeatable
 * aggregator). When the user types `cli-agent composite-synthesize
 * --tool A`, Commander routes the value into the parent's parsed opts;
 * we consult `optsWithGlobals()` to recover.
 */

migrateSubcommandHelp(
  program
    .command('composite-synthesize')
    .description('Synthesize a composite intelligent tool from --tool members (plan-006 §14.E).')
    .option('--tool <name>', 'Member tool to include in the composite (repeatable)', collectTool, [] as string[])
    .option('--composite-name <id>', 'Explicit composite id (default: derived from --tool members)')
    .option('--emit-doc', 'Emit the schema-3 capability doc (default ON)')
    .option('--no-emit-doc', 'Suppress the schema-3 capability doc emission')
    .option('--emit-wrapper', 'Emit a POSIX shim under <agentDir>/composites/<id>/<id>')
    .option('--emit-wrapper-on-path', 'Additionally place a symlink at ~/.local/bin/<id>')
    .option('--register-virtual', 'Register the composite as a virtual tool (manifest.json)')
    .option('--regenerate-capabilities', 'Force re-synthesis even on cache hit (preserves USER blocks)')
    .option('--dry-run-synthesis', 'Print stage prompts + digests; do NOT call the LLM')
    .option('--synthesis-budget-tokens <n>', 'Combined Stage-1 + Stage-2 token cap (env: CLI_AGENT_COMPOSITE_BUDGET; default 32768)', (v) => parseInt(v, 10))
    .option('--force-overwrite', 'Overwrite an existing composite of the same name without prompting'),
).action(async function (this: Command, opts: Record<string, unknown>) {
  await handleErrors(async () => {
    if (maybePrintSubcommandHelp(this, opts)) return;
    // The U-FLAGS catch-all (§14.H) requires --treat-as-tool for every
    // composite knob in the default command's flag namespace. The
    // sibling subcommand path is the explicit composite invocation —
    // the matrix is enforced INSIDE handleSynthesize on a freshly
    // assembled `opts` object that always sets `treatAsTool: true`.
    const merged = this.optsWithGlobals() as Record<string, unknown>;
    const localTools = (opts['tool'] as string[] | undefined) ?? [];
    const parentTools = Array.isArray(merged['tool'])
      ? (merged['tool'] as string[])
      : [];
    const tools = localTools.length > 0 ? localTools : parentTools;
    // Synthesise a composite-flag opts object with treatAsTool=true so
    // `parseCompositeFlags` + `enforceCompositeFlagMatrix` see the
    // explicit composite intent.
    const compositeOpts = {
      ...opts,
      treatAsTool: true,
    };
    await handleSynthesize({
      mode: 'synthesize-cmd',
      tools,
      rawOpts: compositeOpts,
    });
  });
});

migrateSubcommandHelp(
  program
    .command('composite-list')
    .alias('composites')
    .description('List synthesised composite intelligent tools (plan-006 §14.E).')
    .option('--json', 'Emit machine-readable JSON output', false),
).action(async function (this: Command, opts: Record<string, unknown>) {
  await handleErrors(async () => {
    if (maybePrintSubcommandHelp(this, opts)) return;
    await runCompositeList({ json: opts['json'] as boolean | undefined });
  });
});

migrateSubcommandHelp(
  program
    .command('composite-show <name>')
    .description('Print a synthesised composite capability doc (plan-006 §14.E).')
    .option('--json', 'Emit machine-readable JSON output', false),
).action(async function (this: Command, name: string, opts: Record<string, unknown>) {
  await handleErrors(async () => {
    if (maybePrintSubcommandHelp(this, opts)) return;
    await runCompositeShow(name, { json: opts['json'] as boolean | undefined });
  });
});

migrateSubcommandHelp(
  program
    .command('composite-delete <name>')
    .alias('composite-rm')
    .description('Delete a synthesised composite and all of its artefacts (plan-006 §14.E).')
    .option('--yes', 'Skip the confirmation prompt', false),
).action(async function (this: Command, name: string, opts: Record<string, unknown>) {
  await handleErrors(async () => {
    if (maybePrintSubcommandHelp(this, opts)) return;
    await runCompositeDelete(name, { yes: opts['yes'] as boolean | undefined });
  });
});

/**
 * Parent's `--tool` is registered with `collectTool`, so its value is a
 * `string[]`. Subcommands that expect a single tool name should take the
 * first element when falling back to the parent's value.
 */
function pickFirstTool(v: unknown): string | undefined {
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') return v[0];
  if (typeof v === 'string' && v.length > 0) return v;
  return undefined;
}

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

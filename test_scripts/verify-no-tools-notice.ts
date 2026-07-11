/**
 * E2E verification for the toolless-session fabrication guard.
 *
 * Reproduces `cli-agent --mode chat` (plan-015; formerly the three
 * `--no-*` group toggles): loads a real resolved config with every tool
 * group disabled, assembles the
 * tool catalog (expected: zero tools) and the system prompt EXACTLY as
 * run.ts does, then asserts the prompt now carries the no-tools /
 * anti-fabrication notice (so the model cannot hallucinate command output).
 *
 * Run: npx tsx test_scripts/verify-no-tools-notice.ts
 */

import { loadAgentConfig } from '../src/config/agent-config.js';
import { buildToolCatalog } from '../src/agent/tools/registry.js';
import { buildSystemPromptForCfg } from '../src/agent/system-prompt.js';
import type { Logger } from '../src/agent/logging.js';

const nullLogger: Logger = {
  log: () => undefined,
  flush: async () => undefined,
  close: async () => undefined,
  get currentLogPath() { return ''; },
  get currentSessionId() { return 'verify'; },
};

async function main(): Promise<void> {
  // Mirror the user's flags: --mode chat disables all three tool groups
  // (plan-015; formerly builtinTools/composites/agentTools.enabled=false).
  const cfg = await loadAgentConfig(
    {
      provider: 'openai',
      mode: 'chat',
    },
    { shellEnv: { OPENAI_API_KEY: 'sk-verify-placeholder' }, cwd: process.cwd() },
  );

  const { tools, agentToolsMeta } = buildToolCatalog(cfg, nullLogger);
  const prompt = await buildSystemPromptForCfg(cfg, '', agentToolsMeta, tools);

  const toolCount = tools.length;
  const hasNotice = prompt.includes('No tools are enabled');
  const forbidsFabrication = prompt.includes('NEVER fabricate');

  process.stdout.write(`registered tools: ${toolCount}\n`);
  process.stdout.write(`prompt has no-tools notice: ${hasNotice}\n`);
  process.stdout.write(`prompt forbids fabrication: ${forbidsFabrication}\n`);

  const ok = toolCount === 0 && hasNotice && forbidsFabrication;
  if (!ok) {
    process.stdout.write('\nRESULT: FAIL — toolless session lacks the anti-fabrication notice\n');
    process.exit(1);
  }
  process.stdout.write('\nRESULT: PASS — toolless session is told it has no tools and must not fabricate\n');
  // Show the injected block for eyeballing.
  const start = prompt.indexOf('## No tools are available');
  process.stdout.write('\n--- injected block ---\n' + prompt.slice(start) + '\n');
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + '\n');
  process.exit(1);
});

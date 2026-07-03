/**
 * TUI smoke test: drive startTui with a fake stdin (PassThrough with isTTY=true)
 * and a fake stdout. Send /help then /quit; assert the banner + help output appear.
 *
 * Run with: npx tsx test_scripts/smoke-tui-banner-and-quit.ts
 *
 * Note: /quit calls process.exit(0) so we trap that to keep the test under control.
 */

import { PassThrough } from 'node:stream';

// Trap process.exit
const originalExit = process.exit;
let exited = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process as any).exit = (code?: number): never => {
  exited = true;
  console.log(`[trapped process.exit(${code ?? 0})]`);
  throw new Error('exit-trapped');
};

import { startTui } from '../src/tui/index.js';
import type { AgentConfig } from '../src/config/agent-config.js';

const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
Object.defineProperty(stdin, 'isTTY', { value: true });
(stdin as unknown as { setRawMode: (b: boolean) => void }).setRawMode = () => {};

const captured: string[] = [];
const stdout = new PassThrough();
stdout.on('data', (b: Buffer) => captured.push(b.toString('utf8')));
Object.defineProperty(stdout, 'isTTY', { value: true });

const stderr = new PassThrough();

// Build a minimal cfg — we won't actually run a turn, just /help and /quit.
const cfg: AgentConfig = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  maxSteps: 5,
  temperature: 0,
  allowMutations: false,
  verbose: false,
  agentDir: '/tmp/x',
  capabilitiesDir: '/tmp/x/cap',
  logsDir: '/tmp/x/logs',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  providerEnv: { OPENAI_API_KEY: 'test' } as any,
  tools: [],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  capabilities: { depth: 2, maxBytesPerTool: 1000, timeoutMs: 1000, totalTimeoutMs: 1000, subcommandExtractor: '' } as any,
  bash: { allow: [], allowedRoots: ['/tmp'], passEnv: ['PATH'], timeoutMs: 1000, maxOutputBytes: 1000 },
  webSearch: { backend: 'tavily', maxRequests: 50 },
  fileEdit: { root: '/tmp', allowPaths: [] },
  perToolBudgetBytes: 1000,
  baseUrl: undefined,
  webSearchBackend: 'tavily',
  bashAllow: [],
  bashPassSecrets: [],
};

const startPromise = startTui(cfg, {
  stdin,
  stdout: stdout as unknown as NodeJS.WriteStream,
  stderr: stderr as unknown as NodeJS.WriteStream,
}).catch((e) => {
  if ((e as Error).message !== 'exit-trapped') {
    console.error('startTui error:', e);
  }
});

// After a tick, send /help <CR> then /quit <CR>. Note: Enter in raw mode
// is byte 0x0D (\r), not \n; \n (0x0A) is Ctrl+J = insert-newline.
setTimeout(() => {
  stdin.emit('data', Buffer.concat([Buffer.from('/help', 'utf8'), Buffer.from([0x0d])]));
}, 200);
setTimeout(() => {
  stdin.emit('data', Buffer.concat([Buffer.from('/quit', 'utf8'), Buffer.from([0x0d])]));
}, 800);

setTimeout(() => {
  process.exit = originalExit;
  const all = captured.join('');
  // Check banner
  const banner = all.includes('cli-agent TUI');
  const helpListed = all.includes('/help') && all.includes('/quit');
  const goodbye = all.includes('goodbye');
  console.log(`banner-present: ${banner}`);
  console.log(`help-listed:    ${helpListed}`);
  console.log(`goodbye:        ${goodbye}`);
  console.log(`exited-trapped: ${exited}`);
  if (banner && helpListed && exited) {
    console.log('PASS');
    process.exit(0);
  } else {
    console.log('FAIL');
    console.log('---captured---');
    console.log(all.slice(0, 4000));
    process.exit(1);
  }
}, 1500);

// keep alive
void startPromise;

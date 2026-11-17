import { stat } from 'node:fs/promises';
import * as path from 'node:path';

import { DEFAULT_SSH_CONNECTION } from '../src/shared/ssh/SSHConnection';
import { buildSSHCommand } from '../src/shared/ssh/SSHConnection';
import { createSSHSpawn } from '../src/shared/ssh/SSHRuntime';
import { BridgeEngines } from './BridgeEngines';
import { createBridgeServer } from './BridgeServer';
import { ClaudeEngine } from './ClaudeEngine';
import { CodexEngine } from './CodexEngine';
import { SessionRepository } from './SessionRepository';

async function main(): Promise<void> {
  if (typeof window === 'undefined') Object.defineProperty(globalThis, 'window', { value: { setTimeout, clearTimeout } });
  const token = process.env.NERODIAN_TOKEN;
  const workspace = process.env.NERODIAN_WORKSPACE;
  const port = Number(process.env.NERODIAN_PORT ?? '17868');
  if (!token || token.length < 32 || token.startsWith('replace-')) throw new TypeError('Set NERODIAN_TOKEN to a random token of at least 32 characters');
  if (!workspace || !path.isAbsolute(workspace) || !(await stat(workspace)).isDirectory()) throw new TypeError('Set NERODIAN_WORKSPACE to the absolute server workspace path');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('Invalid NERODIAN_PORT');
  const cli = process.env.NERODIAN_CLAUDE_PATH ?? 'claude';
  const ssh = process.env.NERODIAN_SSH_HOST;
  const connection = {
    ...DEFAULT_SSH_CONNECTION, enabled: true, host: ssh ?? '',
    port: Number(process.env.NERODIAN_SSH_PORT ?? '22'),
    remoteDirectory: process.env.NERODIAN_SSH_WORKSPACE ?? workspace,
    cliPath: cli, identityFile: process.env.NERODIAN_SSH_KEY ?? '',
  };
  const repository = new SessionRepository(process.env.NERODIAN_DATA_DIR ?? path.join(workspace, '.kk-nerodian', 'bridge'));
  await repository.load();
  const claude = new ClaudeEngine(repository, {
    cwd: ssh ? connection.remoteDirectory : workspace,
    pathToClaudeCodeExecutable: cli,
    ...(ssh ? { spawnClaudeCodeProcess: createSSHSpawn(connection, '') } : {}),
  });
  const codexPath = process.env.NERODIAN_CODEX_PATH ?? 'codex';
  const codexArgs = ['app-server', '--listen', 'stdio://'];
  const codexLaunch = ssh ? buildSSHCommand({ ...connection, cliPath: codexPath }, { command: codexPath, args: codexArgs, environment: {} }) : { command: codexPath, args: codexArgs };
  const codex = new CodexEngine(repository, {
    ...codexLaunch, spawnCwd: workspace, workspace: ssh ? connection.remoteDirectory : workspace,
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  });
  const engine = new BridgeEngines(repository, claude, codex);
  const server = createBridgeServer(repository, engine, token);
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`KK-Nerodian bridge listening on 127.0.0.1:${port}\n`);
  });
  const shutdown = (): void => { engine.stopAll(); server.close(); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

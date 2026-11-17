import { spawn } from 'node:child_process';
import { clearTimeout, setTimeout } from 'node:timers';

import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

import { parseEnvironmentVariables } from '@/core/process/env';
import type { CLIInstallation } from '@/core/providers/cli/CLIInstallationProbe';
import { parseCLIVersion } from '@/core/providers/cli/CLIInstallationProbe';

import { buildSSHCommand, type SSHConnection, SSHConnectionError } from './SSHConnection';

export function createSSHSpawn(connection: SSHConnection, environmentText: string): (options: SpawnOptions) => SpawnedProcess {
  return options => {
    const environment = {
      ...Object.fromEntries(Object.entries(options.env).filter(([key]) => /^(?:CLAUDE_AGENT_SDK_|CLAUDE_CODE_ENTRYPOINT$|MCP_TIMEOUT$)/u.test(key))),
      ...parseEnvironmentVariables(environmentText),
    };
    const spec = buildSSHCommand(connection, { command: connection.cliPath, args: options.args, environment });
    const child = spawn(spec.command, spec.args, { stdio: 'pipe', windowsHide: true });
    const abort = (): void => { child.kill('SIGTERM'); };
    if (options.signal.aborted) abort();
    else options.signal.addEventListener('abort', abort, { once: true });
    child.once('close', () => options.signal.removeEventListener('abort', abort));
    child.stderr.on('data', () => undefined);
    return child;
  };
}

export async function runSSHCommand(connection: SSHConnection, invocation: Parameters<typeof buildSSHCommand>[1]): Promise<string> {
  const spec = buildSSHCommand(connection, invocation);
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new SSHConnectionError('SSH request timed out')); }, 30_000);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) {
        child.kill();
        reject(new SSHConnectionError('Remote history exceeds the 64 MiB transfer limit'));
      } else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4096); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
      else reject(new SSHConnectionError(stderr.trim() || `SSH exited with code ${code}`));
    });
  });
}

export async function inspectSSHInstallation(connection: SSHConnection, environmentText: string): Promise<CLIInstallation> {
  const output = await runSSHCommand(connection, {
    command: connection.cliPath, args: ['--version'], environment: parseEnvironmentVariables(environmentText),
  });
  return { path: connection.cliPath, source: 'custom', version: parseCLIVersion(output) };
}

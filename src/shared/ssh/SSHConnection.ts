import { getInstallationKey } from '@/core/device/InstallationKey';

export type SSHConnection = {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly identityFile: string;
  readonly remoteDirectory: string;
  readonly cliPath: string;
  readonly executable: string;
};

export const DEFAULT_SSH_CONNECTION: SSHConnection = {
  enabled: false, host: '', port: 22, identityFile: '', remoteDirectory: '', cliPath: 'claude', executable: 'ssh',
};

export class SSHConnectionError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'SSHConnectionError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readSSHConnection(config: Readonly<Record<string, unknown>>, command = 'claude'): SSHConnection {
  const connections = config.sshConnectionsByHost;
  const stored = isRecord(connections) ? connections[getInstallationKey()] : undefined;
  if (stored === undefined) return { ...DEFAULT_SSH_CONNECTION, cliPath: command };
  return parseSSHConnection(stored, command);
}

export function parseSSHConnection(stored: unknown, command = 'claude'): SSHConnection {
  if (!isRecord(stored) || typeof stored.enabled !== 'boolean') throw new SSHConnectionError('Invalid stored SSH connection');
  const read = (key: string, fallback: string): string => {
    const value = stored[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || value.includes('\0')) throw new SSHConnectionError(`Invalid SSH field: ${key}`);
    return value;
  };
  const port = stored.port ?? 22;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new SSHConnectionError('Invalid SSH port');
  return {
    enabled: stored.enabled, host: read('host', ''), port, identityFile: read('identityFile', ''),
    remoteDirectory: read('remoteDirectory', ''), cliPath: read('cliPath', command), executable: read('executable', 'ssh'),
  };
}

export function updateSSHConnection(config: Record<string, unknown>, updates: Partial<SSHConnection>): void {
  config.sshConnectionsByHost = {
    ...(isRecord(config.sshConnectionsByHost) ? config.sshConnectionsByHost : {}),
    [getInstallationKey()]: { ...readSSHConnection(config), ...updates },
  };
}

export function quoteSSHArgument(value: string): string {
  if (value.includes('\0')) throw new SSHConnectionError('SSH arguments cannot contain NUL');
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

export type SSHInvocation = {
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
};

export function buildSSHCommand(connection: SSHConnection, invocation: SSHInvocation): { command: string; args: string[] } {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@:[\]-]*$/u.test(connection.host)) throw new SSHConnectionError('Set a valid SSH host or user@host');
  if (!connection.remoteDirectory.startsWith('/')) throw new SSHConnectionError('Set an absolute remote workspace path');
  if (!connection.executable.trim() || !connection.cliPath.trim()) throw new SSHConnectionError('Set the SSH and remote Claude executables');
  const environment = Object.entries(invocation.environment).map(([key, value]) => {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(key)) throw new SSHConnectionError(`Invalid environment name: ${key}`);
    return value === undefined ? [] : [`${key}=${value}`];
  }).flat();
  const script = 'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:$PATH"; cd "$1" || exit; shift; exec env "$@"';
  const remote = ['/bin/sh', '-c', script, 'kk-nerodian', connection.remoteDirectory, ...environment, invocation.command, ...invocation.args]
    .map(quoteSSHArgument).join(' ');
  return {
    command: connection.executable,
    args: ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-p', String(connection.port),
      ...(connection.identityFile ? ['-i', connection.identityFile] : []), '--', connection.host, remote],
  };
}

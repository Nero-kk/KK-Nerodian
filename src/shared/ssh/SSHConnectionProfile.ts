import { buildSSHCommand, parseSSHConnection, type SSHConnection, SSHConnectionError } from './SSHConnection';

export const SSH_PROFILE_LIMIT = 128 * 1024;
export const HERMES_ENVIRONMENT_FILE = 'kk-hermes-environment.private.json';
type SSHProvider = 'claude' | 'codex';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new SSHConnectionError('Invalid connection profile');
  return value;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0')) throw new SSHConnectionError('Invalid connection field');
  return value.trim();
}

export function importSSHProfile(contents: string, provider: SSHProvider, current: SSHConnection): SSHConnection {
  if (new TextEncoder().encode(contents).byteLength > SSH_PROFILE_LIMIT) throw new SSHConnectionError('Connection profile exceeds 128 KiB');
  let value: unknown;
  try { value = JSON.parse(contents.replace(/^\uFEFF/u, '')); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new SSHConnectionError('Invalid connection JSON');
  }
  const profile = record(value);
  if (profile.version !== 1) throw new SSHConnectionError('Unsupported connection profile version');
  switch (profile.format) {
    case 'kk-nerodian/ssh':
      if (profile.provider !== provider) throw new SSHConnectionError(`Import this profile in the ${text(profile.provider)} provider tab`);
      return parseSSHConnection(profile.connection, provider);
    case 'kk-hermes-connect/environment': {
      const environment = record(profile.environment);
      const address = text(environment.tailscaleIp);
      const user = text(environment.ubuntuUser);
      const pluginPath = text(environment.ubuntuPluginPath);
      const marker = pluginPath.lastIndexOf('/plugins/');
      const configPath = pluginPath.slice(0, marker);
      if (!address || !user || marker < 1 || !configPath.includes('/')) throw new SSHConnectionError('Hermes profile needs a Tailscale address, Ubuntu user and absolute vault plugin path');
      const remoteDirectory = configPath.slice(0, configPath.lastIndexOf('/')) || '/';
      const host = `${user}@${address.includes(':') && !address.startsWith('[') ? `[${address}]` : address}`;
      const connection = { ...current, enabled: false, host, remoteDirectory, cliPath: provider };
      buildSSHCommand(connection, { command: provider, args: ['--version'], environment: {} });
      return connection;
    }
    default: throw new SSHConnectionError('Unsupported connection profile format');
  }
}

export function exportSSHProfile(provider: SSHProvider, connection: SSHConnection): string {
  return JSON.stringify({ format: 'kk-nerodian/ssh', version: 1, provider, connection: parseSSHConnection(connection, provider) }, null, 2) + '\n';
}

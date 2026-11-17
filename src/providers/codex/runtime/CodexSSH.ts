import { parseEnvironmentVariables } from '@/core/process/env';
import type { ExecutionTarget, TargetLaunchSpec } from '@/core/process/execution-target/types';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';
import { buildSSHCommand, readSSHConnection } from '@/shared/ssh/SSHConnection';

export const CODEX_SSH_TARGET: ExecutionTarget = { method: 'host-native', platformFamily: 'unix', platformOs: 'linux' };

export function resolveCodexSSHLaunch(host: ProviderRuntimeHost): TargetLaunchSpec | null {
  const connection = readSSHConnection(host.config, 'codex');
  if (!connection.enabled) return null;
  const verbosity = host.config.responseVerbosity;
  const args = ['app-server', '--listen', 'stdio://',
    ...(typeof verbosity === 'string' && verbosity !== 'default' ? ['-c', `model_verbosity=${JSON.stringify(verbosity)}`] : [])];
  const command = buildSSHCommand(connection, { command: connection.cliPath, args, environment: parseEnvironmentVariables(host.environmentText) });
  return {
    ...command, target: CODEX_SSH_TARGET, targetCwd: connection.remoteDirectory,
    spawnCwd: host.workingDirectory ?? process.cwd(), env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    pathMapper: {
      target: CODEX_SSH_TARGET,
      toTargetPath: value => value,
      toHostPath: value => value,
      mapTargetPathList: values => [...values],
      canRepresentHostPath: () => true,
    },
  };
}

import { resolveExecutionTargetAsync } from '@/core/process/execution-target/ExecutionTargetResolver';
import { probeTargetCLIInstallation } from '@/core/providers/cli/TargetCLIInstallationProbe';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';
import { readSSHConnection } from '@/shared/ssh/SSHConnection';
import { inspectSSHInstallation } from '@/shared/ssh/SSHRuntime';

import { decodeClaudeConfig } from '../config';
import { getClaudeWSLForwardedEnvironment } from './claudeWSLEnvironment';
import { buildClaudeLaunchOptions } from './probeClaudeRuntime';

export async function inspectClaudeInstallation(host: ProviderRuntimeHost) {
  const ssh = readSSHConnection(host.config);
  if (ssh.enabled) return inspectSSHInstallation(ssh, host.environmentText);
  const config = decodeClaudeConfig(host.config);
  const hostCwd = host.workingDirectory ?? process.cwd();
  const target = await resolveExecutionTargetAsync({ settings: config, hostVaultPath: hostCwd });
  const command = await host.resolveCliPath({ executionTarget: target });
  const { env } = buildClaudeLaunchOptions(host, hostCwd, command ?? 'claude', { executionTarget: target });
  const environment = env as Record<string, string>;
  return probeTargetCLIInstallation({
    target, hostCwd, command, args: ['--version'], env: environment,
    configuredPath: config.cliPathsByHost[host.storage.installationKey] || config.cliPath,
    forwardEnvironment: getClaudeWSLForwardedEnvironment(environment, host.environmentText),
  });
}

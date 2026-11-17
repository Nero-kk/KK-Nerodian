import { resolveExecutionTargetAsync } from '@/core/process/execution-target/ExecutionTargetResolver';
import { CachedProviderCLIResolver } from '@/core/providers/cli/CachedProviderCLIResolver';
import { getProviderConfig } from '@/core/providers/providerConfig';
import { getRuntimeEnvironmentText } from '@/core/providers/providerEnvironment';
import type { ProviderCLIResolutionContext } from '@/core/providers/types';
import { readSSHConnection } from '@/shared/ssh/SSHConnection';

import { getCodexProviderSettings } from '../settings';
import { findCodexBinaryPath, resolveCodexWSLCLIPath } from './CodexBinaryLocator';

export class CodexCLIResolver {
  private readonly resolver = new CachedProviderCLIResolver({
    binaryName: 'codex',
    findBinaryPath: findCodexBinaryPath,
    getSettingsProjection: (settings) => {
      const providerSettings = getCodexProviderSettings(settings);
      return {
        cliPathsByHost: providerSettings.cliPathsByHost,
        environmentText: getRuntimeEnvironmentText(settings, 'codex'),
        legacyCliPath: providerSettings.cliPath,
      };
    },
    providerId: 'codex',
    resolve: (context, resolveDefault) => context.resolutionInputs?.method === 'wsl'
      ? resolveCodexWSLCLIPath(context.hostnamePath, context.legacyCliPath)
      : resolveDefault(),
    // Native Windows runtimes can move without a settings change; retry missing installs too.
    shouldCache: (result, context) => result !== null && context.resolutionInputs?.method !== 'native-windows',
  });

  resolveFromSettings(
    settings: Record<string, unknown>,
    context: ProviderCLIResolutionContext = {},
  ): string | null | Promise<string | null> {
    const ssh = readSSHConnection(getProviderConfig(settings, 'codex'), 'codex');
    if (ssh.enabled) return ssh.cliPath;
    const executionTarget = context.executionTarget;
    if (executionTarget) {
      return this.resolver.resolveFromSettings(settings, { ...executionTarget });
    }

    return resolveExecutionTargetAsync({ settings: getCodexProviderSettings(settings) }).then((resolvedTarget) => (
      this.resolver.resolveFromSettings(settings, { ...resolvedTarget })
    ));
  }

  reset(): void {
    this.resolver.reset();
  }
}

import { resolveExecutionTargetAsync } from '@/core/process/execution-target/ExecutionTargetResolver';
import type { ExecutionTarget } from '@/core/process/execution-target/types';
import { readSSHConnection } from '@/shared/ssh/SSHConnection';

import { decodeClaudeConfig } from '../config';

export const SSH_EXECUTION_TARGET: ExecutionTarget = { method: 'host-native', platformFamily: 'unix', platformOs: 'linux' };

export async function resolveClaudeExecutionTarget(config: Readonly<Record<string, unknown>>, workingDirectory: string): Promise<ExecutionTarget> {
  return readSSHConnection(config).enabled ? SSH_EXECUTION_TARGET
    : resolveExecutionTargetAsync({ settings: decodeClaudeConfig(config), hostVaultPath: workingDirectory });
}

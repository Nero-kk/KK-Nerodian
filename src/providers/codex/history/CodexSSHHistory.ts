import { createHash } from 'node:crypto';

import { parseEnvironmentVariables } from '@/core/process/env';
import type { ProviderHistoryInput, ProviderHistoryPathContext } from '@/core/providers/types';
import { readSSHConnection } from '@/shared/ssh/SSHConnection';
import { writeSSHFileSnapshot } from '@/shared/ssh/SSHFileSnapshot';
import { runSSHCommand } from '@/shared/ssh/SSHRuntime';

import { getCodexState } from '../types';
import type { CodexHistoryPathContext } from './CodexHistoryPathResolver';

export function getCodexSSHThreadIds(conversation: ProviderHistoryInput): readonly string[] {
  const state = getCodexState(conversation.providerState);
  return [state.threadId, conversation.sessionId, state.forkSource?.sessionId,
    ...state.previousSegments?.flatMap(segment => [segment.threadId, segment.forkSource?.sessionId]) ?? []]
    .filter((id): id is string => typeof id === 'string');
}

export async function resolveCodexSSHHistory(context: ProviderHistoryPathContext, threadIds: readonly string[]): Promise<CodexHistoryPathContext> {
  const connection = readSSHConnection(context.config, 'codex');
  const ids = [...new Set(threadIds)].filter(id => /^[a-zA-Z0-9-]{1,128}$/u.test(id));
  const script = 'cd "${CODEX_HOME:-$HOME/.codex}" || exit; for id do for root in sessions archived_sessions; do '
    + '[ -d "$root" ] || continue; find "./$root" -type f -name "*$id*.jsonl" -exec /bin/sh -c '
    + '\'for file do printf "%s\\0" "$file"; base64 < "$file" | tr -d "\\r\\n"; printf "\\0"; done\' sh {} +; done; done';
  const output = ids.length ? await runSSHCommand(connection, {
    command: '/bin/sh', args: ['-c', script, 'nerodian-codex-history', ...ids],
    environment: parseEnvironmentVariables(context.environmentText),
  }) : '';
  const namespace = createHash('sha256').update(JSON.stringify([connection, ids])).digest('hex');
  const directory = await writeSSHFileSnapshot(output, { namespace, prefix: [] });
  return {
    environment: { ...context.environment, CODEX_HOME: directory, HOME: directory, USERPROFILE: directory },
    hostPlatform: context.hostPlatform, vaultPath: context.vaultPath,
    installation: { installationMethod: 'native-windows', wslDistroOverride: '' },
  };
}

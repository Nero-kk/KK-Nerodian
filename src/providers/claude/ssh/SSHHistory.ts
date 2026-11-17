import { createHash } from 'node:crypto';

import { parseEnvironmentVariables } from '@/core/process/env';
import { readSSHConnection } from '@/shared/ssh/SSHConnection';
import { writeSSHFileSnapshot } from '@/shared/ssh/SSHFileSnapshot';
import { runSSHCommand } from '@/shared/ssh/SSHRuntime';

import type { ClaudeConfigDirContext } from '../config/ClaudeConfigDir';
import { encodeVaultPathForSDK } from '../history/ClaudeHistoryPathResolver';

const pending = new Map<string, Promise<ClaudeConfigDirContext>>();

export async function resolveSSHHistory(context: ClaudeConfigDirContext, vaultPath: string): Promise<ClaudeConfigDirContext> {
  const connection = readSSHConnection(context.config ?? {});
  const environment = parseEnvironmentVariables(context.environmentText ?? '');
  const key = createHash('sha256').update(JSON.stringify([connection, environment])).digest('hex');
  const active = pending.get(key);
  if (active) return active;
  const fetch = async (): Promise<ClaudeConfigDirContext> => {
    const project = encodeVaultPathForSDK(vaultPath, context);
    const script = 'root="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$1"; '
      + 'if [ ! -d "$root" ]; then exit 0; fi; cd "$root" || exit; '
      + 'find . -type f \\( -name "*.jsonl" -o -name "*.meta.json" \\) -exec /bin/sh -c '
      + '\'for file do printf "%s\\0" "$file"; base64 < "$file" | tr -d "\\r\\n"; printf "\\0"; done\' sh {} +';
    const output = await runSSHCommand(connection, { command: '/bin/sh', args: ['-c', script, 'nerodian-history', project], environment });
    const directory = await writeSSHFileSnapshot(output, { namespace: key, prefix: ['projects', project] });
    return { ...context, vaultPath, sshCacheDirectory: directory, targetEnvironmentResolved: true };
  };
  const result = fetch();
  pending.set(key, result);
  try { return await result; }
  finally { pending.delete(key); }
}

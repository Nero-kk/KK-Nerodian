// @test-ci {"native":true}
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { buildSSHCommand, DEFAULT_SSH_CONNECTION, SSHConnectionError } from '@/shared/ssh/SSHConnection';
import { writeSSHFileSnapshot } from '@/shared/ssh/SSHFileSnapshot';

const execute = promisify(execFile);

describe('SSH command boundary', () => {
  it('keeps identical remote history immutable and exposes changed bytes in a new snapshot', async () => {
    const options = { namespace: randomUUID(), prefix: ['sessions'] };
    const frame = (text: string): string => `./session.jsonl\0${Buffer.from(text).toString('base64')}\0`;
    const first = await writeSSHFileSnapshot(frame('first'), options);
    try {
      const file = join(first, 'sessions', 'session.jsonl');
      const before = await stat(file);
      expect(await writeSSHFileSnapshot(frame('first'), options)).toBe(first);
      expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
      const changed = await writeSSHFileSnapshot(frame('later'), options);
      expect(changed).not.toBe(first);
      expect(await readFile(join(changed, 'sessions', 'session.jsonl'), 'utf8')).toBe('later');
      expect(await readFile(file, 'utf8')).toBe('first');
      await expect(writeSSHFileSnapshot(`./../escape.jsonl\0eA==\0`, options)).rejects.toThrow(SSHConnectionError);
    } finally { await rm(dirname(first), { recursive: true, force: true }); }
  });
  it('preserves remote arguments, working directory and explicit environment as data', async () => {
    const connection = { ...DEFAULT_SSH_CONNECTION, enabled: true, host: 'user@example.com', remoteDirectory: '/tmp' };
    const payload = "spaces ' $(printf INJECTED) ; & 한글";
    const spec = buildSSHCommand(connection, {
      command: '/bin/sh', args: ['-c', 'printf "%s\\n%s\\n%s" "$PWD" "$NERODIAN_TEST" "$1"', 'test', payload],
      environment: { NERODIAN_TEST: payload },
    });
    const remoteCommand = spec.args.at(-1);
    expect(remoteCommand).toBeDefined();
    const { stdout } = await execute('/bin/sh', ['-c', remoteCommand ?? 'exit 1']);
    expect(stdout).toBe(`/tmp\n${payload}\n${payload}`);
  });

  it.each(['-oProxyCommand=bad', 'host;touch /tmp/bad', 'user@host\nother'])('rejects SSH option or shell injection: %s', host => {
    expect(() => buildSSHCommand({ ...DEFAULT_SSH_CONNECTION, enabled: true, host, remoteDirectory: '/tmp' }, {
      command: 'claude', args: [], environment: {},
    })).toThrow(SSHConnectionError);
  });

  it('fails before spawning when the remote workspace is missing', () => {
    expect(() => buildSSHCommand({ ...DEFAULT_SSH_CONNECTION, enabled: true, host: 'server' }, {
      command: 'claude', args: [], environment: {},
    })).toThrow(SSHConnectionError);
  });
});

import { createHash } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { SSHConnectionError } from './SSHConnection';

const pending = new Map<string, Promise<string>>();

export async function writeSSHFileSnapshot(output: string, options: { readonly namespace: string; readonly prefix: readonly string[] }): Promise<string> {
  const root = path.join(tmpdir(), 'kk-nerodian-ssh', options.namespace);
  const digest = createHash('sha256').update(JSON.stringify([options.prefix, output])).digest('hex');
  const directory = path.join(root, digest);
  const active = pending.get(directory);
  if (active) return active;
  const materialize = async (): Promise<string> => {
    try { await access(path.join(directory, '.complete')); return directory; }
    catch (error) {
      if (!(error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const destinationRoot = path.join(directory, ...options.prefix);
    await mkdir(destinationRoot, { recursive: true });
    const frames = output ? output.split('\0') : [];
    if (frames.length && frames.pop() !== '') throw new SSHConnectionError('Incomplete SSH history response');
    if (frames.length % 2) throw new SSHConnectionError('Invalid SSH history response');
    for (let index = 0; index < frames.length; index += 2) {
      const relative = frames[index];
      const encoded = frames[index + 1];
      if (!relative || encoded === undefined || !/^\.\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/u.test(relative)
        || relative.split('/').some(segment => segment === '..') || !/^[a-zA-Z0-9+/]*={0,2}$/u.test(encoded)) {
        throw new SSHConnectionError('Invalid remote history file');
      }
      const destination = path.join(destinationRoot, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.from(encoded, 'base64'), { mode: 0o600 });
    }
    await writeFile(path.join(directory, '.complete'), '', { mode: 0o600 });
    return directory;
  };
  const result = materialize();
  pending.set(directory, result);
  try { return await result; }
  finally { pending.delete(directory); }
}

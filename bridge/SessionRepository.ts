import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { readRemoteSession, record, RemoteProtocolError, type RemoteSession, string } from '../src/remote/protocol';

export type StoredSession = {
  state: RemoteSession;
  nativeId: string;
  operations: string[];
};

export class SessionRepository {
  readonly sessions = new Map<string, StoredSession>();
  private writes = Promise.resolve();

  constructor(private readonly directory: string) {}

  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let contents: string;
    try { contents = await readFile(path.join(this.directory, 'sessions.json'), 'utf8'); }
    catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    const parsed: unknown = JSON.parse(contents);
    if (!Array.isArray(parsed)) throw new TypeError('Invalid bridge session store');
    for (const value of parsed) {
      const entry = record(value);
      const state = readRemoteSession(entry.state);
      if (!Array.isArray(entry.operations)) throw new TypeError('Invalid operation history');
      this.sessions.set(state.id, {
        state: { ...state, running: false, approvals: [], error: state.running ? 'Bridge restarted. Send a message to continue.' : state.error },
        nativeId: string(entry.nativeId), operations: entry.operations.map(string),
      });
    }
  }

  create(provider: 'claude' | 'codex' = 'codex', model = ''): StoredSession {
    const state: RemoteSession = { id: randomUUID(), title: 'New conversation', messages: [], running: false, error: '', approvals: [], provider, model };
    const session = { state, nativeId: '', operations: [] };
    this.sessions.set(state.id, session);
    return session;
  }

  save(): Promise<void> {
    const snapshot = JSON.stringify([...this.sessions.values()]);
    const write = this.writes.then(async () => {
      const target = path.join(this.directory, 'sessions.json');
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, target);
    });
    this.writes = write.catch(() => undefined);
    return write;
  }

  async accept(session: StoredSession, input: { readonly prompt: string; readonly operationId: string; readonly model?: string }): Promise<boolean> {
    if (session.operations.includes(input.operationId)) return false;
    if (session.state.running) throw new RemoteProtocolError('This session is already running');
    if (!input.prompt.trim() || input.prompt.length > 200_000) throw new RemoteProtocolError('Enter a message shorter than 200,000 characters');
    const previous = { ...session };
    session.state = {
      ...session.state, running: true, error: '', model: input.model ?? session.state.model,
      title: session.state.messages.length ? session.state.title : input.prompt.slice(0, 80),
      messages: [...session.state.messages, { id: randomUUID(), role: 'user', text: input.prompt }],
    };
    session.operations = [...session.operations.slice(-255), input.operationId];
    try { await this.save(); }
    catch (error) { Object.assign(session, previous); throw error; }
    return true;
  }
}

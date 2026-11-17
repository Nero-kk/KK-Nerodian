import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CodexRuntimeHarness } from '@test/helpers/providers/codex/CodexRuntimeHarness';

import { readRemoteSession } from '@/remote/protocol';

import { createBridgeServer } from '../../../bridge/BridgeServer';
import { CodexEngine } from '../../../bridge/CodexEngine';
import { SessionRepository } from '../../../bridge/SessionRepository';

const native = new CodexRuntimeHarness();
vi.mock('cross-spawn', () => ({ default: vi.fn(() => native.createProcess()) }));

it('streams Codex replies, routes approvals, stops the native turn and resumes its persisted thread', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nerodian-codex-'));
  const repository = new SessionRepository(directory);
  await repository.load();
  const launch = { command: 'codex', args: ['app-server', '--listen', 'stdio://'], spawnCwd: directory, workspace: directory, env: {} };
  const engine = new CodexEngine(repository, launch);
  const server = createBridgeServer(repository, engine, 'test-token');
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new TypeError('Expected TCP address');
  const endpoint = `http://127.0.0.1:${address.port}/v1`;
  const request = async (route: string, body?: Readonly<Record<string, unknown>>): Promise<unknown> => {
    const response = await fetch(endpoint + route, {
      method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    expect(response.status).toBe(200);
    const result: unknown = await response.json();
    return result;
  };
  try {
    const session = readRemoteSession(await request('/sessions', { provider: 'codex', model: 'chosen-model' }));
    const route = `/sessions/${session.id}`;
    await request(`${route}/send`, { prompt: 'Hello Codex', operationId: 'first-send' });
    const proc = await native.waitForRequest('turn/start');
    proc.notify('item/agentMessage/delta', { threadId: 'thread-1', itemId: 'reply', delta: 'Hello ' });
    proc.notify('item/agentMessage/delta', { threadId: 'thread-1', itemId: 'reply', delta: 'mobile' });
    await vi.waitFor(async () => {
      expect(readRemoteSession(await request(route)).messages.map(message => message.text)).toEqual(['Hello Codex', 'Hello mobile']);
    });
    const nativeApproval = proc.requestFromServer('approval', 'item/commandExecution/requestApproval', { threadId: 'thread-1', turnId: 'turn-thread-1', command: 'pwd' });
    let approvalId = '';
    await vi.waitFor(async () => {
      const state = readRemoteSession(await request(route));
      expect(state.approvals).toHaveLength(1);
      approvalId = state.approvals[0]?.id ?? '';
    });
    await request(`${route}/approve`, { approvalId, allow: true });
    expect(await nativeApproval).toMatchObject({ result: { decision: 'accept' } });
    await request(`${route}/stop`, {});
    const restored = new SessionRepository(directory);
    await vi.waitFor(async () => {
      await restored.load();
      expect(restored.sessions.get(session.id)?.state.running).toBe(false);
      expect(restored.sessions.get(session.id)?.state.messages.map(message => message.text)).toEqual(['Hello Codex', 'Hello mobile']);
    });
    const stored = restored.sessions.get(session.id);
    if (!stored) throw new TypeError('Missing persisted Codex session');
    expect(stored.nativeId).toBe('thread-1');
    const resumed = new CodexEngine(restored, launch);
    await resumed.send(stored, { prompt: 'Continue', operationId: 'second-send' });
    const resumedProc = await native.waitForRequest('turn/start', 1);
    expect(resumedProc.subscribed.has('thread-1')).toBe(true);
    resumed.stop(stored.state.id);
    await vi.waitFor(() => expect(stored.state.running).toBe(false));
  } finally {
    engine.stopAll();
    native.processes.forEach(proc => proc.exit());
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
    native.reset();
  }
});

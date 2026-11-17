import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readRemoteSession } from '@/remote/protocol';

import { createBridgeServer } from '../../../bridge/BridgeServer';
import { ClaudeEngine } from '../../../bridge/ClaudeEngine';
import { SessionRepository } from '../../../bridge/SessionRepository';

const native = await vi.importActual<typeof import('@test/__mocks__/claude-agent-sdk')>('@anthropic-ai/claude-agent-sdk');
const token = 'bridge-test-token-0123456789abcdef';
let directory: string;
let endpoint: string;
let repository: SessionRepository;
let server: Server;
let engine: ClaudeEngine;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nerodian-bridge-test-'));
  repository = new SessionRepository(directory);
  await repository.load();
  engine = new ClaudeEngine(repository, { cwd: directory, pathToClaudeCodeExecutable: 'claude' });
  server = createBridgeServer(repository, engine, token);
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new TypeError('Expected TCP address');
  endpoint = `http://127.0.0.1:${address.port}/v1`;
  native.resetMockMessages();
});

afterEach(async () => {
  engine.stopAll();
  await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
  await rm(directory, { recursive: true, force: true });
  native.resetMockMessages();
});

async function request(route: string, input?: Readonly<Record<string, unknown>>) {
  const response = await fetch(`${endpoint}${route}`, {
    method: input ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
  expect(response.status).toBe(200);
  const value: unknown = await response.json();
  return value;
}

it('rejects unauthenticated clients and browser-origin requests', async () => {
  expect((await fetch(`${endpoint}/sessions`)).status).toBe(401);
  expect((await fetch(`${endpoint}/sessions`, { headers: { Authorization: `Bearer ${token}`, Origin: 'https://other.example' } })).status).toBe(401);
  expect(await request('/sessions')).toEqual([]);
});

it('deduplicates sends, persists remote replies and resumes the same native session after restart', async () => {
  native.setMockMessages([
    { type: 'assistant', session_id: 'native-session', message: { id: 'reply-1', content: [{ type: 'text', text: 'Remote answer' }] } },
  ]);
  const session = readRemoteSession(await request('/sessions', { provider: 'claude' }));
  const route = `/sessions/${session.id}`;
  const operation = { prompt: 'Hello', operationId: 'one' };
  await request(`${route}/send`, operation);
  await request(`${route}/send`, operation);
  const restored = new SessionRepository(directory);
  await vi.waitFor(async () => {
    await restored.load();
    expect(restored.sessions.get(session.id)?.state.messages.map(message => message.text)).toEqual(['Hello', 'Remote answer']);
  });
  expect(restored.sessions.get(session.id)?.nativeId).toBe('native-session');
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  engine = new ClaudeEngine(restored, { cwd: directory, pathToClaudeCodeExecutable: 'claude' });
  server = createBridgeServer(restored, engine, token);
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new TypeError('Expected TCP address');
  endpoint = `http://127.0.0.1:${address.port}/v1`;
  native.setMockMessages([{ type: 'assistant', session_id: 'native-session', message: { id: 'reply-2', content: [{ type: 'text', text: 'Continued' }] } }]);
  await request(`${route}/send`, { prompt: 'Continue', operationId: 'two' });
  await vi.waitFor(async () => {
    const state = readRemoteSession(await request(route));
    expect(state.messages.map(message => message.text)).toEqual(['Hello', 'Remote answer', 'Continue', 'Continued']);
  });
  expect(native.getLastOptions()?.resume).toBe('native-session');
});

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';

import { record, RemoteProtocolError, string } from '../src/remote/protocol';
import type { ClaudeEngine } from './ClaudeEngine';
import type { SessionRepository } from './SessionRepository';

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 256 * 1024) throw new RemoteProtocolError('Request is too large');
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  return record(parsed);
}

export function createBridgeServer(repository: SessionRepository, engine: Pick<ClaudeEngine, 'send' | 'stop' | 'approve'>, token: string): Server {
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  const expected = digest(`Bearer ${token}`);
  return createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    const reply = (status: number, value: unknown): void => { response.writeHead(status); response.end(JSON.stringify(value)); };
    if (request.headers.origin || !timingSafeEqual(expected, digest(request.headers.authorization ?? ''))) {
      reply(401, { error: 'Unauthorized' }); return;
    }
    try {
      const route = request.url ?? '';
      if (route === '/v1/health' && request.method === 'GET') { reply(200, { name: 'KK-Nerodian', version: '0.1.0' }); return; }
      if (route === '/v1/sessions') {
        if (request.method === 'GET') {
          reply(200, [...repository.sessions.values()].map(({ state }) => ({ id: state.id, title: state.title, running: state.running }))); return;
        }
        if (request.method === 'POST') {
          const input = await body(request);
          if (input.provider !== undefined && input.provider !== 'claude' && input.provider !== 'codex') throw new RemoteProtocolError('Unknown provider');
          const session = repository.create(input.provider === 'claude' ? 'claude' : 'codex', typeof input.model === 'string' ? input.model : '');
          try { await repository.save(); }
          catch (error) { repository.sessions.delete(session.state.id); throw error; }
          reply(200, session.state); return;
        }
      }
      const match = /^\/v1\/sessions\/([a-zA-Z0-9-]+)(?:\/(send|stop|approve))?$/u.exec(route);
      const session = match?.[1] ? repository.sessions.get(match[1]) : undefined;
      if (!session) { reply(404, { error: 'Session not found' }); return; }
      if (!match?.[2] && request.method === 'GET') { reply(200, session.state); return; }
      if (request.method !== 'POST') { reply(405, { error: 'Method not allowed' }); return; }
      const input = await body(request);
      switch (match?.[2]) {
        case 'send':
          await engine.send(session, { prompt: string(input.prompt), operationId: string(input.operationId), ...(typeof input.model === 'string' ? { model: input.model } : {}) });
          reply(200, session.state); return;
        case 'stop':
          engine.stop(session.state.id); reply(200, { stopped: true }); return;
        case 'approve':
          if (typeof input.allow !== 'boolean') throw new RemoteProtocolError('Invalid approval');
          engine.approve(session.state.id, string(input.approvalId), input.allow);
          reply(200, { accepted: true }); return;
        default: reply(404, { error: 'Unknown route' }); return;
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      reply(error instanceof RemoteProtocolError || error instanceof SyntaxError ? 400 : 500, { error: error.message });
    }
  });
}

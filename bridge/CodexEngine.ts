import { randomUUID } from 'node:crypto';

import { CodexAppServerProcess } from '../src/providers/codex/runtime/CodexAppServerProcess';
import { CodexRPCTransport } from '../src/providers/codex/runtime/CodexRPCTransport';
import { record, RemoteProtocolError, string } from '../src/remote/protocol';
import type { SessionRepository, StoredSession } from './SessionRepository';

type Launch = ConstructorParameters<typeof CodexAppServerProcess>[0] & { readonly workspace: string };
type ActiveRun = { readonly transport: CodexRPCTransport; readonly session: StoredSession; threadId: string; turnId: string; cancelled: boolean };

export class CodexEngine {
  private readonly active = new Map<string, ActiveRun>();
  private readonly approvals = new Map<string, { readonly sessionId: string; readonly resolve: (allow: boolean) => void }>();

  constructor(private readonly repository: SessionRepository, private readonly launch: Launch) {}

  async send(session: StoredSession, input: { readonly prompt: string; readonly operationId: string; readonly model?: string }): Promise<void> {
    if (!await this.repository.accept(session, input)) return;
    void this.run(session, input.prompt);
  }

  stop(id: string): void {
    const run = this.active.get(id);
    if (!run) return;
    run.cancelled = true;
    for (const [key, approval] of this.approvals) if (approval.sessionId === id) { approval.resolve(false); this.approvals.delete(key); }
    if (run.threadId && run.turnId) void run.transport.request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId }).catch(error => {
      run.session.state = { ...run.session.state, error: error instanceof Error ? error.message : String(error) };
    });
  }

  stopAll(): void { for (const id of this.active.keys()) this.stop(id); }

  approve(sessionId: string, id: string, allow: boolean): void {
    const pending = this.approvals.get(id);
    if (!pending || pending.sessionId !== sessionId) throw new RemoteProtocolError('Approval expired');
    this.approvals.delete(id); pending.resolve(allow);
  }

  private approval(session: StoredSession, method: string, params: unknown): Promise<unknown> {
    const id = randomUUID();
    session.state = { ...session.state, approvals: [...session.state.approvals, { id, tool: method, input: JSON.stringify(params, null, 2) }] };
    return new Promise(resolve => {
      this.approvals.set(id, { sessionId: session.state.id, resolve: allow => {
        session.state = { ...session.state, approvals: session.state.approvals.filter(item => item.id !== id) };
        resolve({ decision: allow ? 'accept' : 'decline' });
      } });
    });
  }

  private updateMessage(session: StoredSession, input: { readonly id: string; readonly text: string; readonly append: boolean }): void {
    const existing = session.state.messages.find(message => message.id === input.id);
    const message = { id: input.id, role: 'assistant' as const, text: input.append ? (existing?.text ?? '') + input.text : input.text };
    session.state = { ...session.state, messages: [...session.state.messages.filter(item => item.id !== input.id), message] };
  }

  private async run(session: StoredSession, prompt: string): Promise<void> {
    const proc = new CodexAppServerProcess(this.launch);
    const transport = new CodexRPCTransport(proc);
    const run: ActiveRun = { transport, session, threadId: session.nativeId, turnId: '', cancelled: false };
    this.active.set(session.state.id, run);
    const completed = new Promise<string>(resolve => {
      proc.onExit(() => resolve(proc.getStderrSnapshot() || 'Codex app-server exited'));
      transport.onNotification('turn/completed', value => {
        const turn = record(record(value).turn);
        resolve(turn.status === 'failed' ? JSON.stringify(turn.error ?? 'Codex turn failed') : '');
      });
    });
    transport.onNotification('turn/started', value => {
      run.turnId = string(record(record(value).turn).id);
      if (run.cancelled) this.stop(session.state.id);
    });
    transport.onNotification('item/agentMessage/delta', value => {
      const item = record(value);
      this.updateMessage(session, { id: string(item.itemId), text: string(item.delta), append: true });
    });
    transport.onNotification('item/completed', value => {
      const item = record(record(value).item);
      if (item.type === 'agentMessage' && typeof item.text === 'string') this.updateMessage(session, { id: string(item.id), text: item.text, append: false });
      if (item.type === 'commandExecution' && typeof item.aggregatedOutput === 'string') session.state = {
        ...session.state, messages: [...session.state.messages, { id: string(item.id), role: 'tool', text: item.aggregatedOutput }],
      };
    });
    for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']) {
      transport.onServerRequest(method, (_id, params) => this.approval(session, method, params));
    }
    try {
      proc.start(); transport.start();
      await transport.request('initialize', { clientInfo: { name: 'kk-nerodian', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      transport.notify('initialized');
      const settings = {
        cwd: this.launch.workspace, approvalPolicy: 'on-request', sandbox: 'workspace-write',
        ...(session.state.model ? { model: session.state.model } : {}),
      };
      const response = record(await transport.request(session.nativeId ? 'thread/resume' : 'thread/start', {
        ...settings, ...(session.nativeId ? { threadId: session.nativeId } : {}),
      }));
      run.threadId = string(record(response.thread).id);
      session.nativeId = run.threadId;
      if (run.cancelled) return;
      const started = record(await transport.request('turn/start', { threadId: run.threadId, input: [{ type: 'text', text: prompt, text_elements: [] }] }));
      run.turnId = string(record(started.turn).id);
      if (run.cancelled) this.stop(session.state.id);
      const error = await completed;
      if (error && !run.cancelled) session.state = { ...session.state, error };
    } catch (error) {
      session.state = { ...session.state, error: run.cancelled ? '' : error instanceof Error ? error.message : String(error) };
    } finally {
      this.active.delete(session.state.id);
      for (const [id, approval] of this.approvals) if (approval.sessionId === session.state.id) { approval.resolve(false); this.approvals.delete(id); }
      transport.dispose();
      await proc.shutdown();
      session.state = { ...session.state, running: false, approvals: [] };
      try { await this.repository.save(); }
      catch (error) { session.state = { ...session.state, error: error instanceof Error ? error.message : String(error) }; }
    }
  }
}

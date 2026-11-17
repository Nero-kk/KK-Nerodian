import { randomUUID } from 'node:crypto';

import { type Options, type PermissionResult,query } from '@anthropic-ai/claude-agent-sdk';

import type { RemoteMessage } from '../src/remote/protocol';
import { RemoteProtocolError } from '../src/remote/protocol';
import type { SessionRepository, StoredSession } from './SessionRepository';

type PendingApproval = { readonly sessionId: string; readonly settle: (allow: boolean) => void };

export class ClaudeEngine {
  private readonly runs = new Map<string, AbortController>();
  private readonly approvals = new Map<string, PendingApproval>();

  constructor(private readonly repository: SessionRepository, private readonly launch: Pick<Options, 'cwd' | 'pathToClaudeCodeExecutable' | 'spawnClaudeCodeProcess'>) {}

  async send(session: StoredSession, input: { readonly prompt: string; readonly operationId: string; readonly model?: string }): Promise<void> {
    if (!await this.repository.accept(session, input)) return;
    const controller = new AbortController();
    this.runs.set(session.state.id, controller);
    void this.run(session, { prompt: input.prompt, controller });
  }

  approve(sessionId: string, approvalId: string, allow: boolean): void {
    const pending = this.approvals.get(approvalId);
    if (!pending || pending.sessionId !== sessionId) throw new RemoteProtocolError('Approval expired');
    this.approvals.delete(approvalId);
    pending.settle(allow);
  }

  stop(id: string): void { this.runs.get(id)?.abort(); }
  stopAll(): void { for (const controller of this.runs.values()) controller.abort(); }

  private permission(session: StoredSession, tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
    const id = randomUUID();
    session.state = { ...session.state, approvals: [...session.state.approvals, { id, tool, input: JSON.stringify(input, null, 2) }] };
    return new Promise(resolve => {
      const cancel = (): void => settle(false);
      const settle = (allow: boolean): void => {
        signal.removeEventListener('abort', cancel);
        this.approvals.delete(id);
        session.state = { ...session.state, approvals: session.state.approvals.filter(approval => approval.id !== id) };
        resolve(allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Denied by user' });
      };
      this.approvals.set(id, { sessionId: session.state.id, settle });
      if (signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
    });
  }

  private async run(session: StoredSession, run: { readonly prompt: string; readonly controller: AbortController }): Promise<void> {
    let streamId: string = randomUUID();
    let text = '';
    const publish = (): void => {
      const messages = session.state.messages.filter(message => message.id !== streamId);
      const message: RemoteMessage = { id: streamId, role: 'assistant', text };
      session.state = { ...session.state, messages: [...messages, message] };
    };
    try {
      const response = query({ prompt: run.prompt, options: {
        ...this.launch, abortController: run.controller,
        ...(session.state.model ? { model: session.state.model } : {}),
        ...(session.nativeId ? { resume: session.nativeId } : {}),
        permissionMode: 'default', includePartialMessages: true, persistSession: true,
        canUseTool: (tool, input, options) => this.permission(session, tool, input, options.signal),
      } });
      for await (const message of response) {
        if ('session_id' in message && typeof message.session_id === 'string') session.nativeId = message.session_id;
        switch (message.type) {
          case 'stream_event':
            if (message.event.type === 'message_start') { streamId = message.event.message.id; text = ''; }
            if (message.event.type === 'content_block_delta' && message.event.delta.type === 'text_delta') {
              text += message.event.delta.text; publish();
            }
            break;
          case 'assistant': {
            streamId = message.message.id;
            text = message.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
            if (text) publish();
            break;
          }
          case 'result':
            if (message.is_error) session.state = { ...session.state, error: message.subtype === 'success' ? message.result : message.errors.join('\n') };
            break;
        }
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      session.state = { ...session.state, error: run.controller.signal.aborted ? '' : error.message };
    } finally {
      this.runs.delete(session.state.id);
      session.state = { ...session.state, running: false, approvals: [] };
      try { await this.repository.save(); }
      catch (error) {
        if (!(error instanceof Error)) throw error;
        session.state = { ...session.state, error: `Failed to save bridge history: ${error.message}` };
      }
    }
  }
}

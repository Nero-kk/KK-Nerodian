export type RemoteMessage = { readonly id: string; readonly role: 'user' | 'assistant' | 'tool'; readonly text: string };
export type RemoteApproval = { readonly id: string; readonly tool: string; readonly input: string };
export type RemoteSession = {
  readonly provider: 'claude' | 'codex';
  readonly model: string;
  readonly id: string;
  readonly title: string;
  readonly messages: readonly RemoteMessage[];
  readonly running: boolean;
  readonly error: string;
  readonly approvals: readonly RemoteApproval[];
};
export type RemoteSummary = { readonly id: string; readonly title: string; readonly running: boolean };
export type BridgeConfiguration = { readonly endpoint: string; readonly token: string };

export class RemoteProtocolError extends Error {
  constructor(readonly detail: string) { super(detail); this.name = 'RemoteProtocolError'; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new RemoteProtocolError('Expected an object');
  return value;
}

export function string(value: unknown): string {
  if (typeof value !== 'string') throw new RemoteProtocolError('Expected text');
  return value;
}

export function readRemoteSession(value: unknown): RemoteSession {
  const source = record(value);
  if (!Array.isArray(source.messages) || !Array.isArray(source.approvals) || typeof source.running !== 'boolean') {
    throw new RemoteProtocolError('Invalid remote session');
  }
  return {
    provider: source.provider === 'codex' ? 'codex' : 'claude', model: typeof source.model === 'string' ? source.model : '',
    id: string(source.id), title: string(source.title), running: source.running, error: string(source.error),
    messages: source.messages.map((value: unknown) => {
      const message = record(value);
      const role = message.role;
      if (role !== 'user' && role !== 'assistant' && role !== 'tool') throw new RemoteProtocolError('Invalid message role');
      return { id: string(message.id), role, text: string(message.text) };
    }),
    approvals: source.approvals.map((value: unknown) => {
      const approval = record(value);
      return { id: string(approval.id), tool: string(approval.tool), input: string(approval.input) };
    }),
  };
}

export function readRemoteSummaries(value: unknown): readonly RemoteSummary[] {
  if (!Array.isArray(value)) throw new RemoteProtocolError('Invalid session list');
  return value.map((value: unknown) => {
    const session = record(value);
    if (typeof session.running !== 'boolean') throw new RemoteProtocolError('Invalid session status');
    return { id: string(session.id), title: string(session.title), running: session.running };
  });
}

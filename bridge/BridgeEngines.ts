import type { ClaudeEngine } from './ClaudeEngine';
import type { CodexEngine } from './CodexEngine';
import type { SessionRepository, StoredSession } from './SessionRepository';

export class BridgeEngines {
  constructor(private readonly repository: SessionRepository, private readonly claude: ClaudeEngine, private readonly codex: CodexEngine) {}
  send(session: StoredSession, input: { readonly prompt: string; readonly operationId: string; readonly model?: string }): Promise<void> {
    return (session.state.provider === 'codex' ? this.codex : this.claude).send(session, input);
  }
  stop(id: string): void { this.claude.stop(id); this.codex.stop(id); }
  stopAll(): void { this.claude.stopAll(); this.codex.stopAll(); }
  approve(sessionId: string, id: string, allow: boolean): void {
    const provider = this.repository.sessions.get(sessionId)?.state.provider;
    (provider === 'codex' ? this.codex : this.claude).approve(sessionId, id, allow);
  }
}

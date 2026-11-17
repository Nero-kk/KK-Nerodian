import { ItemView, type WorkspaceLeaf } from 'obsidian';

import { BridgeClient } from './BridgeClient';
import { HermesComposer } from './hermes/HermesComposer';
import { renderMarkdown } from './hermes/markdown';
import { SessionPicker } from './hermes/SessionPicker';
import { t } from './i18n';
import type { RemoteSession } from './protocol';
import type { RemoteConnection } from './RemoteConnection';

export const REMOTE_VIEW_TYPE = 'kk-nerodian-remote';

export class RemoteView extends ItemView {
  private readonly client: BridgeClient;
  private session: RemoteSession | null = null;
  private transcript!: HTMLElement;
  private status!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private title!: HTMLElement;
  private requests!: HTMLElement;
  private provider!: HTMLSelectElement;
  private model!: HTMLInputElement;
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private timer: number | null = null;
  private closed = false;
  private connected = false;
  private generation = 0;
  private revision = '';
  private pending: { readonly id: string; readonly prompt: string; readonly sessionId: string } | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly connection: RemoteConnection, private readonly settings: () => void) {
    super(leaf);
    this.client = new BridgeClient(() => connection.configuration());
  }

  getViewType(): string { return REMOTE_VIEW_TYPE; }
  getDisplayText(): string { return 'KK-Nerodian remote'; }
  getIcon(): string { return 'network'; }

  async onOpen(): Promise<void> {
    this.closed = false;
    const root = this.contentEl;
    root.empty();
    root.addClass('nerodian-remote', 'kkn-chat');
    const header = root.createDiv({ cls: 'kkn-header' });
    this.title = header.createEl('h2', { cls: 'kkn-conversation-title', text: 'KK-Nerodian' });
    this.status = header.createEl('p', { cls: 'kkn-status', attr: { role: 'status', 'aria-live': 'polite' } });
    this.transcript = root.createDiv({ cls: 'kkn-messages', attr: { role: 'log', 'aria-label': t('message') } });
    this.transcript.createEl('p', { text: t('empty') });
    this.requests = root.createDiv({ cls: 'kkn-requests' });
    const composer = new HermesComposer(root, {
      send: () => this.send(), create: () => this.createSession(),
      pick: () => this.pickSession(), settings: this.settings,
      reconnect: () => this.action(() => this.connect()),
      stop: () => this.action(async () => { if (this.session) await this.client.stop(this.session.id); }),
    });
    this.input = composer.input;
    this.provider = composer.provider;
    this.model = composer.model;
    this.sendButton = composer.send;
    this.stopButton = composer.stop;
    this.stopButton.disabled = true;
    this.sendButton.disabled = !this.connection.endpoint;
    if (this.connection.endpoint) await this.action(() => this.connect());
    else this.status.setText(t('offline'));
  }

  private button(container: HTMLElement, label: string, action: () => void | Promise<void>): HTMLButtonElement {
    const button = container.createEl('button', { text: label, attr: { type: 'button', 'aria-label': label } });
    button.addEventListener('click', () => { void action(); });
    return button;
  }

  private pickSession(): void {
    new SessionPicker(this.app, {
      list: async () => {
        const sessions = await this.client.sessions();
        return { loadedCount: sessions.length, summaries: sessions.map(session => ({
          logicalSessionId: session.id, title: session.title, source: session.id.slice(0, 8),
          running: session.running, canResume: true,
        })) };
      },
      open: async id => { this.disconnect(); await this.connection.select(id); await this.connect(); },
    }).open();
  }

  private disconnect(): void {
    ++this.generation;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.connected = false;
    this.sendButton.disabled = true;
    this.stopButton.disabled = true;
  }

  private async connect(): Promise<void> {
    this.disconnect();
    const generation = ++this.generation;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.status.setText(t('connecting'));
    const sessions = await this.client.sessions();
    if (this.closed || generation !== this.generation) return;
    if (!sessions.some(session => session.id === this.connection.sessionId)) await this.connection.select(sessions[0]?.id ?? '');
    this.revision = '';
    if (this.connection.sessionId) await this.poll(generation, true);
    else {
      this.session = null;
      this.connected = true;
      this.transcript.empty();
      this.requests.empty();
      this.title.setText('KK-Nerodian');
      this.status.setText(t('ready'));
      this.sendButton.disabled = false;
      this.stopButton.disabled = true;
    }
  }

  private async poll(generation: number, initial = false): Promise<void> {
    try {
      const session = await this.client.session(this.connection.sessionId);
      if (this.closed || generation !== this.generation) return;
      this.session = session;
      this.connected = true;
      if (!this.revision) { this.provider.value = session.provider; this.model.value = session.model; }
      this.model.disabled = session.running;
      this.status.setText(session.error || t(session.running ? 'running' : 'ready'));
      this.sendButton.disabled = session.running;
      this.stopButton.disabled = !session.running;
      const revision = JSON.stringify(session);
      if (revision !== this.revision) { this.revision = revision; this.renderSession(session); }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (!this.closed && generation === this.generation) {
        this.disconnect();
        this.status.setText(error.message);
        if (initial) throw error;
      }
    } finally {
      if (!this.closed && generation === this.generation) this.timer = window.setTimeout(() => { void this.poll(generation); }, 1500);
    }
  }

  private renderSession(session: RemoteSession): void {
    const follow = this.transcript.scrollHeight - this.transcript.scrollTop - this.transcript.clientHeight < 80;
    this.title.setText(session.title);
    this.transcript.empty();
    this.requests.empty();
    for (const message of session.messages) {
      const block = this.transcript.createEl('article', { cls: `kkn-message kkn-role-${message.role}` });
      block.createEl('h3', { text: message.role === 'user' ? t('you') : session.provider === 'codex' ? 'Codex' : 'Claude' });
      renderMarkdown(block.createDiv({ cls: 'kkn-markdown' }), message.text);
    }
    for (const approval of session.approvals) {
      const block = this.requests.createDiv({ cls: 'kkn-request' });
      block.createEl('strong', { text: `${t('approval')}: ${approval.tool}` });
      block.createEl('pre', { text: approval.input });
      for (const allow of [true, false]) this.button(block, t(allow ? 'allow' : 'deny'), () => this.action(async () => {
        await this.client.approve(session.id, approval.id, allow);
      }));
    }
    if (follow) this.transcript.scrollTop = this.transcript.scrollHeight;
  }

  private async send(): Promise<void> {
    const prompt = this.input.value.trim();
    if (!this.connected || !prompt || this.session?.running) return;
    this.sendButton.disabled = true;
    await this.action(async () => {
      if (!this.session) {
        this.session = await this.client.create(this.provider.value === 'claude' ? 'claude' : 'codex', this.model.value.trim());
        await this.connection.select(this.session.id);
      }
      const id = this.session.id;
      if (this.pending?.prompt !== prompt || this.pending.sessionId !== id) this.pending = { id: crypto.randomUUID(), prompt, sessionId: id };
      await this.client.send(id, { prompt, operationId: this.pending.id, model: this.model.value.trim() });
      this.pending = null;
      if (this.input.value.trim() === prompt) this.input.value = '';
      await this.connect();
    });
    this.sendButton.disabled = !this.connected || Boolean(this.session?.running);
  }

  private async createSession(): Promise<void> {
    this.disconnect();
    await this.action(async () => {
      const session = await this.client.create(this.provider.value === 'claude' ? 'claude' : 'codex', this.model.value.trim());
      await this.connection.select(session.id);
      await this.connect();
    });
  }

  private async action(action: () => Promise<void>): Promise<void> {
    try { await action(); }
    catch (error) { if (!(error instanceof Error)) throw error; if (!this.closed) this.status.setText(error.message); }
  }

  async onClose(): Promise<void> {
    this.closed = true;
    ++this.generation;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.contentEl.empty();
  }
}

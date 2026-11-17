import type { Plugin } from 'obsidian';

import { t } from './i18n';
import { type BridgeConfiguration, record, RemoteProtocolError } from './protocol';

export class RemoteConnection {
  endpoint = '';
  sessionId = '';
  private readonly secretKey: string;
  private stored: Record<string, unknown> = {};

  constructor(private readonly plugin: Plugin) {
    const key = 'kk-nerodian-remote-secret';
    const existing: unknown = plugin.app.loadLocalStorage(key);
    this.secretKey = typeof existing === 'string' && existing ? existing : `kk-nerodian-${crypto.randomUUID()}`;
    if (this.secretKey !== existing) plugin.app.saveLocalStorage(key, this.secretKey);
  }

  async load(): Promise<void> {
    const data: unknown = await this.plugin.loadData();
    this.stored = data == null ? {} : record(data);
    const remote = this.stored.remoteBridge;
    if (remote === undefined) return;
    const saved = record(remote);
    this.endpoint = typeof saved.endpoint === 'string' ? saved.endpoint : '';
    this.sessionId = typeof saved.sessionId === 'string' ? saved.sessionId : '';
  }

  configuration(): BridgeConfiguration {
    return { endpoint: this.endpoint, token: this.plugin.app.secretStorage?.getSecret(this.secretKey) ?? '' };
  }

  async save(endpoint: string, token: string): Promise<void> {
    if (!this.plugin.app.secretStorage) throw new RemoteProtocolError(t('noSecretStorage'));
    this.plugin.app.secretStorage.setSecret(this.secretKey, token.trim());
    this.endpoint = endpoint.trim().replace(/\/$/u, '');
    await this.persist();
  }

  async select(id: string): Promise<void> { this.sessionId = id; await this.persist(); }

  private async persist(): Promise<void> {
    await this.plugin.saveData({ ...this.stored, remoteBridge: { endpoint: this.endpoint, sessionId: this.sessionId } });
  }
}

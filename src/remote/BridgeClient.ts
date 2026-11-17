import { requestUrl } from 'obsidian';

import { type BridgeConfiguration, readRemoteSession, readRemoteSummaries, RemoteProtocolError } from './protocol';

export class BridgeClient {
  constructor(private readonly configuration: () => BridgeConfiguration) {}

  async request(route: string, body?: Readonly<Record<string, unknown>>): Promise<unknown> {
    const { endpoint, token } = this.configuration();
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new RemoteProtocolError('Use an HTTPS bridge URL');
    }
    if (!token) throw new RemoteProtocolError('Set the bridge access token');
    const response = await requestUrl({
      url: `${url.href.replace(/\/$/u, '')}/v1${route}`,
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      throw: false,
    });
    if (response.status !== 200) throw new RemoteProtocolError(`Bridge request failed (${response.status}): ${response.text.slice(0, 500)}`);
    const result: unknown = response.json;
    return result;
  }

  async sessions() { return readRemoteSummaries(await this.request('/sessions')); }
  async session(id: string) { return readRemoteSession(await this.request(`/sessions/${encodeURIComponent(id)}`)); }
  async create(provider: 'claude' | 'codex' = 'codex', model = '') { return readRemoteSession(await this.request('/sessions', { provider, model })); }
  async send(id: string, input: { readonly prompt: string; readonly operationId: string; readonly model: string }) {
    return readRemoteSession(await this.request(`/sessions/${encodeURIComponent(id)}/send`, input));
  }
  async stop(id: string) { await this.request(`/sessions/${encodeURIComponent(id)}/stop`, {}); }
  async approve(id: string, approvalId: string, allow: boolean) {
    await this.request(`/sessions/${encodeURIComponent(id)}/approve`, { approvalId, allow });
  }
}

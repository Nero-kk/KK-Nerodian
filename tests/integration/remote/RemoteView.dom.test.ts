// @vitest-environment jsdom
import { App, Plugin, type RequestUrlResponsePromise, WorkspaceLeaf } from 'obsidian';

import { RemoteConnection } from '@/remote/RemoteConnection';
import { RemoteView } from '@/remote/RemoteView';

const { requestUrl } = await vi.importActual<typeof import('@test/__mocks__/obsidian')>('obsidian');
class TestPlugin extends Plugin {}

it('blocks sending to the previous conversation during and after a failed switch', async () => {
  const app = new App();
  const secrets = new Map<string, string>();
  Object.defineProperty(app, 'secretStorage', { value: {
    getSecret: (key: string) => secrets.get(key) ?? '',
    setSecret: (key: string, value: string) => { secrets.set(key, value); },
  } });
  const plugin = new TestPlugin(app, { id: 'KK-Nerodian', name: 'KK-Nerodian', version: '0.1.0', minAppVersion: '1.13.0', author: '', description: '' });
  const connection = new RemoteConnection(plugin);
  await connection.save('http://127.0.0.1:17868', 'test-token');
  await connection.select('a');
  const response = (json: unknown) => ({ status: 200, headers: {}, text: JSON.stringify(json), json, arrayBuffer: new ArrayBuffer(0) });
  let rejectSwitch!: (error: Error) => void;
  const switched = new Promise<ReturnType<typeof response>>((_resolve, reject) => { rejectSwitch = reject; });
  const requests: string[] = [];
  requestUrl.mockImplementation(options => {
    const promise = (async () => {
    if (typeof options === 'string') throw new TypeError('Expected request options');
    requests.push(`${options.method} ${options.url}`);
    if (options.url.endsWith('/sessions')) return response(['a', 'b'].map(id => ({ id, title: id, running: false })));
    if (options.url.endsWith('/sessions/b')) return switched;
    return response({ id: 'a', title: 'a', provider: 'codex', model: '', messages: [], running: false, error: '', approvals: [] });
    })();
    return Object.defineProperties(promise, {
      json: { get: () => promise.then(value => value.json) },
      text: { get: () => promise.then(value => value.text) },
      arrayBuffer: { get: () => promise.then(value => value.arrayBuffer) },
    }) as RequestUrlResponsePromise;
  });
  const view = new RemoteView(new WorkspaceLeaf(), connection, () => {});
  view.contentEl = document.createElement('div');
  document.body.append(view.contentEl);
  try {
    await view.onOpen();
    const send = view.contentEl.querySelector<HTMLButtonElement>('.kkn-send');
    expect(send?.disabled).toBe(false);
    await connection.select('b');
    view.contentEl.querySelector<HTMLButtonElement>('button[aria-label="Reconnect"]')?.click();
    expect(send?.disabled).toBe(true);
    const input = view.contentEl.querySelector('textarea');
    if (!input) throw new Error('Composer missing');
    input.value = 'Keep this draft';
    const submit = () => view.contentEl.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    submit();
    rejectSwitch(new Error('Session B unavailable'));
    await vi.waitFor(() => expect(view.contentEl.querySelector('[role="status"]')?.textContent).toBe('Session B unavailable'));
    submit();
    expect(requests.filter(request => request.startsWith('POST'))).toEqual([]);
    expect(input.value).toBe('Keep this draft');
    expect(send?.disabled).toBe(true);
  } finally {
    await view.onClose();
    view.contentEl.remove();
    requestUrl.mockReset();
  }
});

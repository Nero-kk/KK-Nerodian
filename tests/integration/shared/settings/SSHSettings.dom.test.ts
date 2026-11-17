// @vitest-environment jsdom
import { controlChangeSettled } from '@test/helpers/ObsidianHost';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { fireEvent, waitFor, within } from '@testing-library/dom';

import { registerProviderModules } from '@/core/providers/registerProviderModules';
import { t } from '@/i18n/i18n';
import { claudeProviderRegistration } from '@/providers/claude/registration';
import { codexProviderRegistration } from '@/providers/codex/registration';
import { readSSHConnection } from '@/shared/ssh/SSHConnection';
import { HERMES_ENVIRONMENT_FILE } from '@/shared/ssh/SSHConnectionProfile';
import { renderSSHSettings } from '@/shared/ssh/SSHSettings';

registerProviderModules([claudeProviderRegistration, codexProviderRegistration]);

it.each(['worker@remote.example', ''])('keeps newest SSH text "%s" while an older save finishes', async newest => {
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  let firstStarted!: () => void;
  let secondStarted!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
  const writingFirst = new Promise<void>(resolve => { firstStarted = resolve; });
  const writingSecond = new Promise<void>(resolve => { secondStarted = resolve; });
  let writes = 0;
  const fixture = await createProviderHostFixture({ beforePersist: async () => {
    if (++writes === 1) { firstStarted(); await firstGate; }
    else if (writes === 2) { secondStarted(); await secondGate; }
  } });
  const container = document.body.createDiv();
  try {
    renderSSHSettings(container, { plugin: fixture.host, notifyProviderModelOptionsChanged: () => {} }, 'codex');
    const input = within(container).getByRole<HTMLInputElement>('textbox', { name: t('ssh.host') });
    fireEvent.input(input, { target: { value: 'worker' } });
    const first = controlChangeSettled(input);
    await writingFirst;
    fireEvent.input(input, { target: { value: newest } });
    const second = controlChangeSettled(input);
    releaseFirst(); await writingSecond; await first;
    expect(input.value).toBe(newest);
    releaseSecond(); await second;
    expect(readSSHConnection(fixture.host.getRuntimeHost('codex').config, 'codex').host).toBe(newest);
  } finally { releaseFirst(); releaseSecond(); container.remove(); await fixture.dispose(); }
});

it.each(['claude', 'codex'] as const)('retains typed SSH fields in the %s settings and after reopening', async provider => {
  const fixture = await createProviderHostFixture();
  const container = document.body.createDiv();
  const context = { plugin: fixture.host, notifyProviderModelOptionsChanged: () => {} };
  const fields = [['ssh.host', 'user@remote.example'], ['ssh.directory', '/srv/vault'], ['ssh.port', '2202']] as const;
  try {
    renderSSHSettings(container, context, provider);
    for (const [key, value] of fields) {
      const input = within(container).getByRole<HTMLInputElement>('textbox', { name: t(key) });
      fireEvent.input(input, { target: { value } });
      await controlChangeSettled(input);
      expect(input.value).toBe(value);
    }
    expect(readSSHConnection(fixture.host.getRuntimeHost(provider).config, provider)).toMatchObject({ host: 'user@remote.example', remoteDirectory: '/srv/vault', port: 2202 });
    container.replaceChildren();
    renderSSHSettings(container, context, provider);
    for (const [key, value] of fields) expect(within(container).getByRole<HTMLInputElement>('textbox', { name: t(key) }).value).toBe(value);
  } finally { container.remove(); await fixture.dispose(); }
});

it.each(['claude', 'codex'] as const)('imports Hermes into %s and exports a reusable SSH profile through the settings buttons', async provider => {
  const fixture = await createProviderHostFixture();
  const container = document.body.createDiv();
  const context = { plugin: fixture.host, notifyProviderModelOptionsChanged: () => {} };
  const hermes = { format: 'kk-hermes-connect/environment', version: 1, connection: { endpoint: 'https://remote.example', profileId: '/home/user/.hermes/work' }, environment: {
    tailscaleIp: '100.101.102.103', ubuntuUser: 'worker', ubuntuHomePath: '/home/worker', ubuntuPluginPath: '/srv/My Vault/.obsidian/plugins/KK-Hermes-Connect', hermesExecutable: '/opt/hermes',
  } };
  await fixture.host.app.vault.adapter.write(HERMES_ENVIRONMENT_FILE, JSON.stringify(hermes));
  try {
    renderSSHSettings(container, context, provider);
    within(container).getByRole('button', { name: t('ssh.profiles') }).click();
    const modal = document.body.querySelector<HTMLElement>('.modal');
    if (!modal) throw new Error('SSH profile modal missing');
    const ui = within(modal);
    ui.getByRole('button', { name: t('ssh.loadHermes') }).click();
    await waitFor(() => expect(ui.getByRole<HTMLTextAreaElement>('textbox', { name: t('ssh.profileJSON') }).value).toContain('100.101.102.103'));
    ui.getByRole('button', { name: t('ssh.import') }).click();
    await waitFor(() => expect(ui.getByRole('status').textContent).toBe(t('ssh.profileApplied')));
    expect(readSSHConnection(fixture.host.getRuntimeHost(provider).config, provider)).toMatchObject({ host: 'worker@100.101.102.103', remoteDirectory: '/srv/My Vault', cliPath: provider, enabled: false });
    expect(within(container).getByRole<HTMLInputElement>('textbox', { name: t('ssh.host') }).value).toBe('worker@100.101.102.103');
    ui.getByRole('button', { name: t('ssh.export') }).click();
    const filename = `kk-nerodian-${provider}-ssh.private.json`;
    await waitFor(() => expect(ui.getByRole('status').textContent).toBe(t('ssh.profileExported', { filename })));
    const exported = await fixture.host.app.vault.adapter.read(filename);
    const saved: unknown = JSON.parse(exported);
    expect(saved).toEqual({ format: 'kk-nerodian/ssh', version: 1, provider, connection: { enabled: false, host: 'worker@100.101.102.103', port: 22, identityFile: '', remoteDirectory: '/srv/My Vault', cliPath: provider, executable: 'ssh' } });
    fireEvent.input(ui.getByRole('textbox', { name: t('ssh.profileJSON') }), { target: { value: '{invalid' } });
    ui.getByRole('button', { name: t('ssh.import') }).click();
    await waitFor(() => expect(ui.getByRole('status').textContent).toContain('Invalid connection JSON'));
    expect(readSSHConnection(fixture.host.getRuntimeHost(provider).config, provider).host).toBe('worker@100.101.102.103');
  } finally {
    document.body.querySelector('.modal-container')?.remove();
    container.remove(); await fixture.dispose();
  }
});

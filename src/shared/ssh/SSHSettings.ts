import { getProviderConfig, setProviderConfig } from '@/core/providers/providerConfig';
import type { ProviderSettingsTabRendererContext } from '@/core/providers/types';
import { t } from '@/i18n/i18n';
import { AccessibleSetting } from '@/shared/settings/AccessibleSetting';
import { bindCommittedControl } from '@/shared/settings/CommittedControl';
import { renderHostnameCLIPathSetting } from '@/shared/settings/HostnameCLIPathSetting';

import { readSSHConnection, type SSHConnection, updateSSHConnection } from './SSHConnection';
import { exportSSHProfile, importSSHProfile } from './SSHConnectionProfile';
import { SSHProfileModal } from './SSHProfileModal';
import { inspectSSHInstallation } from './SSHRuntime';

export function renderSSHSettings(container: HTMLElement, context: ProviderSettingsTabRendererContext, providerId: 'claude' | 'codex' = 'claude'): void {
  const host = context.plugin.getRuntimeHost(providerId);
  const read = (): SSHConnection => readSSHConnection(host.config, providerId);
  let saving = Promise.resolve();
  const save = (updates: Partial<SSHConnection>): Promise<void> => {
    saving = context.plugin.applyProviderRuntimeSettings([providerId], settings => {
      const config = getProviderConfig(settings, providerId);
      updateSSHConnection(config, { ...readSSHConnection(config, providerId), ...updates });
      setProviderConfig(settings, providerId, config);
    });
    return saving;
  };
  const section = container.createDiv({ cls: 'nerodian-ssh-settings' });
  const render = (): void => {
    section.empty();
    new AccessibleSetting(section).setName(t('ssh.title')).setHeading();
    new AccessibleSetting(section).setName(t('ssh.profiles')).addButton(button => {
      button.setButtonText(t('ssh.profiles')).onClick(() => {
        new SSHProfileModal(context.plugin.app, {
          provider: providerId,
          read: async () => { await saving; return exportSSHProfile(providerId, read()); },
          apply: async contents => {
            await saving;
            await save(importSSHProfile(contents, providerId, read()));
            render();
          },
        }).open();
      });
    });
    new AccessibleSetting(section).setName(t('ssh.enabled')).setDesc(t('ssh.description')).addToggle(control => {
      bindCommittedControl(control, () => read().enabled, value => save({ enabled: value }));
    });
    const fields = [
      { key: 'host', name: 'ssh.host', placeholder: 'user@server' },
      { key: 'remoteDirectory', name: 'ssh.directory', placeholder: '/home/user/vault' },
      { key: 'cliPath', name: 'ssh.cli', placeholder: providerId },
      { key: 'identityFile', name: 'ssh.identity', placeholder: '' },
      { key: 'executable', name: 'ssh.executable', placeholder: 'ssh' },
    ] as const;
    for (const field of fields) renderHostnameCLIPathSetting({
      container: section, name: t(field.name), description: '', placeholder: field.placeholder,
      getValue: () => read()[field.key], onChange: value => save({ [field.key]: value }),
    });
    renderHostnameCLIPathSetting({
      container: section, name: t('ssh.port'), description: '', placeholder: '22',
      getValue: () => String(read().port),
      validate: value => /^\d+$/u.test(value) && Number(value) >= 1 && Number(value) <= 65535 ? null : t('ssh.invalidPort'),
      onChange: value => save({ port: Number(value) }),
    });
    const result = section.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
    new AccessibleSetting(section).setName(t('ssh.test')).setDesc(t('ssh.authentication')).addButton(button => {
      button.setButtonText(t('ssh.test')).onClick(async () => {
        button.setDisabled(true);
        result.setText(t('ssh.testing'));
        try {
          const installation = await inspectSSHInstallation(read(), host.environmentText);
          result.setText(t('ssh.connected', { version: installation.version ?? installation.path ?? '' }));
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          result.setText(t('ssh.failed', { error: error.message }));
        } finally {
          button.setDisabled(false);
        }
      });
    });
  };
  render();
}

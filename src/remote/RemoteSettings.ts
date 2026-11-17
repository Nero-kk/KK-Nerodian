import { type App, Modal, Notice, type Plugin, PluginSettingTab, Setting, type SettingDefinitionItem } from 'obsidian';

import { BridgeClient } from './BridgeClient';
import { t } from './i18n';
import type { RemoteConnection } from './RemoteConnection';

function renderConnection(container: HTMLElement, connection: RemoteConnection): void {
  let endpoint = connection.endpoint;
  let token = connection.configuration().token;
  new Setting(container).setName(t('settings')).setHeading();
  container.createEl('p', { text: t('description') });
  new Setting(container).setName(t('endpoint')).addText(text => {
    text.inputEl.setAttribute('aria-label', t('endpoint'));
    text.setPlaceholder(new URL('https://server.tailnet.ts.net/nerodian').href).setValue(endpoint).onChange(value => { endpoint = value; });
  });
  new Setting(container).setName(t('token')).setDesc(t('tokenHint')).addText(text => {
    text.inputEl.type = 'password';
    text.inputEl.setAttribute('aria-label', t('token'));
    text.setValue(token).onChange(value => { token = value; });
  });
  const status = container.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
  new Setting(container).addButton(button => button.setButtonText(t('save')).setCta().onClick(async () => {
    button.setDisabled(true);
    try { await connection.save(endpoint, token); new Notice(t('saved')); }
    catch (error) { if (!(error instanceof Error)) throw error; status.setText(error.message); }
    finally { button.setDisabled(false); }
  })).addButton(button => button.setButtonText(t('test')).onClick(async () => {
    button.setDisabled(true);
    status.setText(t('connecting'));
    try {
      const client = new BridgeClient(() => ({ endpoint: endpoint.trim(), token: token.trim() }));
      await client.request('/health');
      status.setText(t('ready'));
    } catch (error) { if (!(error instanceof Error)) throw error; status.setText(error.message); }
    finally { button.setDisabled(false); }
  }));
}

export class RemoteSettingsModal extends Modal {
  constructor(app: App, private readonly connection: RemoteConnection) { super(app); }
  onOpen(): void { this.titleEl.setText(t('settings')); renderConnection(this.contentEl, this.connection); }
  onClose(): void { this.contentEl.empty(); }
}

export class RemoteSettingsTab extends PluginSettingTab {
  constructor(plugin: Plugin, private readonly connection: RemoteConnection) { super(plugin.app, plugin); }
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [{ name: t('settings'), searchable: false, render: setting => renderConnection(setting.settingEl, this.connection) }];
  }
}

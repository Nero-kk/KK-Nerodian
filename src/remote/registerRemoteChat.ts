import { Platform, type Plugin } from 'obsidian';

import { t } from './i18n';
import { RemoteConnection } from './RemoteConnection';
import { RemoteSettingsModal, RemoteSettingsTab } from './RemoteSettings';
import { REMOTE_VIEW_TYPE, RemoteView } from './RemoteView';

export async function registerRemoteChat(plugin: Plugin): Promise<void> {
  const connection = new RemoteConnection(plugin);
  await connection.load();
  const settings = (): void => { new RemoteSettingsModal(plugin.app, connection).open(); };
  plugin.registerView(REMOTE_VIEW_TYPE, leaf => new RemoteView(leaf, connection, settings));
  const open = async (): Promise<void> => {
    const leaf = plugin.app.workspace.getLeavesOfType(REMOTE_VIEW_TYPE)[0] ?? plugin.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: REMOTE_VIEW_TYPE, active: true });
    await plugin.app.workspace.revealLeaf(leaf);
  };
  plugin.addCommand({ id: 'open-remote-chat', name: t('open'), callback: () => { void open(); } });
  plugin.addCommand({ id: 'remote-connection-settings', name: t('settings'), callback: settings });
  plugin.addRibbonIcon('network', 'KK-Nerodian remote', () => { void open(); });
  if (Platform.isMobile) plugin.addSettingTab(new RemoteSettingsTab(plugin, connection));
}

import { type App, Modal } from 'obsidian';

import { t } from '@/i18n/i18n';
import { AccessibleSetting } from '@/shared/settings/AccessibleSetting';

import { HERMES_ENVIRONMENT_FILE, SSH_PROFILE_LIMIT } from './SSHConnectionProfile';

type ProfileActions = {
  readonly provider: 'claude' | 'codex';
  readonly read: () => Promise<string>;
  readonly apply: (contents: string) => Promise<void>;
};

export class SSHProfileModal extends Modal {
  constructor(app: App, private readonly actions: ProfileActions) { super(app); }

  onOpen(): void {
    this.titleEl.setText(t('ssh.profiles'));
    this.contentEl.createEl('p', { text: t('ssh.profileDescription') });
    const status = this.contentEl.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
    const run = async (action: () => Promise<void>): Promise<void> => {
      try { await action(); }
      catch (error) { if (!(error instanceof Error)) throw error; status.setText(t('ssh.failed', { error: error.message })); }
    };
    const input = this.contentEl.createEl('textarea', { attr: { rows: '10', 'aria-label': t('ssh.profileJSON'), spellcheck: 'false' } });
    input.addClass('nerodian-ssh-profile-json');
    const file = this.contentEl.createEl('input', { attr: { type: 'file', accept: '.json,application/json', 'aria-label': t('ssh.importFile') } });
    file.addEventListener('change', () => {
      const selected = file.files?.[0];
      if (!selected) return;
      void run(async () => {
        if (selected.size > SSH_PROFILE_LIMIT) throw new RangeError(t('ssh.profileTooLarge'));
        input.value = await selected.text();
        status.setText(t('ssh.profileLoaded'));
      });
    });
    new AccessibleSetting(this.contentEl).setName(t('ssh.hermesFile')).setDesc(HERMES_ENVIRONMENT_FILE).addButton(button => {
      button.setButtonText(t('ssh.loadHermes')).onClick(() => run(async () => {
        const stat = await this.app.vault.adapter.stat(HERMES_ENVIRONMENT_FILE);
        if (stat && stat.size > SSH_PROFILE_LIMIT) throw new RangeError(t('ssh.profileTooLarge'));
        input.value = await this.app.vault.adapter.read(HERMES_ENVIRONMENT_FILE);
        status.setText(t('ssh.profileLoaded'));
      }));
    });
    new AccessibleSetting(this.contentEl).addButton(button => {
      button.setButtonText(t('ssh.import')).setCta().onClick(async () => {
        button.setDisabled(true);
        await run(async () => { await this.actions.apply(input.value); status.setText(t('ssh.profileApplied')); });
        button.setDisabled(false);
      });
    }).addButton(button => {
      button.setButtonText(t('ssh.export')).onClick(() => run(async () => {
        const contents = await this.actions.read();
        const filename = `kk-nerodian-${this.actions.provider}-ssh.private.json`;
        await this.app.vault.adapter.write(filename, contents);
        input.value = contents;
        status.setText(t('ssh.profileExported', { filename }));
      }));
    });
  }

  onClose(): void { this.contentEl.empty(); }
}

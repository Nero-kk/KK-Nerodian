import { type App, Modal } from 'obsidian';

import { t } from '../i18n';

type SessionRow = { readonly logicalSessionId: string; readonly title: string; readonly source: string; readonly running: boolean; readonly canResume: boolean };
type Store = {
  readonly list: () => Promise<{ readonly summaries: readonly SessionRow[]; readonly loadedCount: number }>;
  readonly open: (id: string) => Promise<void>;
};

export class SessionPicker extends Modal {
  constructor(app: App, private readonly store: Store) { super(app); }
  async onOpen(): Promise<void> {
    this.titleEl.textContent = t('sessions');
    const search = this.contentEl.createEl('input', { type: 'search', placeholder: t('searchSessions'), attr: { 'aria-label': t('searchSessions') } });
    const description = this.contentEl.createEl('p', { text: t('connecting') });
    const results = this.contentEl.createDiv({ cls: 'kkn-session-results' });
    try {
      const listed = await this.store.list();
      description.textContent = String(listed.loadedCount);
      const render = (): void => {
        results.replaceChildren();
        const query = search.value.toLocaleLowerCase();
        const filtered = listed.summaries.filter(item => `${item.title} ${item.logicalSessionId}`.toLocaleLowerCase().includes(query));
        for (const item of filtered) {
          const row = results.createEl('button', { cls: 'kkn-session-row', text: `${item.title}\n${item.source}${item.running ? ` · ${t('running')}` : ''}`, attr: { type: 'button' } });
          row.disabled = !item.canResume;
          row.addEventListener('click', () => {
            void this.store.open(item.logicalSessionId).then(() => this.close()).catch((error: unknown) => {
              if (!(error instanceof Error)) throw error;
              description.textContent = error.message;
            });
          });
        }
        if (!filtered.length) results.createEl('p', { text: t('noSessions') });
      };
      search.addEventListener('input', render); render(); search.focus();
    } catch (error) { if (!(error instanceof Error)) throw error; description.textContent = error.message; }
  }
  onClose(): void { this.contentEl.empty(); }
}

import { Platform } from 'obsidian';

import { t } from '../i18n';
import { icon } from './composerIcons';

type Actions = {
  readonly send: () => Promise<void>;
  readonly create: () => Promise<void>;
  readonly pick: () => void;
  readonly settings: () => void;
  readonly reconnect: () => Promise<void>;
  readonly stop: () => Promise<void>;
};

export class HermesComposer {
  readonly input: HTMLTextAreaElement;
  readonly send: HTMLButtonElement;
  readonly stop: HTMLButtonElement;
  readonly provider: HTMLSelectElement;
  readonly model: HTMLInputElement;
  readonly element: HTMLFormElement;
  private composing = false;

  constructor(parent: HTMLElement, actions: Actions) {
    this.element = parent.createEl('form', { cls: 'kkn-composer' });
    const topbar = this.element.createDiv({ cls: 'kkn-composer-topbar' });
    const toolbar = topbar.createEl('nav', { cls: 'kkn-toolbar', attr: { 'aria-label': t('sessions') } });
    const tool = (label: string, glyph: string, action: () => void | Promise<void>): HTMLButtonElement => {
      const button = toolbar.createEl('button', { attr: { type: 'button', title: label, 'aria-label': label } });
      icon(button, glyph);
      button.addEventListener('click', () => { void action(); });
      return button;
    };
    tool(t('newSession'), 'square-pen', actions.create);
    tool(t('sessions'), 'history', actions.pick);
    tool(t('reconnect'), 'signal', actions.reconnect);
    this.stop = tool(t('stop'), 'x', actions.stop);
    tool(t('settings'), 'settings', actions.settings);
    const box = this.element.createDiv({ cls: 'kkn-input-box' });
    const label = box.createEl('label');
    this.input = label.createEl('textarea', { attr: { rows: '1', placeholder: t('placeholder'), 'aria-label': t('message') } });
    const footer = box.createDiv({ cls: 'kkn-composer-footer' });
    const models = footer.createDiv({ cls: 'kkn-model-controls' });
    this.provider = models.createEl('select', { cls: 'kkn-provider-select', attr: { 'aria-label': t('provider') } });
    this.provider.createEl('option', { text: 'Codex', value: 'codex' });
    this.provider.createEl('option', { text: 'Claude Code', value: 'claude' });
    this.provider.addEventListener('change', () => { void actions.create(); });
    this.model = models.createEl('input', { cls: 'kkn-model-input', attr: { 'aria-label': t('model'), placeholder: t('defaultModel'), type: 'text' } });
    this.send = footer.createEl('button', { cls: 'kkn-send', attr: { type: 'submit', title: t('send'), 'aria-label': t('send') } });
    icon(this.send, 'arrow-up');
    this.input.addEventListener('input', () => {
      this.input.setCssProps({ height: 'auto' });
      this.input.setCssProps({ height: `${Math.min(this.input.scrollHeight, 200)}px` });
    });
    this.input.addEventListener('compositionstart', () => { this.composing = true; });
    this.input.addEventListener('compositionend', () => { this.composing = false; });
    this.input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !Platform.isMobile && !this.composing && !event.isComposing) {
        event.preventDefault(); this.element.requestSubmit();
      }
    });
    this.element.addEventListener('submit', event => {
      event.preventDefault(); if (!this.composing) void actions.send();
    });
  }
}

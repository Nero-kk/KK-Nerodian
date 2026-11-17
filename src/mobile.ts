import { Plugin } from 'obsidian';

import { registerRemoteChat } from './remote/registerRemoteChat';

export default class NerodianMobilePlugin extends Plugin {
  async onload(): Promise<void> { await registerRemoteChat(this); }
}

# Hermes UI reuse

The source is the locally installed KK-Hermes-Connect 0.7.0.

- `composerIcons.ts` copies `src/composer-icons.ts`.
- `markdown.ts` copies the safe, text-only Markdown renderer from `src/markdown.ts`.
- `src/style/hermes.css` copies `styles.css`, changing `kkh` to `kkn` and the view id.
- `HermesComposer.ts` adapts the composer anatomy and IME behavior from `src/chat-panel.ts`.
- `SessionPicker.ts` adapts `src/session-picker.ts` to the Nerodian bridge port.

Only the connection/store adapter and the provider/model controls differ. Hermes
server, Slack, usage, note-write grants and fork operations are not represented
as working Nerodian controls. The original Hermes plugin is unchanged.

# KK-Nerodian interface

The desktop chat retains Claudian 2.3.43 and its Obsidian theme tokens. The
remote chat reuses KK-Hermes-Connect 0.7.0's composer, session picker,
Markdown renderer, icons and styles, with a Codex/Claude bridge adapter.

Primary action: send a message to the selected remote session. Reading order:
connection state, conversation, message composer. Secondary actions: new session,
select session, stop, reconnect. Required connection fields: bridge URL, access
token. Approval requests retain separate allow and deny actions.
The mobile provider selector starts with Codex; a model field accepts an override
or uses the server default when empty. Provider changes create a new session.

Layout: native ItemView fills the available pane; a compact header precedes one
scrolling transcript; the composer stays below it. Settings use native Setting
rows and flow vertically. At narrow widths the header wraps.

Colors use background-primary, background-secondary, text-normal, text-muted,
interactive-accent, text-on-accent, background-modifier-border and text-error.
Typography uses font-interface, font-text-size and font-smaller. Spacing uses
size-4-1 through size-4-4. Buttons, selects, text inputs and toggles inherit
Obsidian hover, pressed, disabled and focus-visible states. Remote message blocks
reuse Hermes's safe Markdown renderer. There are no remote fonts or decorative images.

The empty transcript explains connection setup. Requests show an inline pending
state, errors keep the draft, reconnect fetches the server's current state, and
stop cancels the server-owned run. A running request remains on the server while
the mobile client is suspended. Screen readers receive status changes through a
polite live region. All controls have explicit accessible names.

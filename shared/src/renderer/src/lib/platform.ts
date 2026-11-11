// Small platform differences in the UI: shortcut labels, the window controls'
// corner, and how the computer is called in hints.
export const isMac = window.oats.platform === 'darwin'

/** Shortcut label, e.g. shortcut('K') → "⌘K" on macOS, "Ctrl+K" elsewhere. */
export const shortcut = (key: string) => (isMac ? `⌘${key}` : `Ctrl+${key}`)

export const thisComputer = isMac ? 'this Mac' : 'this PC'

/** A rendered diagram: its PNG on disk and its pixel size. */
export type Diagram =
  | { status: 'ready'; file: string; width: number; height: number }
  | { status: 'failed'; error: string }

/** What the drawing needs to know about the session, set at session.start. */
export type Setup = {
  /** The Mermaid theme the PNGs are rendered with. */
  theme: 'dark' | 'default'
  /** False where the terminal cannot draw an Image from a file. */
  canDraw: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'mermaid-pictures': {
      diagrams: Shaped<Record<string, Diagram>>
      setup: Shaped<Setup | null>
      showSource: Shaped<boolean>
      enlarged: Shaped<string[]>
    }
  }
}

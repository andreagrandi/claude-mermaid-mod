export type Segment =
  | { kind: 'prose'; text: string }
  | { kind: 'diagram'; source: string; raw: string }

const OPENING = /^( {0,3})(`{3,}|~{3,})(.*)$/
const CLOSING = /^ {0,3}(`{3,}|~{3,})\s*$/

/**
 * Splits markdown into prose and closed `mermaid` fences. A fence that is not
 * closed yet, as while a reply streams, stays prose.
 */
export function splitFences(text: string): Segment[] {
  const lines = text.split('\n')
  const segments: Segment[] = []
  let prose: string[] = []
  let i = 0

  const flushProse = () => {
    if (prose.length > 0) segments.push({ kind: 'prose', text: prose.join('\n') })
    prose = []
  }

  while (i < lines.length) {
    const line = lines[i] ?? ''
    const open = OPENING.exec(line)
    // A backtick fence's info string may not hold a backtick.
    const marker = open?.[2] ?? ''
    const info = open?.[3] ?? ''
    if (open === null || (marker.startsWith('`') && info.includes('`'))) {
      prose.push(line)
      i += 1
      continue
    }
    const indent = open[1]?.length ?? 0
    const language = info.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
    let end = i + 1
    while (end < lines.length) {
      const fence = CLOSING.exec(lines[end] ?? '')?.[1] ?? ''
      if (fence !== '' && fence[0] === marker[0] && fence.length >= marker.length) break
      end += 1
    }
    const isClosed = end < lines.length
    if (language !== 'mermaid' || !isClosed) {
      // Other fences are copied whole, so a mermaid fence quoted inside one stays text.
      prose.push(...lines.slice(i, isClosed ? end + 1 : lines.length))
      i = isClosed ? end + 1 : lines.length
      continue
    }
    const body = lines
      .slice(i + 1, end)
      .map(line => line.replace(new RegExp(`^ {0,${indent}}`), ''))
    flushProse()
    segments.push({
      kind: 'diagram',
      source: body.join('\n'),
      raw: lines.slice(i, end + 1).join('\n'),
    })
    i = end + 1
  }
  flushProse()

  return segments
}

/** The mermaid sources of a text, in order. */
export function mermaidSources(text: string): string[] {
  return splitFences(text).flatMap(s => (s.kind === 'diagram' ? [s.source] : []))
}

/** A 53-bit hash (cyrb53) as hex: the cache key of one source in one theme. */
export function diagramKey(theme: string, source: string): string {
  const text = `${theme}\n${source.trim()}`
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)

  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

// The size of one terminal cell in the renderer's pixels. The engine reports
// no pixel metric, so this assumes a cell about twice as tall as it is wide.
const CELL_WIDTH = 8
const CELL_HEIGHT = 17
const MAX_CELLS = 255

/**
 * The box of cells a picture of `width` by `height` pixels takes: its natural
 * size, shrunk to fit `maxColumns` and `maxRows` with its aspect ratio kept.
 */
export function pictureBox(
  width: number,
  height: number,
  maxColumns: number,
  maxRows: number,
): { columns: number; rows: number } {
  const ratio = (height * CELL_WIDTH) / (width * CELL_HEIGHT)
  const columnLimit = Math.max(1, Math.min(MAX_CELLS, Math.floor(maxColumns)))
  const rowLimit = Math.max(1, Math.min(MAX_CELLS, Math.floor(maxRows)))
  let columns = Math.min(columnLimit, Math.ceil(width / CELL_WIDTH))
  let rows = Math.round(columns * ratio)
  if (rows > rowLimit) {
    rows = rowLimit
    columns = Math.min(columnLimit, Math.round(rows / ratio))
  }

  return { columns: Math.max(1, columns), rows: Math.max(1, rows) }
}

/** The width and height a PNG's IHDR chunk states, from its first 24 bytes. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47]
  if (bytes.length < 24 || signature.some((b, i) => bytes[i] !== b)) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  return { width: view.getUint32(16), height: view.getUint32(20) }
}

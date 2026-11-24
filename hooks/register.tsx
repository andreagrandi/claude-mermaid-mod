import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Diagram, Setup } from '../types'
import { diagramKey, mermaidSources, pictureBox, pngSize, splitFences } from './fences'

// Change a tag when its value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const DIAGRAMS = { plugin: 'mermaid-pictures', key: 'diagrams' } as const
const diagrams = atom(
  DIAGRAMS,
  {} as Record<string, Diagram>,
  { shape: 'diagrams-1' },
)
const setup = atom({ plugin: 'mermaid-pictures', key: 'setup' } as const, null as Setup | null, {
  shape: 'setup-1',
})

const CACHE_LIMIT = 100
const RENDER_TIMEOUT_MS = 10_000
// Share of the screen's rows one picture may take.
const MAX_ROW_SHARE = 0.6
// The reply's text is indented past the bullet; the picture lines up with it.
const INDENT = 2

type Options = { renderer?: string; rendererPath?: string }

/** What rendering needs, worked out at session.start. */
type Context = {
  dataDir: string
  theme: Setup['theme']
  configFile: string
  renderer: 'mmdr' | 'mmdc'
  command: string
}

// Module variables start over on a reload, and session.start runs again then.
let options: Options = {}
let context: Context | undefined
const inFlight = new Set<string>()
let queue: Promise<void> = Promise.resolve()

function log($: EngineInterface, text: string) {
  $.ui.log(`mermaid-pictures: ${text}`, { to: 'debug' })
}

async function prepare($: EngineInterface): Promise<Context> {
  const env = await $.process.hookEnv()
  const dataDir = env.CLAUDE_PLUGIN_DATA
  if (dataDir === undefined) throw new Error('no CLAUDE_PLUGIN_DATA folder')
  const themeRow = (await $.config.list()).find(row => row.key === 'theme')
  const theme = String(themeRow?.value ?? '').includes('light') ? 'default' : 'dark'
  const configFile = `${dataDir}/mermaid-config.json`
  await $.fs.write(configFile, JSON.stringify({ themeVariables: { background: 'transparent' } }))

  // An Image drawn from a file needs a kitty graphics terminal reading this
  // machine's files; tmux passes only bytes through, so it would show alt.
  const tmux = await $.env.get('TMUX')
  const term = (await $.env.get('TERM')) ?? ''
  const termProgram = (await $.env.get('TERM_PROGRAM')) ?? ''
  const kitty = await $.env.get('KITTY_WINDOW_ID')
  const canDraw =
    tmux === undefined &&
    (termProgram === 'ghostty' || term.includes('ghostty') || term.includes('kitty') || kitty !== undefined)
  await update($, setup, () => ({ theme, canDraw }))

  const renderer = options.renderer === 'mmdc' ? 'mmdc' : 'mmdr'
  const home = (await $.env.get('HOME')) ?? ''
  const command = await findCommand($, options.rendererPath ?? '', renderer, home)

  return { dataDir, theme, configFile, renderer, command }
}

async function findCommand($: EngineInterface, configured: string, name: string, home: string): Promise<string> {
  if (configured !== '') return configured
  for (const candidate of [name, `${home}/.cargo/bin/${name}`]) {
    try {
      await $.process.run([candidate, '--version'], { timeoutMs: RENDER_TIMEOUT_MS })
      return candidate
    } catch {
      // Not found here; try the next place.
    }
  }

  return name
}

function failed(stderr: string): Diagram {
  return { status: 'failed', error: stderr.trim().split('\n')[0] || 'the renderer failed' }
}

async function runRenderer($: EngineInterface, ctx: Context, argv: string[]) {
  return $.process.run([ctx.command, ...argv], { timeoutMs: RENDER_TIMEOUT_MS })
}

async function render($: EngineInterface, ctx: Context, key: string, source: string): Promise<Diagram> {
  const png = `${ctx.dataDir}/${key}.png`
  if (!(await $.fs.exists(png))) {
    const input = `${ctx.dataDir}/${key}.mmd`
    await $.fs.write(input, source)
    try {
      if (ctx.renderer === 'mmdr') {
        const common = ['-i', input, '-t', ctx.theme, '-c', ctx.configFile]
        const sized = await runRenderer($, ctx, [...common, '--size'])
        if (sized.exitCode !== 0) return failed(sized.stderr)
        const { width, height } = JSON.parse(sized.stdout) as { width: number; height: number }
        // Twice the natural size, so text stays sharp on a HiDPI screen.
        const drawn = await runRenderer($, ctx, [
          ...common,
          '-o', png, '-e', 'png',
          '-w', String(Math.ceil(width * 2)), '-H', String(Math.ceil(height * 2)),
        ])
        if (drawn.exitCode !== 0) return failed(drawn.stderr)
      } else {
        const drawn = await runRenderer($, ctx, ['-q', '-i', input, '-o', png, '-t', ctx.theme, '-b', 'transparent', '-s', '2'])
        if (drawn.exitCode !== 0) return failed(drawn.stderr)
      }
    } finally {
      await $.process.run(['rm', '-f', input]).catch(() => undefined)
    }
  }
  const { base64 } = await $.fs.read(png, { as: 'bytes', length: 24 })
  const size = pngSize(Uint8Array.from(atob(base64), ch => ch.charCodeAt(0)))
  if (size === undefined) return failed(`${png} is not a PNG`)

  return { status: 'ready', file: png, ...size }
}

/** Deletes the oldest PNGs past the cache limit and forgets them. */
async function prune($: EngineInterface, ctx: Context) {
  const pngs = (await $.fs.list(ctx.dataDir))
    .filter(entry => entry.kind === 'file' && entry.name.endsWith('.png'))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  const stale = pngs.slice(CACHE_LIMIT)
  if (stale.length === 0) return
  await $.process.run(['rm', '-f', ...stale.map(entry => `${ctx.dataDir}/${entry.name}`)])
  const gone = new Set(stale.map(entry => entry.name.replace(/\.png$/, '')))
  await update($, diagrams, map => Object.fromEntries(Object.entries(map).filter(([key]) => !gone.has(key))))
}

/** Renders every mermaid block of the main conversation not rendered yet. */
async function scan($: EngineInterface) {
  const ctx = context
  if (ctx === undefined) return
  const known = ((await $.state.get(DIAGRAMS)).value ?? {}) as Record<string, Diagram>
  const pending = new Map<string, string>()
  for (const message of await $.session.messages()) {
    if (message.role !== 'assistant' || !message.text.includes('mermaid')) continue
    for (const source of mermaidSources(message.text)) {
      const key = diagramKey(ctx.theme, source)
      if (known[key] === undefined && !inFlight.has(key)) pending.set(key, source)
    }
  }
  for (const [key, source] of pending) {
    inFlight.add(key)
    let diagram: Diagram
    try {
      diagram = await render($, ctx, key, source)
    } catch (error) {
      diagram = failed(error instanceof Error ? error.message : String(error))
    }
    inFlight.delete(key)
    if (diagram.status === 'failed') log($, `${ctx.command} failed on ${key}: ${diagram.error}`)
    await update($, diagrams, map => ({ ...map, [key]: diagram }))
  }
  if (pending.size > 0) await prune($, ctx)
}

/** Queues a scan outside the calling dispatch, one scan after another. */
function scanLater($: EngineInterface) {
  $.clock.after(0, () => {
    queue = queue.then(() => scan($)).catch(error => log($, `scan failed: ${String(error)}`))
  })
}

export const register: Register = (on, given) => {
  options = given as Options

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try {
      context = await prepare($)
      // A resumed session gets its pictures too.
      scanLater($)
    } catch (error) {
      log($, `setup failed: ${String(error)}`)
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) scanLater($)

    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || !e.props.text.includes('mermaid')) return next(e)
    const settings = await read($, setup)
    if (settings === null || !settings.canDraw) return next(e)
    const segments = splitFences(e.props.text)
    const map = await read($, diagrams)
    const isReady = (source: string) => map[diagramKey(settings.theme, source)]?.status === 'ready'
    if (!segments.some(s => s.kind === 'diagram' && isReady(s.source))) return next(e)

    const { Box, Image } = $.ui.resolve(e)
    const maxColumns = (e.viewport?.columns ?? 80) - INDENT * 2
    const maxRows = (e.viewport?.rows ?? 40) * MAX_ROW_SHARE
    const parts = []
    let isFirst = e.props.isFirstOfReply
    for (const [index, segment] of segments.entries()) {
      const diagram = segment.kind === 'diagram' ? map[diagramKey(settings.theme, segment.source)] : undefined
      if (segment.kind === 'diagram' && diagram?.status === 'ready') {
        const box = pictureBox(diagram.width, diagram.height, maxColumns, maxRows)
        parts.push(
          <Box paddingLeft={INDENT} marginBottom={1}>
            <Image
              key={`diagram-${index}`}
              source={{ file: diagram.file, format: 'png' }}
              columns={box.columns}
              rows={box.rows}
              alt={segment.raw}
            />
          </Box>,
        )
        continue
      }
      const text = (segment.kind === 'prose' ? segment.text : segment.raw).trim()
      if (text === '') continue
      // Prose, and a diagram not drawn, go to the engine's own drawing.
      parts.push(await next({ ...e, props: { ...e.props, text, isFirstOfReply: isFirst } }))
      isFirst = false
    }

    return <Box flexDirection="column">{parts}</Box>
  })
}

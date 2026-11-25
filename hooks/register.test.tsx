import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { diagramKey } from './fences'

const DATA = '/data/mermaid-pictures'
const FLOW = 'flowchart TD\n    A --> B'
const FENCE = `\`\`\`mermaid\n${FLOW}\n\`\`\``
const REPLY = `Before.\n\n${FENCE}\n\nAfter.`
const KEY = diagramKey('dark', FLOW)
const PNG = `${DATA}/${KEY}.png`

// The first 24 bytes of a 400 by 200 PNG: signature, IHDR length and type, size.
const PNG_HEADER = btoa(
  String.fromCharCode(
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    0, 0, 0x01, 0x90, 0, 0, 0, 0xc8,
  ),
)

const message = (text: string) =>
  ({
    plugin: 'mermaid-pictures',
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId: 'm1',
    props: { text, isFirstOfReply: true },
  }) as const

/** Stands for the engine's own drawing of a reply block: its text, marked. */
function engineDraws(on: On) {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{`engine: ${(e.props as { text: string }).text}`}</Text>
  })
}

/** Seeds what session.start and an earlier scan stored. */
function seed(on: On, diagrams: Record<string, unknown>) {
  on('state.get', (_, e, next) => {
    if (e.key === 'setup') {
      return { value: { value: { shape: 'setup-1', value: { theme: 'dark', canDraw: true } }, version: 1 } }
    }
    if (e.key === 'diagrams') return { value: { value: { shape: 'diagrams-1', value: diagrams }, version: 1 } }

    return next(e)
  })
}

async function drawnInOrder(ui: { findAll: (q: { type?: string }) => Promise<{ type: string; text: string }[]> }) {
  const all = await ui.findAll({})

  return all.filter(el => el.type === 'Text' || el.type === 'Image').map(el => `${el.type}: ${el.text}`)
}

test('a reply with no mermaid fence draws exactly as before', async ($, on) => {
  engineDraws(on)
  seed(on, { [KEY]: { status: 'ready', file: PNG, width: 400, height: 200 } })

  const ui = await $.ui.mount(message('Just prose.\n\n```ts\nconst a = 1\n```'))

  expect(await drawnInOrder(ui)).toEqual(['Text: engine: Just prose.\n\n```ts\nconst a = 1\n```'])
  await ui.unmount()
})

test('a reply with one ready diagram draws prose, picture, prose', async ($, on) => {
  engineDraws(on)
  seed(on, { [KEY]: { status: 'ready', file: PNG, width: 400, height: 200 } })

  const ui = await $.ui.mount(message(REPLY))

  const drawn = await drawnInOrder(ui)
  expect(drawn).toHaveLength(3)
  expect(drawn[0]).toBe('Text: engine: Before.')
  expect(drawn[1]).toMatch(/^Image: /)
  expect(drawn[2]).toBe('Text: engine: After.')
  const image = await ui.find({ type: 'Image' })
  expect(image?.props.source).toEqual({ file: PNG, format: 'png' })
  // 400 by 200 pixels is 50 columns, and 50 * 8 * 200 / (400 * 17) rows.
  expect(image?.props.columns).toBe(50)
  expect(image?.props.rows).toBe(12)
  expect(image?.props.alt).toBe(FENCE)
  await ui.unmount()
})

test('a diagram still rendering draws as source', async ($, on) => {
  engineDraws(on)
  seed(on, {})

  const ui = await $.ui.mount(message(REPLY))

  expect(await drawnInOrder(ui)).toEqual([`Text: engine: ${REPLY}`])
  await ui.unmount()
})

test('a failed render draws as source', async ($, on) => {
  engineDraws(on)
  seed(on, { [KEY]: { status: 'failed', error: 'invalid flowchart edge syntax' } })

  const ui = await $.ui.mount(message(REPLY))

  expect(await drawnInOrder(ui)).toEqual([`Text: engine: ${REPLY}`])
  await ui.unmount()
})

test('a terminal that cannot draw images draws as source', async ($, on) => {
  engineDraws(on)
  on('state.get', (_, e, next) => {
    if (e.key === 'setup') {
      return { value: { value: { shape: 'setup-1', value: { theme: 'dark', canDraw: false } }, version: 1 } }
    }
    if (e.key === 'diagrams') {
      return {
        value: {
          value: { shape: 'diagrams-1', value: { [KEY]: { status: 'ready', file: PNG, width: 400, height: 200 } } },
          version: 1,
        },
      }
    }

    return next(e)
  })

  const ui = await $.ui.mount(message(REPLY))

  expect(await drawnInOrder(ui)).toEqual([`Text: engine: ${REPLY}`])
  await ui.unmount()
})

test('two identical blocks render once and both draw', async ($, on) => {
  engineDraws(on)
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/me', TERM_PROGRAM: 'ghostty' })
  const pngs = new Set<string>()
  const renders: string[][] = []
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: DATA } }))
  on('config.list', () => ({ value: [] }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', (_, e) => ({ value: pngs.has(e.path) }))
  on('fs.read', () => ({ value: { base64: PNG_HEADER } }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    const ok = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    if (argv.includes('--size')) return { value: { ...ok, stdout: '{"width":400,"height":200}' } }
    const out = argv.indexOf('-o')
    if (out !== -1) {
      renders.push(argv)
      pngs.add(argv[out + 1] ?? '')
    }

    return { value: ok }
  })
  const twice = `${REPLY}\n\nAgain:\n\n${FENCE}`
  on('session.messages', () => ({ value: [{ role: 'assistant', text: twice, toolUses: [] }] }))
  on('command.register', () => ({ value: { command: 'mermaid-source' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  expect(renders).toHaveLength(1)
  expect(renders[0]).toEqual(expect.arrayContaining(['-o', PNG, '-t', 'dark']))
  const ui = await $.ui.mount(message(twice))
  expect(await ui.findAll({ type: 'Image' })).toHaveLength(2)
  await ui.unmount()
})

test('a renderer error leaves the source and logs at debug level', async ($, on) => {
  engineDraws(on)
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/me', TERM_PROGRAM: 'ghostty' })
  const logged: string[] = []
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: DATA } }))
  on('config.list', () => ({ value: [] }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', (_, e) => {
    const failed = { exitCode: 1, stdout: '', stderr: 'error: invalid flowchart edge syntax\n', isStdoutTruncated: false, isStderrTruncated: false }
    if (e.argv.includes('--size')) return { value: failed }

    return { value: { ...failed, exitCode: 0, stderr: '' } }
  })
  on('ui.log', (_, e) => {
    if (e.to === 'debug') logged.push(e.text)

    return { value: undefined }
  })
  on('session.messages', () => ({ value: [{ role: 'assistant', text: REPLY, toolUses: [] }] }))
  on('command.register', () => ({ value: { command: 'mermaid-source' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  expect(logged.some(line => line.includes('invalid flowchart edge syntax'))).toBe(true)
  const ui = await $.ui.mount(message(REPLY))
  expect(await drawnInOrder(ui)).toEqual([`Text: engine: ${REPLY}`])
  await ui.unmount()
})

test('/mermaid-source switches a ready diagram back to source and back', async ($, on) => {
  engineDraws(on)
  seed(on, { [KEY]: { status: 'ready', file: PNG, width: 400, height: 200 } })
  const run = { command: 'mermaid-source', args: '', origin: { kind: 'user' }, presentation: {} } as never

  const first = await $.command.run(run)
  expect(first).toMatchObject({ text: 'Mermaid blocks show their source.' })
  const ui = await $.ui.mount(message(REPLY))
  expect(await drawnInOrder(ui)).toEqual([`Text: engine: ${REPLY}`])
  await ui.unmount()

  const second = await $.command.run(run)
  expect(second).toMatchObject({ text: 'Mermaid blocks show as pictures.' })
  const again = await $.ui.mount(message(REPLY))
  expect(await again.findAll({ type: 'Image' })).toHaveLength(1)
  await again.unmount()
})

test('the enlarge button grows a tall diagram and shrink brings it back', async ($, on) => {
  engineDraws(on)
  // 400 by 2000 pixels is 50 columns and 118 rows at full size, past 60% of 40 rows.
  seed(on, { [KEY]: { status: 'ready', file: PNG, width: 400, height: 2000 } })
  const button = `resize:${KEY}:1`

  const ui = await $.ui.mount(message(REPLY))
  expect((await ui.find({ type: 'Image' }))?.props.rows).toBe(24)
  expect((await ui.find({ key: button }))?.text).toBe('enlarge')
  await ui.press({ key: button })
  await ui.unmount()

  const large = await $.ui.mount(message(REPLY))
  const image = await large.find({ type: 'Image' })
  expect(image?.props.columns).toBe(50)
  expect(image?.props.rows).toBe(118)
  expect((await large.find({ key: button }))?.text).toBe('shrink')
  await large.press({ key: button })
  await large.unmount()

  const again = await $.ui.mount(message(REPLY))
  expect((await again.find({ type: 'Image' }))?.props.rows).toBe(24)
  await again.unmount()
})

test('a diagram that fits at full size draws no enlarge button', async ($, on) => {
  engineDraws(on)
  seed(on, { [KEY]: { status: 'ready', file: PNG, width: 400, height: 200 } })

  const ui = await $.ui.mount(message(REPLY))

  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  await ui.unmount()
})

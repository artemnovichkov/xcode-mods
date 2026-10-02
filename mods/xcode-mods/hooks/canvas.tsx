import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CanvasPreview, CanvasSnapshot } from '../types'

const SERVER = 'xcode'
const PANE = 'xcode-canvas'
const HISTORY = 10
const RENDER_DEBOUNCE_MS = 1500
// Svg markup is capped at 131072 chars; leave room for the wrapper.
const SVG_BUDGET = 128_000
const DESKTOP_WIDTH = 320

const preview = atom({ plugin: 'xcode-mods', key: 'preview' } as const, {
  history: [],
  index: 0,
  rendering: null,
  error: null,
  generation: 0,
})
type RenderOutput = {
  previewSnapshotPath?: string
  displayName?: string
  errors?: { message: string }[]
  renderedDestination?: { deviceModelName?: string; platformName?: string; systemVersion?: string }
}

let renderTimer: { cancel: () => void } | null = null

function parseOutput(structured: unknown, text: string | undefined): RenderOutput | null {
  if (structured && typeof structured === 'object') return structured as RenderOutput
  if (text === undefined) return null
  const start = text.indexOf('{')
  if (start < 0) return null
  try {
    return JSON.parse(text.slice(start)) as RenderOutput
  } catch {
    return null
  }
}

// Xcode errors arrive as '{"type":"error","data":"..."}'.
function errorText(text: string): string {
  try {
    const parsed = JSON.parse(text) as { data?: unknown }
    if (typeof parsed.data === 'string') return parsed.data
  } catch {
    // plain text
  }
  return text
}

async function call<T>($: EngineInterface, tool: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await $.mcp.call(SERVER, tool, args)
  if (res.isError) throw new Error(errorText(res.content.map(c => c.text ?? '').join(' ')) || `${tool} failed`)
  if (res.structuredContent) return res.structuredContent as T
  return JSON.parse(res.content.find(c => c.type === 'text')?.text ?? '{}') as T
}

async function workspaceFor($: EngineInterface, file: string): Promise<string | undefined> {
  const { message } = await call<{ message: string }>($, 'XcodeListWorkspaces')
  const open = [...message.matchAll(/workspaceIdentifier: (\S+), workspacePath: (.+)/g)].map(m => ({
    id: (m[1] ?? '').replace(/,$/, ''),
    dir: (m[2] ?? '').trim().replace(/\/[^/]+\.(xcodeproj|xcworkspace)$/, ''),
  }))
  // Deepest project dir holding the file; a bare name matches projects around or under cwd. Never an unrelated one.
  if (file.startsWith('/')) {
    return open.filter(w => file.startsWith(`${w.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0]?.id
  }
  const cwd = await $.session.cwd()
  return open.find(w => w.dir === cwd || w.dir.startsWith(`${cwd}/`) || cwd.startsWith(`${w.dir}/`))?.id
}

async function pixelSize($: EngineInterface, path: string) {
  const { exitCode, stdout } = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', path])
  if (exitCode !== 0) return { width: 0, height: 0 }
  return {
    width: Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1] ?? 0),
    height: Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1] ?? 0),
  }
}

// Desktop has no Image element: embed a JPEG small enough for an Svg data URI.
async function makeJpeg($: EngineInterface, path: string): Promise<string | null> {
  const out = `${path}.canvas.jpg`
  for (const [side, quality] of [[900, 70], [700, 55], [500, 45]] as const) {
    const { exitCode } = await $.process.run([
      'sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), '-Z', String(side), path, '--out', out,
    ])
    if (exitCode !== 0) return null
    const { base64 } = await $.fs.read(out, { as: 'bytes' })
    if (base64.length <= SVG_BUDGET) return base64
  }
  return null
}

async function addSnapshot($: EngineInterface, output: RenderOutput, source: string | undefined) {
  const path = output.previewSnapshotPath
  if (!path) {
    const msg = output.errors?.map(e => e.message).join('\n') || 'RenderPreview returned no snapshot'
    await update($, preview, (p): CanvasPreview => ({ ...p, rendering: null, error: msg }))
    return
  }
  const [size, jpeg] = await Promise.all([pixelSize($, path), makeJpeg($, path)])
  const dest = output.renderedDestination
  const device = [dest?.deviceModelName, dest?.platformName && `${dest.platformName} ${dest.systemVersion ?? ''}`.trim()]
    .filter(Boolean)
    .join(', ')
  const snap: CanvasSnapshot = { path, name: output.displayName ?? 'Preview', source, device, ...size, jpeg }
  await update($, preview, (p): CanvasPreview => {
    const history = [...p.history.map(s => ({ ...s, jpeg: null })), snap].slice(-HISTORY)
    return {
      history,
      index: history.length - 1,
      rendering: null,
      error: output.errors?.length ? output.errors.map(e => e.message).join('\n') : null,
      generation: p.generation + 1,
    }
  })
}

// RenderPreview wants a path in the Xcode project organization ('App/Sources/View.swift'), not on disk.
// Match by file name (case-insensitive), then by the longest common tail of path components.
async function toProjectPath($: EngineInterface, ws: string | undefined, file: string): Promise<string> {
  const parts = file.toLowerCase().split('/')
  const name = parts.at(-1) ?? ''
  const { matches = [] } = await call<{ matches?: string[] }>($, 'XcodeGlob', {
    pattern: '**/*.swift',
    ...(ws ? { workspaceIdentifier: ws } : {}),
  })
  const score = (m: string) => {
    const mp = m.toLowerCase().split('/')
    let n = 0
    while (n < mp.length && mp[mp.length - 1 - n] === parts[parts.length - 1 - n]) n++
    return n
  }
  const best = matches.filter(m => m.toLowerCase().endsWith(`/${name}`) || m.toLowerCase() === name)
    .sort((a, b) => score(b) - score(a))[0]
  if (!best) throw new Error(`${file.split('/').at(-1)} is not in the Xcode project`)
  return best
}

const CONNECT_TRIES = 20
const CONNECT_MS = 1500

// The xcode server connects after session.start; a /preview typed right away waits for it.
async function untilConnected<T>($: EngineInterface, work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work()
    } catch (err) {
      if (attempt >= CONNECT_TRIES || !/no connected MCP/i.test(String((err as Error).message ?? err))) throw err
      await new Promise<void>(resolve => $.clock.after(CONNECT_MS, resolve))
    }
  }
}

async function renderPreview($: EngineInterface, file: string) {
  await update($, preview, (p): CanvasPreview => ({ ...p, rendering: file, error: null }))
  try {
    await untilConnected($, () => call($, 'XcodeListWorkspaces'))
    const ws = await workspaceFor($, file)
    const source = await toProjectPath($, ws, file)
    const output = await call<RenderOutput>($, 'RenderPreview', {
      sourceFilePath: source,
      ...(ws ? { workspaceIdentifier: ws } : {}),
    })
    await addSnapshot($, output, source)
  } catch (err) {
    const msg = String((err as Error).message ?? err)
    await update($, preview, (p): CanvasPreview => ({ ...p, rendering: null, error: msg }))
  }
}

async function askAboutSnapshot($: EngineInterface, snap: CanvasSnapshot) {
  await $.prompt.submit({
    text: `Look at this SwiftUI preview of ${snap.name}${snap.source ? ` (${snap.source})` : ''}${snap.device ? ` on ${snap.device}` : ''}: ${snap.path}\nRead the image and review the layout: spacing, alignment, sizing, contrast, anything that looks off. Suggest concrete fixes in the view code.`,
  })
}

async function findPreviewFile($: EngineInterface): Promise<string | null> {
  const cwd = await $.session.cwd()
  const { stdout } = await $.process.run([
    'grep', '-rl', '--include=*.swift', '--exclude-dir=.build', '--exclude-dir=DerivedData',
    '--exclude-dir=.git', '--exclude-dir=Pods', '--exclude-dir=Carthage', '--exclude-dir=node_modules', '#Preview', cwd,
  ])
  const files = stdout.split('\n').filter(Boolean)
  return files.find(f => f.endsWith('/ContentView.swift')) ?? files[0] ?? null
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: 'Canvas' })
}

function fitImage(width: number, height: number, columns: number, rows: number) {
  const ratio = width > 0 && height > 0 ? height / width : 2
  let c = Math.max(4, columns)
  // A cell is about twice as tall as it is wide.
  let r = Math.round((c * ratio) / 2)
  if (r > rows) {
    r = Math.max(4, rows)
    c = Math.max(4, Math.round((r * 2) / ratio))
  }
  return { columns: c, rows: Math.min(255, r) }
}

// /preview is registered in build.tsx setup, only where cwd holds an Xcode project.
export const register: Register = on => {
  on('command.run', { command: 'preview' }, async ($, e) => {
    // Accept '@'-mentions, cwd-relative and bare names; relative paths become absolute for workspaceFor.
    const arg = e.args.trim().replace(/^@/, '')
    const cwd = await $.session.cwd()
    const file = (arg.includes('/') && !arg.startsWith('/') ? `${cwd}/${arg}` : arg) || (await findPreviewFile($))
    if (!file) return { text: 'No Swift file with #Preview found.' }
    await openPane($)
    void renderPreview($, file)
    return { text: `Rendering ${file.split('/').at(-1)}…` }
  })

  // Agent-rendered previews land in the history too.
  on('tool.call', { tool: 'mcp__xcode__RenderPreview' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const output = parseOutput((ran.result as { structuredContent?: unknown } | undefined)?.structuredContent, ran.text)
    if (output) {
      await addSnapshot($, output, e.sourceFilePath as string | undefined)
      const opened = await $.ui.open({ id: PANE, title: 'Canvas' })
      if (!opened.isPlaced) $.ui.toast('Preview ready: /preview to show')
    }
    return ran
  })

  // Re-render after the model edits a Swift file with #Preview, once previews are in use.
  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const ran = await next(e)
    const file = (e as { file_path?: string }).file_path
    if (ran.deny !== undefined || ran.isError === true || !file?.endsWith('.swift')) return ran
    if ((await read($, preview)).history.length === 0) return ran
    try {
      if (!(await $.fs.read(file)).includes('#Preview')) return ran
    } catch {
      return ran
    }
    renderTimer?.cancel()
    renderTimer = $.clock.after(RENDER_DEBOUNCE_MS, () => void renderPreview($, file))
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const p = await read($, preview)
    const columns = Math.max(10, e.props.bodyColumns - 2)
    const rows = Math.max(6, (e.viewport?.rows ?? 40) - 9)

    const snap = p.history[p.index]
    const status = p.rendering ? (
      <Text color="yellow">◐ Rendering {p.rendering.split('/').at(-1)}…</Text>
    ) : null
    if (!snap) {
      return (
        <Box flexDirection="column">
          {status ?? <Text dimColor>No preview yet. /preview [file.swift]</Text>}
          {p.error && <Text color="red">{p.error}</Text>}
        </Box>
      )
    }
    const caption = (
      <Text dimColor wrap="truncate-end">
        {snap.name}{snap.device ? ` · ${snap.device}` : ''} · {p.index + 1}/{p.history.length}
      </Text>
    )
    const controls = (
      // Two rows, not flexWrap: wrapped rows lose mouse hit-testing.
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          {snap.source && <Button key="rerender" label="↻ Re-render (r)" hotkey="r" variant="primary" onPress={() => void renderPreview($, snap.source!)} />}
          <Button key="ask" label="✦ Ask Claude (x)" hotkey="x" onPress={() => void askAboutSnapshot($, snap)} />
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button key="prev" label="◀ (h)" hotkey="h" onPress={() => void update($, preview, (v): CanvasPreview => ({ ...v, index: Math.max(0, v.index - 1) }))} />
          <Button key="next" label="▶ (l)" hotkey="l" onPress={() => void update($, preview, (v): CanvasPreview => ({ ...v, index: Math.min(v.history.length - 1, v.index + 1) }))} />
          <Button key="open" label="Open (o)" hotkey="o" onPress={() => void $.process.run(['open', snap.path])} />
        </Box>
      </Box>
    )

    let image
    if (e.surface === 'terminal') {
      const { Image } = $.ui.resolve(e)
      const box = fitImage(snap.width, snap.height, columns, rows)
      image = (
        <Image key="snapshot" source={{ file: snap.path, format: 'png', generation: p.generation * 100 + p.index }}
          columns={box.columns} rows={box.rows} alt={`${snap.name} preview (needs kitty/Ghostty): ${snap.path}`} />
      )
    } else if (e.surface !== 'mobile' && snap.jpeg) {
      const { Svg } = $.ui.resolve(e)
      const width = DESKTOP_WIDTH
      const height = snap.width > 0 ? Math.round((width * snap.height) / snap.width) : Math.round(width * 2)
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
        `<image href="data:image/jpeg;base64,${snap.jpeg}" width="${width}" height="${height}"/></svg>`
      image = <Svg source={svg} alt={`${snap.name} preview`} width={width} height={height} />
    } else {
      image = <Text dimColor>{snap.path}</Text>
    }

    return (
      <Box flexDirection="column">
        {caption}
        {controls}
        {status}
        {p.error && <Text color="red">{p.error}</Text>}
        {image}
      </Box>
    )
  })
}

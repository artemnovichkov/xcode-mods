import { expect, mock, test } from 'claude-code/testing'

const FILE = 'App/App/ContentView.swift'
const SNAP = '/tmp/snap.png'

const answers: Record<string, unknown> = {
  XcodeListWorkspaces: { message: '* workspaceIdentifier: workspace-1, workspacePath: /tmp/App/App.xcodeproj' },
  XcodeGlob: { matches: ['App/App/ContentView.swift', 'Other/ContentView.swift'] },
  RenderPreview: {
    previewSnapshotPath: SNAP,
    displayName: 'ContentView',
    errors: [],
    renderedDestination: { deviceModelName: 'iPhone Duo', platformName: 'iOS', systemVersion: '27.1' },
  },
}

const PANE_PROPS = { title: 'Canvas', isFocused: true, bodyColumns: 60 } as never

for (const surface of ['terminal', 'desktop'] as const) {
  test(`/preview renders into history (${surface})`, async ($, on) => {
    const clock = mock.clock(on)
    const args: Record<string, unknown>[] = []
    on('session.cwd', () => ({ value: '/tmp/App' }))
    on('mcp.call', ($, e) => {
      if (e.tool === 'RenderPreview') args.push(e.args)
      return { value: { content: [], isError: false, structuredContent: answers[e.tool] } }
    })
    on('process.run', () => ({
      value: { exitCode: 0, stdout: 'pixelWidth: 100\npixelHeight: 200', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    on('fs.read', () => ({ value: { base64: 'AAAA' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))

    const pane = await $.ui.mount({ plugin: 'xcode-mods', surface, component: 'Pane', requestId: 'xcode-canvas', props: PANE_PROPS })
    await $.command.run({ command: 'preview', args: '/tmp/App/App/ContentView.swift' } as never)
    await clock.advance(10)

    expect(args[0]).toEqual({ sourceFilePath: FILE, workspaceIdentifier: 'workspace-1' })
    expect(await pane.find({ text: /ContentView · iPhone Duo, iOS 27.1 · 1\/1/ })).toBeDefined()
  })
}

for (const input of ['@App/ContentView.swift', 'contentview.swift', 'App/ContentView.swift']) {
  test(`/preview resolves '${input}' to the project path`, async ($, on) => {
    const clock = mock.clock(on)
    const args: Record<string, unknown>[] = []
    on('session.cwd', () => ({ value: '/tmp/App' }))
    on('mcp.call', ($, e) => {
      if (e.tool === 'RenderPreview') args.push(e.args)
      return { value: { content: [], isError: false, structuredContent: answers[e.tool] } }
    })
    on('process.run', () => ({
      value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    on('fs.read', () => ({ value: { base64: 'AAAA' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))

    await $.command.run({ command: 'preview', args: input } as never)
    await clock.advance(10)

    expect(args[0]).toEqual({ sourceFilePath: FILE, workspaceIdentifier: 'workspace-1' })
  })
}

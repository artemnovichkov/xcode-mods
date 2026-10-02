import { expect, mock, test } from 'claude-code/testing'

const BAND_PROPS = { hasSurvey: false } as never
const PANE_PROPS = { title: 'Xcode', isFocused: true, bodyColumns: 80 } as never
const OTHER = '* workspaceIdentifier: workspace-other, workspacePath: /tmp/Other/Other.xcodeproj'
const found = (stdout: string) => () => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})
const ok = (structuredContent: unknown) => ({ value: { content: [], isError: false, structuredContent } })

test('ignores a workspace of another project and opens the one under cwd', async ($, on) => {
  mock.clock(on)
  const calls: { tool: string; args: Record<string, unknown> }[] = []
  on('session.cwd', () => ({ value: '/tmp/App' }))
  on('process.run', found('/tmp/App/App.xcodeproj\n'))
  on('mcp.call', ($, e) => {
    calls.push({ tool: e.tool, args: e.args as Record<string, unknown> })
    if (e.tool === 'XcodeListWorkspaces') return ok({ message: OTHER })
    if (e.tool === 'XcodeOpenWorkspace') return ok({ workspaceIdentifier: 'workspace-app' })
    if (e.tool === 'BuildProject') return ok({ buildResult: 'The project built successfully.', elapsedTime: 1 })
    return ok({ buildIsRunning: false, buildLogEntries: [] })
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))

  const pane = await $.ui.mount({ plugin: 'xcode-mods', surface: 'terminal', component: 'Pane', requestId: 'xcode', props: PANE_PROPS })
  await pane.press({ key: 'run-build' })
  const build = calls.find(c => c.tool === 'BuildProject')
  expect(calls.find(c => c.tool === 'XcodeOpenWorkspace')?.args.path).toBe('/tmp/App/App.xcodeproj')
  expect(build?.args.workspaceIdentifier).toBe('workspace-app')
})

test('outside an Xcode project the band stays empty', async ($, on) => {
  on('session.cwd', () => ({ value: '/tmp/web' }))
  on('process.run', found(''))
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: 'Server xcode not connected' }], isError: true } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.command.run({ command: 'xcode', args: '' } as never)
  // The band passes to the engine (nothing beneath answers in a test) instead of drawing an error.
  const mounted = $.ui.mount({ plugin: 'xcode-mods', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await expect(mounted).rejects.toThrow(/no implementation for ui.render/)
})

test('a stale workspace id is re-resolved once', async ($, on) => {
  mock.clock(on)
  let id = 'workspace-old'
  const builds: unknown[] = []
  on('session.cwd', () => ({ value: '/tmp/App' }))
  on('process.run', found('/tmp/App/App.xcodeproj\n'))
  on('mcp.call', ($, e) => {
    const args = e.args as Record<string, unknown>
    if (e.tool === 'XcodeListWorkspaces') return ok({ message: `* workspaceIdentifier: ${id}, workspacePath: /tmp/App/App.xcodeproj` })
    if (e.tool === 'BuildProject') {
      builds.push(args.workspaceIdentifier)
      if (args.workspaceIdentifier !== id) {
        return { value: { content: [{ type: 'text', text: 'Unknown workspace identifier' }], isError: true } }
      }
      return ok({ buildResult: 'The project built successfully.', elapsedTime: 1 })
    }
    return ok({ buildIsRunning: false, buildLogEntries: [] })
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))

  const pane = await $.ui.mount({ plugin: 'xcode-mods', surface: 'terminal', component: 'Pane', requestId: 'xcode', props: PANE_PROPS })
  await pane.press({ key: 'run-build' })
  id = 'workspace-new' // mcpbridge restarted
  await pane.press({ key: 'run-build' })
  expect(builds).toEqual(['workspace-old', 'workspace-old', 'workspace-new'])
})

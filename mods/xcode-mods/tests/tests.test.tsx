import { expect, mock, test } from 'claude-code/testing'

const WS = 'workspace-test'
const PANE_PROPS = { title: 'Xcode', isFocused: true, bodyColumns: 80 } as never
const T = (id: string) => ({ targetName: 'AppTests', identifier: id, displayName: id.split('/')[1], isEnabled: true })
const R = (id: string, state: string, errorMessages: string[] = []) => ({
  targetName: 'AppTests', identifier: id, displayName: id.split('/')[1], state, errorMessages,
})

const answers: Record<string, unknown> = {
  XcodeListWorkspaces: { message: `* workspaceIdentifier: ${WS}, workspacePath: /tmp/App/App.xcodeproj` },
  XcodeListSchemes: { activeSchemeName: 'App', schemes: [] },
  XcodeListRunDestinations: { activeDestinationDisplayTitle: 'iPhone Duo', destinations: [] },
  GetTestList: { truncated: false, tests: [T('CounterTests/a()'), T('CounterTests/b()')] },
  RunAllTests: {
    summary: '2 tests: 1 passed, 1 failed',
    results: [R('CounterTests/b()', 'Failed', ['Expectation failed: 1 == 2']), R('CounterTests/a()', 'Passed')],
  },
  RunSomeTests: { summary: '1 test: 1 passed', results: [R('CounterTests/b()', 'Passed')] },
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`/tests runs all, shows failure, rerun failed runs only it (${surface})`, async ($, on) => {
    mock.clock(on)
    const calls: { tool: string; args: Record<string, unknown> }[] = []
    on('session.cwd', () => ({ value: '/tmp/App' }))
    on('process.run', () => ({ value: { exitCode: 0, stdout: '/tmp/App/App.xcodeproj\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('mcp.call', ($, e) => {
      calls.push({ tool: e.tool, args: e.args as Record<string, unknown> })
      return { value: { content: [], isError: false, structuredContent: answers[e.tool] } }
    })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const prompts: string[] = []
    on('prompt.submit', ($, e) => {
      prompts.push(e.text)
      return { text: e.text }
    })

    const pane = await $.ui.mount({ plugin: 'xcode-mods', surface, component: 'Pane', requestId: 'xcode', props: PANE_PROPS })
    await $.command.run({ command: 'tests', args: '' } as never)

    expect(await pane.find({ text: /1 passed · 1 failed/ })).toBeDefined()
    expect(await pane.find({ text: /Expectation failed/ })).toBeDefined()

    await pane.press({ key: 'fix-tests' })
    expect(prompts[0]).toMatch(/AppTests\/CounterTests\/b\(\)/)
    expect(prompts[0]).toMatch(/Expectation failed: 1 == 2/)

    await pane.press({ key: 'test-failed' })
    const some = calls.find(c => c.tool === 'RunSomeTests')
    expect(some?.args.tests).toEqual([{ targetName: 'AppTests', testIdentifier: 'CounterTests/b()' }])
    expect(await pane.find({ text: /2 passed · 0 failed/ })).toBeDefined()
  })
}

test('/tests <filter> runs matching tests only', async ($, on) => {
  const clock = mock.clock(on)
  const calls: { tool: string; args: Record<string, unknown> }[] = []
  on('session.cwd', () => ({ value: '/tmp/App' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/tmp/App/App.xcodeproj\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('mcp.call', ($, e) => {
    calls.push({ tool: e.tool, args: e.args as Record<string, unknown> })
    return { value: { content: [], isError: false, structuredContent: answers[e.tool] } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))

  const res = await $.command.run({ command: 'tests', args: 'B()' } as never)
  expect(res.text).toMatch(/Testing 1 test/)
  await clock.advance(10)
  expect(calls.find(c => c.tool === 'RunSomeTests')?.args.tests).toEqual([
    { targetName: 'AppTests', testIdentifier: 'CounterTests/b()' },
  ])
})

test('agent RunAllTests with a text-only result shows the failure', async ($, on) => {
  mock.clock(on)
  on('session.cwd', () => ({ value: '/tmp/App' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/tmp/App/App.xcodeproj\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('mcp.call', ($, e) => ({ value: { content: [], isError: false, structuredContent: answers[e.tool] } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // Core hands MCP results to tool.call hooks as text; structuredContent may be gone.
  on('tool.call', () => ({ result: 'ok', text: JSON.stringify(answers.RunAllTests) }) as never)

  const pane = await $.ui.mount({ plugin: 'xcode-mods', surface: 'terminal', component: 'Pane', requestId: 'xcode', props: PANE_PROPS })
  await $.tool.call({ tool: 'mcp__xcode__RunAllTests', workspaceIdentifier: WS } as never)

  expect(await pane.find({ text: /1 passed · 1 failed/ })).toBeDefined()
})

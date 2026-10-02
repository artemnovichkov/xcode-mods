import { expect, mock, test } from 'claude-code/testing'

const WS = 'workspace-test'
const PANE_PROPS = { title: 'Xcode', isFocused: true, bodyColumns: 80 } as never

for (const surface of ['terminal', 'desktop'] as const) {
  test(`/run streams console, stop ends it (${surface})`, async ($, on) => {
    const clock = mock.clock(on)
    let state = 'started'
    const calls: string[] = []
    const answers: Record<string, () => unknown> = {
      XcodeListWorkspaces: () => ({ message: `* workspaceIdentifier: ${WS}, workspacePath: /tmp/App/App.xcodeproj` }),
      XcodeListSchemes: () => ({ activeSchemeName: 'App', schemes: [] }),
      XcodeListRunDestinations: () => ({ activeDestinationDisplayTitle: 'iPhone Duo', destinations: [] }),
      RunProject: () => ({ runResult: 'The app was launched successfully.', buildErrors: [], launchSessionReference: 'ref1', processIdentifier: 42 }),
      GetConsoleOutput: () => ({
        launchSessionInfo: `Launch Session: App, ref: ref1, PID: 42, State: ${state}`,
        totalCount: 2,
        units: [
          { content: 'hello from print\n', kind: 'stdio', timestamp: 1 },
          { content: '2026-10-02 11:42:44.239440+0500 [42:7] Counter broke\n', kind: 'oslog', severity: 'error', timestamp: 2 },
        ],
      }),
      StopProject: () => {
        state = 'expired'
        return { stopResult: 'The app was stopped.' }
      },
    }
    on('session.cwd', () => ({ value: '/tmp/App' }))
    on('process.run', () => ({ value: { exitCode: 0, stdout: '/tmp/App/App.xcodeproj\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('mcp.call', ($, e) => {
      calls.push(e.tool)
      return { value: { content: [], isError: false, structuredContent: answers[e.tool]?.() } }
    })
    on('ui.open', () => ({ value: { isPlaced: true } }))

    const pane = await $.ui.mount({ plugin: 'xcode-mods', surface, component: 'Pane', requestId: 'xcode', props: PANE_PROPS })
    await $.command.run({ command: 'run', args: '' } as never)
    await clock.advance(1100)

    expect(await pane.find({ text: /on iPhone Duo · PID 42/ })).toBeDefined()
    expect(await pane.find({ text: /11:42:44 Counter broke/ })).toBeDefined()
    expect(await pane.find({ text: /hello from print/ })).toBeDefined()

    await pane.press({ key: 'console-errors' })
    expect(await pane.find({ text: /hello from print/ })).toBeUndefined()

    await pane.press({ key: 'app-stop' })
    expect(calls).toContain('StopProject')
    expect(await pane.find({ text: /▶ Run/ })).toBeDefined()
  })
}

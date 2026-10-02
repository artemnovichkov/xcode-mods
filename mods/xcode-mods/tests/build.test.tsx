import { expect, mock, test } from 'claude-code/testing'

const WS = 'workspace-test'
const PATH = '/tmp/App/App.xcodeproj'
const WARNING = { severity: 'warning', message: 'unused value', path: '/tmp/App/A.swift', line: 5 }

const answers: Record<string, unknown> = {
  XcodeListWorkspaces: { message: `* workspaceIdentifier: ${WS}, workspacePath: ${PATH}` },
  XcodeListSchemes: { activeSchemeName: 'App', schemes: [{ disambiguatedName: 'App' }] },
  XcodeListRunDestinations: { activeDestinationDisplayTitle: 'iPhone Duo', destinations: [{ displayTitle: 'iPhone Duo' }] },
  BuildProject: { buildResult: 'The project built successfully.', elapsedTime: 1.5, errors: [], fullLogPath: '/tmp/log' },
  GetBuildLog: {
    buildIsRunning: false,
    buildResult: 'The build succeeded',
    buildLogEntries: [{ buildTask: 'Compile A.swift', emittedIssues: [WARNING] }],
  },
}

const BAND_PROPS = { hasSurvey: false } as never
const PANE_PROPS = { title: 'Xcode', isFocused: true, bodyColumns: 80 } as never

for (const surface of ['terminal', 'desktop'] as const) {
  test(`build from pane shows result and issues (${surface})`, async ($, on) => {
    mock.clock(on)
    const calls: string[] = []
    on('session.cwd', () => ({ value: '/tmp/App' }))
    on('process.run', () => ({ value: { exitCode: 0, stdout: '/tmp/App/App.xcodeproj\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('mcp.call', ($, e) => {
      calls.push(e.tool)
      return { value: { content: [], isError: false, structuredContent: answers[e.tool] } }
    })

    const pane = await $.ui.mount({ plugin: 'xcode-mods', surface, component: 'Pane', requestId: 'xcode', props: PANE_PROPS })
    await pane.press({ key: 'run-build' })

    expect(calls).toContain('BuildProject')
    expect(await pane.find({ text: /1 task · 1\.5s/ })).toBeDefined()

    expect(await pane.find({ text: /unused value/ })).toBeDefined()

    const band = await $.ui.mount({ plugin: 'xcode-mods', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect(await band.find({ text: /✓ Build Succeeded 1\.5s · \d\d:\d\d/ })).toBeDefined()
    expect(await band.find({ text: /⚠1/ })).toBeDefined()
  })
}

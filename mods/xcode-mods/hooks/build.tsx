import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { XcodeBuild, XcodeConsoleLine, XcodeIssue, XcodeRun, XcodeTab, XcodeTarget, XcodeTest, XcodeTests, XcodeTestState } from '../types'

const SERVER = 'xcode'
const PANE = 'xcode'
const POLL_MS = 500
const CONSOLE_MS = 1000
const CONSOLE_TAIL = 300

const IDLE: XcodeBuild = { status: 'idle', startedAt: 0, tasks: 0, issues: [] }
const NO_RUN: XcodeRun = { status: 'idle', lines: [], total: 0, clearedAt: 0, isErrorsOnly: false }
const NO_TESTS: XcodeTests = { status: 'idle', startedAt: 0, tests: [] }

const build = atom({ plugin: 'xcode-mods', key: 'build' } as const, IDLE)
const target = atom({ plugin: 'xcode-mods', key: 'target' } as const, null)
const tab = atom({ plugin: 'xcode-mods', key: 'tab' } as const, 'build')
const tests = atom({ plugin: 'xcode-mods', key: 'tests' } as const, NO_TESTS)
const run = atom({ plugin: 'xcode-mods', key: 'run' } as const, NO_RUN)
const error = atom({ plugin: 'xcode-mods', key: 'error' } as const, null)

type BuildLog = {
  buildIsRunning?: boolean
  buildResult?: string
  totalFound?: number
  buildLogEntries?: { buildTask?: string; emittedIssues: XcodeIssue[] }[]
}

type BuildResult = {
  buildResult?: string
  elapsedTime?: number
  errors?: { classification: string; message: string; filePath?: string; lineNumber?: number }[]
}

type TestList = {
  truncated?: boolean
  fullTestListPath?: string
  tests?: { targetName: string; identifier: string; displayName: string; isEnabled: boolean }[]
}

type TestRun = {
  summary?: string
  counts?: { failed: number }
  results?: { targetName: string; identifier: string; displayName: string; state: string; errorMessages: string[] }[]
}

type RunResult = {
  runResult?: string
  buildErrors?: { classification: string; message: string }[]
  launchSessionReference?: string
  processIdentifier?: number
}

type ConsoleOutput = {
  launchSessionInfo?: string
  totalCount?: number
  units?: { content: string; kind: string; severity?: string; timestamp: number }[]
}

type TestSpec = { targetName: string; testIdentifier: string }

async function call<T>($: EngineInterface, tool: string, args: Record<string, unknown> = {}, isRetry = false): Promise<T> {
  const res = await $.mcp.call(SERVER, tool, args)
  if (res.isError) {
    const msg = res.content.map(c => c.text ?? '').join(' ') || `${tool} failed`
    // A restarted mcpbridge forgets workspace ids: resolve a fresh one and retry once.
    if (!isRetry && typeof args.workspaceIdentifier === 'string' && /unknown workspace/i.test(msg)) {
      const t = await refreshTarget($)
      if (t) return call<T>($, tool, { ...args, workspaceIdentifier: t.workspace }, true)
    }
    throw new Error(msg)
  }
  if (res.structuredContent) return res.structuredContent as T
  const text = res.content.find(c => c.type === 'text')?.text ?? '{}'
  return JSON.parse(text) as T
}

const contains = (dir: string, path: string) => path === dir || path.startsWith(`${dir}/`)
const dirOf = (path: string) => path.replace(/\/[^/]+$/, '')

async function findProject($: EngineInterface, cwd: string): Promise<string | null> {
  const found = await $.process.run([
    'find', cwd, '-maxdepth', '3', '(', '-name', '*.xcworkspace', '-o', '-name', '*.xcodeproj', ')',
    '-not', '-path', '*/.build/*', '-not', '-path', '*.xcodeproj/*', '-not', '-path', '*/Pods/*',
  ])
  // Shallowest first; at the same depth a workspace wraps its project (CocoaPods).
  const rank = (p: string) => p.split('/').length * 2 - (p.endsWith('.xcworkspace') ? 1 : 0)
  return found.stdout.split('\n').filter(Boolean).sort((a, b) => rank(a) - rank(b))[0] ?? null
}

// Workspace id comes from XcodeListWorkspaces (abs path not accepted). Only a workspace around or under cwd counts;
// otherwise opens the project found under cwd. Null: not an Xcode project, stay quiet.
async function resolveWorkspace($: EngineInterface): Promise<{ id: string; path: string } | null> {
  const cwd = await $.session.cwd()
  const local = await findProject($, cwd)
  let open: { id: string; path: string }[]
  try {
    const { message } = await call<{ message: string }>($, 'XcodeListWorkspaces')
    open = [...message.matchAll(/workspaceIdentifier: (\S+), workspacePath: (.+)/g)].map(m => ({
      id: (m[1] ?? '').replace(/,$/, ''),
      path: (m[2] ?? '').trim(),
    }))
  } catch (err) {
    if (!local) return null
    throw err
  }
  const mine =
    open.find(w => w.path === local) ??
    open.find(w => contains(cwd, w.path)) ??
    open.find(w => contains(dirOf(w.path), cwd))
  if (mine) return mine
  if (!local) return null
  const opened = await call<{ workspaceIdentifier: string }>($, 'XcodeOpenWorkspace', { path: local })
  return { id: opened.workspaceIdentifier, path: local }
}

const CONNECT_TRIES = 20
const CONNECT_MS = 1500

const isNotConnected = (msg: string | null) => msg !== null && /no connected MCP/i.test(msg)

async function refreshTarget($: EngineInterface): Promise<XcodeTarget | null> {
  try {
    const ws = await resolveWorkspace($)
    if (!ws) {
      await update($, target, () => null)
      await update($, error, () => null)
      return null
    }
    const [schemes, dests] = await Promise.all([
      call<{ activeSchemeName?: string; schemes?: { disambiguatedName: string }[] }>($, 'XcodeListSchemes', {
        workspaceIdentifier: ws.id,
      }),
      call<{ activeDestinationDisplayTitle?: string; destinations?: { displayTitle: string }[] }>(
        $,
        'XcodeListRunDestinations',
        { workspaceIdentifier: ws.id },
        true,
      ),
    ])
    const next: XcodeTarget = {
      workspace: ws.id,
      path: ws.path,
      scheme: schemes.activeSchemeName ?? undefined,
      destination: dests.activeDestinationDisplayTitle ?? undefined,
      schemes: (schemes.schemes ?? []).map(s => s.disambiguatedName),
      destinations: (dests.destinations ?? []).map(d => d.displayTitle),
    }
    await update($, target, () => next)
    await update($, error, () => null)
    return next
  } catch (err) {
    await update($, error, () => String((err as Error).message ?? err))
    return null
  }
}

// Errors land in the band; refreshTarget clears them on success.
async function switchTo($: EngineInterface, tool: string, args: Record<string, unknown>) {
  try {
    await call($, tool, args)
    await refreshTarget($)
  } catch (err) {
    await update($, error, () => `Switch failed: ${String((err as Error).message ?? err)}`)
  }
}

// A command typed before the xcode server connects waits for it.
async function workspaceId($: EngineInterface): Promise<string | null> {
  const known = await read($, target)
  if (known) return known.workspace
  for (let attempt = 1; ; attempt++) {
    const t = await refreshTarget($)
    if (t || attempt >= CONNECT_TRIES || !isNotConnected(await read($, error))) return t?.workspace ?? null
    await new Promise<void>(resolve => $.clock.after(CONNECT_MS, resolve))
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function issuesOf(log: BuildLog): XcodeIssue[] {
  return (log.buildLogEntries ?? [])
    .flatMap(entry => entry.emittedIssues)
    .filter(i => i.severity === 'error' || i.severity === 'warning')
}

let poll: { cancel: () => void } | null = null
let isPolling = false

async function pollOnce($: EngineInterface, ws: string) {
  if (isPolling) return
  isPolling = true
  try {
    const log = await call<BuildLog>($, 'GetBuildLog', {
      workspaceIdentifier: ws,
      severity: 'remark',
      pattern: '.',
    })
    if (!log.buildIsRunning) return
    const entries = log.buildLogEntries ?? []
    await update($, build, b =>
      b.status === 'running'
        ? { ...b, task: entries.at(-1)?.buildTask, tasks: log.totalFound ?? entries.length, issues: issuesOf(log) }
        : b,
    )
  } catch {
    // build log not ready yet
  } finally {
    isPolling = false
  }
}

async function start($: EngineInterface, ws: string) {
  const now = await $.clock.now()
  await update($, build, (): XcodeBuild => ({ status: 'running', startedAt: now, tasks: 0, issues: [] }))
  poll?.cancel()
  poll = $.clock.every(POLL_MS, () => void pollOnce($, ws))
}

async function finish($: EngineInterface, ws: string, result: BuildResult | null, failure?: string) {
  poll?.cancel()
  poll = null
  let issues: XcodeIssue[] = []
  let tasks: number | undefined
  try {
    const log = await call<BuildLog>($, 'GetBuildLog', { workspaceIdentifier: ws, severity: 'remark', pattern: '.' })
    issues = issuesOf(log)
    tasks = log.totalFound ?? log.buildLogEntries?.length
  } catch {
    issues = (result?.errors ?? []).map(e => ({
      severity: e.classification,
      message: e.message,
      path: e.filePath,
      line: e.lineNumber,
    }))
  }
  const errors = issues.filter(i => i.severity === 'error').length
  const isOk = !failure && errors === 0 && !/fail/i.test(result?.buildResult ?? '')
  const now = await $.clock.now()
  await update($, build, (b): XcodeBuild => ({
    ...b,
    status: isOk ? 'succeeded' : 'failed',
    finishedAt: now,
    elapsed: result?.elapsedTime ?? (now - b.startedAt) / 1000,
    task: undefined,
    tasks: tasks ?? b.tasks,
    issues,
    result: failure ?? result?.buildResult,
  }))
  const warnings = issues.length - errors
  $.ui.toast(
    isOk
      ? `Build Succeeded${warnings ? ` · ${warnings} warning${warnings > 1 ? 's' : ''}` : ''}`
      : `Build Failed · ${errors} error${errors === 1 ? '' : 's'}`,
  )
  if (!isOk) await update($, tab, () => 'build')
}

async function runBuild($: EngineInterface): Promise<string> {
  if ((await read($, build)).status === 'running') return 'Build already running.'
  const ws = await workspaceId($)
  if (!ws) return 'No Xcode workspace.'
  await start($, ws)
  try {
    const result = await call<BuildResult>($, 'BuildProject', { workspaceIdentifier: ws })
    await finish($, ws, result)
    return result.buildResult ?? 'Build finished.'
  } catch (err) {
    const msg = String((err as Error).message ?? err)
    await finish($, ws, null, msg)
    return msg
  }
}

const testKey = (t: { target: string; id: string }) => `${t.target}/${t.id}`

function stateOf(state: string): XcodeTestState {
  if (/expected/i.test(state) || /pass/i.test(state)) return 'passed'
  if (/fail/i.test(state)) return 'failed'
  return 'skipped'
}

// GetTestList caps `tests` at 100; the full list is a TEST_TARGET/TEST_IDENTIFIER/... text file.
function parseTestFile(text: string): XcodeTest[] {
  return text.split(/^-{20,}$/m).flatMap(block => {
    const field = (k: string) => new RegExp(`^${k}: (.*)$`, 'm').exec(block)?.[1]?.trim()
    const target = field('TEST_TARGET')
    const id = field('TEST_IDENTIFIER')
    if (!target || !id || field('TEST_ENABLED') === 'false') return []
    return [{ target, id, name: field('TEST_DISPLAY_NAME') ?? id, state: 'idle' as const, errors: [] }]
  })
}

async function loadTests($: EngineInterface): Promise<XcodeTest[]> {
  const ws = await workspaceId($)
  if (!ws) throw new Error('No Xcode workspace.')
  const list = await call<TestList>($, 'GetTestList', { workspaceIdentifier: ws })
  let found: XcodeTest[] = (list.tests ?? [])
    .filter(t => t.isEnabled)
    .map(t => ({ target: t.targetName, id: t.identifier, name: t.displayName, state: 'idle', errors: [] }))
  if (list.truncated && list.fullTestListPath) {
    try {
      found = parseTestFile(await $.fs.read(list.fullTestListPath))
    } catch {
      // keep the first 100
    }
  }
  // Keep known results for tests that still exist.
  const prev = new Map((await read($, tests)).tests.map(t => [testKey(t), t]))
  const merged = found.map(t => {
    const old = prev.get(testKey(t))
    return old ? { ...t, state: old.state, errors: old.errors } : t
  })
  await update($, tests, (v): XcodeTests => ({ ...v, tests: merged }))
  return merged
}

let testTick: { cancel: () => void } | null = null

async function startTests($: EngineInterface, only: TestSpec[] | null) {
  // No progress to poll: tick so the band's timer moves.
  testTick?.cancel()
  testTick = $.clock.every(1000, () => void update($, tests, (v): XcodeTests => ({ ...v })))
  const now = await $.clock.now()
  const picked = only && new Set(only.map(s => `${s.targetName}/${s.testIdentifier}`))
  await update($, tests, (v): XcodeTests => ({
    ...v,
    status: 'running',
    startedAt: now,
    elapsed: undefined,
    error: undefined,
    tests: v.tests.map(t => (!picked || picked.has(testKey(t)) ? { ...t, state: 'running', errors: [] } : t)),
  }))
}

async function finishTests($: EngineInterface, run: TestRun | null, failure?: string) {
  testTick?.cancel()
  testTick = null
  const now = await $.clock.now()
  const results = new Map((run?.results ?? []).map(r => [`${r.targetName}/${r.identifier}`, r]))
  const v = await update($, tests, (v): XcodeTests => {
    const known = new Set(v.tests.map(testKey))
    const added: XcodeTest[] = [...results.values()]
      .filter(r => !known.has(`${r.targetName}/${r.identifier}`))
      .map(r => ({ target: r.targetName, id: r.identifier, name: r.displayName, state: 'idle', errors: [] }))
    const list = [...v.tests, ...added].map(t => {
      const r = results.get(testKey(t))
      if (r) return { ...t, state: stateOf(r.state), errors: r.errorMessages }
      // Results are capped at 100, failures first: an unlisted running test passed.
      return t.state === 'running' ? { ...t, state: failure ? 'idle' : 'passed', errors: [] } : t
    }) as XcodeTest[]
    const failed = list.some(t => t.state === 'failed')
    return {
      ...v,
      status: failure || failed ? 'failed' : 'passed',
      finishedAt: now,
      elapsed: (now - v.startedAt) / 1000,
      tests: list,
      summary: run?.summary,
      error: failure,
    }
  })
  const failed = v.tests.filter(t => t.state === 'failed').length
  const passed = v.tests.filter(t => t.state === 'passed').length
  $.ui.toast(failure ? `Tests failed to run: ${failure}` : failed ? `Tests Failed · ${failed} failed` : `Tests Passed · ${passed}`)
}

async function runTests($: EngineInterface, only: TestSpec[] | null): Promise<string> {
  if ((await read($, tests)).status === 'running') return 'Tests already running.'
  const ws = await workspaceId($)
  if (!ws) return 'No Xcode workspace.'
  await startTests($, only)
  try {
    const run = only
      ? await call<TestRun>($, 'RunSomeTests', { workspaceIdentifier: ws, tests: only })
      : await call<TestRun>($, 'RunAllTests', { workspaceIdentifier: ws })
    await finishTests($, run)
    return run.summary ?? 'Tests finished.'
  } catch (err) {
    const msg = String((err as Error).message ?? err)
    await finishTests($, null, msg)
    return msg
  }
}

const specOf = (t: XcodeTest): TestSpec => ({ targetName: t.target, testIdentifier: t.id })

async function rerunFailed($: EngineInterface) {
  const failed = (await read($, tests)).tests.filter(t => t.state === 'failed')
  if (failed.length) await runTests($, failed.map(specOf))
}

let consolePoll: { cancel: () => void } | null = null
let isReadingConsole = false

// OSLog lines start with '2026-10-02 11:42:44.239440+0500 [pid:tid] '.
function lineOf(u: { content: string; kind: string; severity?: string; timestamp: number }): XcodeConsoleLine {
  const m = /^\d{4}-\d\d-\d\d (\d\d:\d\d:\d\d)\.\d+[+-]\d{4} (?:\[\d+:\d+\] )?/.exec(u.content)
  return {
    kind: u.kind,
    severity: u.severity,
    time: m?.[1],
    text: (m ? u.content.slice(m[0].length) : u.content).replace(/\n$/, ''),
    timestamp: u.timestamp,
  }
}

async function readConsole($: EngineInterface, ws: string) {
  if (isReadingConsole) return
  isReadingConsole = true
  try {
    const r = await read($, run)
    const out = await call<ConsoleOutput>($, 'GetConsoleOutput', {
      workspaceIdentifier: ws,
      tailLimit: CONSOLE_TAIL,
      ...(r.session ? { launchSessionReference: r.session } : {}),
    })
    // 'Launch Session: Sandbox, ref: 751189f000, PID: 85121, State: started'
    const info = out.launchSessionInfo ?? ''
    const isAlive = /State: (started|running)/i.test(info)
    const now = await $.clock.now()
    await update($, run, (v): XcodeRun => ({
      ...v,
      app: /Launch Session: ([^,]+)/.exec(info)?.[1] ?? v.app,
      lines: (out.units ?? []).map(lineOf),
      total: out.totalCount ?? v.total,
      ...(v.status === 'running' && !isAlive ? { status: 'stopped' as const, finishedAt: now } : {}),
    }))
    if (!isAlive) {
      consolePoll?.cancel()
      consolePoll = null
    }
  } catch {
    // session not ready yet
  } finally {
    isReadingConsole = false
  }
}

async function launched($: EngineInterface, ws: string, result: RunResult | null, failure?: string) {
  const errors = (result?.buildErrors ?? []).filter(e => e.classification === 'error')
  if (failure || errors.length || !result?.launchSessionReference) {
    const now = await $.clock.now()
    await update($, run, (v): XcodeRun => ({
      ...v,
      status: 'failed',
      finishedAt: now,
      error: failure ?? (errors.map(e => e.message).join('\n') || result?.runResult || 'Run failed'),
    }))
    $.ui.toast('Run Failed')
    return
  }
  await update($, run, (v): XcodeRun => ({
    ...v,
    status: 'running',
    session: result.launchSessionReference,
    pid: result.processIdentifier,
    lines: [],
    total: 0,
    clearedAt: 0,
    error: undefined,
  }))
  consolePoll?.cancel()
  consolePoll = $.clock.every(CONSOLE_MS, () => void readConsole($, ws))
  void readConsole($, ws)
}

async function launchApp($: EngineInterface): Promise<string> {
  const status = (await read($, run)).status
  if (status === 'launching') return 'Already launching.'
  const ws = await workspaceId($)
  if (!ws) return 'No Xcode workspace.'
  await update($, run, (v): XcodeRun => ({ ...v, status: 'launching', error: undefined }))
  try {
    const result = await call<RunResult>($, 'RunProject', { workspaceIdentifier: ws })
    await launched($, ws, result)
    return result.runResult ?? 'Launched.'
  } catch (err) {
    const msg = String((err as Error).message ?? err)
    await launched($, ws, null, msg)
    return msg
  }
}

async function stopApp($: EngineInterface): Promise<string> {
  if ((await read($, run)).status !== 'running') return 'Nothing running.'
  const ws = await workspaceId($)
  if (!ws) return 'No Xcode workspace.'
  try {
    const res = await call<{ stopResult?: string }>($, 'StopProject', { workspaceIdentifier: ws })
    await stopped($, ws)
    return res.stopResult ?? 'Stopped.'
  } catch (err) {
    return String((err as Error).message ?? err)
  }
}

async function stopped($: EngineInterface, ws: string) {
  consolePoll?.cancel()
  consolePoll = null
  await readConsole($, ws)
  const now = await $.clock.now()
  await update($, run, (v): XcodeRun => (v.status === 'running' ? { ...v, status: 'stopped', finishedAt: now } : v))
}

const CONSOLE_ASK_LINES = 50

async function askToFixIssues($: EngineInterface) {
  const b = await read($, build)
  const errors = b.issues.filter(i => i.severity === 'error')
  const list = errors.length ? errors : b.issues
  if (list.length === 0) return
  const lines = list.map(i => `- ${i.path ?? '?'}${i.line ? `:${i.line}` : ''}: ${i.severity}: ${i.message}`)
  await $.prompt.submit({
    text: `Fix these Xcode build ${errors.length ? 'errors' : 'warnings'}, then rebuild with BuildProject:\n${lines.join('\n')}`,
  })
}

async function askToFixTests($: EngineInterface) {
  const failed = (await read($, tests)).tests.filter(t => t.state === 'failed')
  if (failed.length === 0) return
  const lines = failed.map(t => `- ${t.target}/${t.id}\n${t.errors.map(m => `  ${m.replace(/\n/g, '\n  ')}`).join('\n')}`)
  await $.prompt.submit({
    text: `These tests fail. Find the cause and fix it (code or test, whichever is wrong), then re-run them with RunSomeTests:\n${lines.join('\n')}`,
  })
}

async function askAboutConsole($: EngineInterface) {
  const r = await read($, run)
  const visible = r.lines.filter(
    l => l.timestamp > r.clearedAt && (!r.isErrorsOnly || l.severity === 'error' || l.severity === 'fault'),
  )
  if (visible.length === 0) return
  const lines = visible
    .slice(-CONSOLE_ASK_LINES)
    .map(l => `${l.time ?? ''} ${l.severity ? `[${l.severity}] ` : ''}${l.text}`.trim())
  await $.prompt.submit({
    text: `Console output of ${r.app ?? 'the app'} (last ${lines.length} lines). Explain what's going on and whether anything here points to a bug in our code; ignore system noise:\n\`\`\`\n${lines.join('\n')}\n\`\`\``,
  })
}

const pad = (n: number) => String(n).padStart(2, '0')
const clockTime = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// The band's one activity slot: what runs now, else the running app, else the latest result.
function activity(b: XcodeBuild, ts: XcodeTests, r: XcodeRun, now: number): { text: string; color?: string } | null {
  const secs = (from: number) => Math.floor((now - from) / 1000)
  if (b.status === 'running') return { text: `◐ Building ${secs(b.startedAt)}s${b.task ? ` · ${b.task}` : ''}`, color: 'yellow' }
  if (ts.status === 'running') return { text: `◐ Testing ${secs(ts.startedAt)}s`, color: 'yellow' }
  if (r.status === 'launching') return { text: '◐ Launching', color: 'yellow' }
  if (r.status === 'running') return { text: `● Running ${r.app ?? 'app'}`, color: 'green' }
  const done = [
    b.finishedAt !== undefined && {
      at: b.finishedAt,
      text: b.status === 'succeeded' ? `✓ Build Succeeded ${b.elapsed?.toFixed(1)}s` : '✗ Build Failed',
      color: b.status === 'succeeded' ? 'green' : 'red',
    },
    ts.finishedAt !== undefined && {
      at: ts.finishedAt,
      text: ts.status === 'passed' ? '✓ Tests Passed' : '✗ Tests Failed',
      color: ts.status === 'passed' ? 'green' : 'red',
    },
    r.finishedAt !== undefined && {
      at: r.finishedAt,
      text: r.status === 'failed' ? '✗ Run Failed' : `■ ${r.app ?? 'App'} stopped`,
      color: r.status === 'failed' ? 'red' : undefined,
    },
  ].filter(x => x !== false) as { at: number; text: string; color?: string }[]
  const last = done.sort((x, y) => y.at - x.at)[0]
  return last ? { text: `${last.text} · ${clockTime(last.at)}`, color: last.color } : null
}

// Commands only where cwd holds an Xcode project, so other sessions stay untouched.
// Commands before the first prompt; the rest waits for the xcode server.
async function setup($: EngineInterface): Promise<boolean> {
  if (!(await findProject($, await $.session.cwd()))) return false
  await $.command.register({ name: 'build', description: 'Build the active Xcode scheme', immediate: true })
  await $.command.register({
    name: 'tests',
    description: 'Run tests of the active scheme (all, or those matching a filter)',
    argumentHint: '[filter]',
    immediate: true,
  })
  // 'run' may clash with a built-in skill; the command.run hook below serves it either way.
  try {
    await $.command.register({ name: 'run', description: 'Build and run the active Xcode scheme', immediate: true })
  } catch {
    // name taken: /run still reaches our hook first
  }
  await $.command.register({ name: 'stop', description: 'Stop the app launched from Xcode', immediate: true })
  await $.command.register({ name: 'xcode', description: 'Open the Xcode pane (Build · Run · Tests)' })
  await $.command.register({
    name: 'preview',
    description: 'Render a SwiftUI #Preview into the Canvas pane',
    argumentHint: '[file.swift]',
    immediate: true,
  })
  // Timers die with the old module on reload; resume console polling.
  if ((await read($, run)).status === 'running') {
    const ws = await workspaceId($)
    if (ws) consolePoll = $.clock.every(CONSOLE_MS, () => void readConsole($, ws))
  }
  return true
}


// The xcode server connects after session.start: retry quietly, then say what's missing.
async function awaitServer($: EngineInterface, attempt = 1) {
  const t = await refreshTarget($)
  if (t || !isNotConnected(await read($, error))) return
  if (attempt < CONNECT_TRIES) {
    $.clock.after(CONNECT_MS, () => void awaitServer($, attempt + 1))
  } else {
    await update($, error, () => 'Xcode MCP server "xcode" not connected: claude mcp add xcode -- xcrun mcpbridge')
  }
}

// An agent's MCP call: structuredContent when core keeps it, else the JSON the tool printed.
function outputOf<T>(ran: { result?: unknown; text?: string }): T | null {
  const sc = (ran.result as { structuredContent?: T } | undefined)?.structuredContent
  if (sc) return sc
  const brace = ran.text?.indexOf('{') ?? -1
  if (!ran.text || brace < 0) return null
  try {
    return JSON.parse(ran.text.slice(brace)) as T
  } catch {
    return null
  }
}

// Agent work shows up like the user's own: pane open on the matching tab (seats from 144 columns when unasked).
function showTab($: EngineInterface, v: XcodeTab) {
  void update($, tab, () => v)
  void $.ui.open({ id: PANE, title: 'Xcode' })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if (await setup($)) void awaitServer($)
    return next(e)
  })

  on('command.run', { command: 'build' }, async $ => {
    void $.ui.open({ id: PANE, title: 'Xcode' })
    await update($, tab, () => 'build')
    void runBuild($)
    return { text: 'Building…' }
  })

  on('command.run', { command: 'tests' }, async ($, e) => {
    void $.ui.open({ id: PANE, title: 'Xcode' })
    await update($, tab, () => 'tests')
    const filter = e.args.trim().toLowerCase()
    if (!filter) {
      void runTests($, null)
      return { text: 'Testing…' }
    }
    let list = (await read($, tests)).tests
    try {
      if (list.length === 0) list = await loadTests($)
    } catch (err) {
      return { text: String((err as Error).message ?? err) }
    }
    const picked = list.filter(t => `${t.target}/${t.id}`.toLowerCase().includes(filter))
    if (picked.length === 0) return { text: `No tests match "${filter}".` }
    void runTests($, picked.map(specOf))
    return { text: `Testing ${plural(picked.length, 'test')}…` }
  })

  on('command.run', { command: 'run' }, async $ => {
    void $.ui.open({ id: PANE, title: 'Xcode' })
    await update($, tab, () => 'run')
    void launchApp($)
    return { text: 'Launching…' }
  })

  on('command.run', { command: 'stop' }, async $ => ({ text: await stopApp($) }))

  on('command.run', { command: 'xcode' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Xcode' })
    void refreshTarget($)
    return { text: 'Xcode pane opened.' }
  })

  // Agent-started builds: same live tracking.
  on('tool.call', { tool: 'mcp__xcode__BuildProject' }, async ($, e, next) => {
    const ws = (e.workspaceIdentifier as string | undefined) ?? (await workspaceId($))
    if (!ws) return next(e)
    showTab($, 'build')
    await start($, ws)
    const ran = await next(e)
    const sc = outputOf<BuildResult>(ran)
    await finish($, ws, sc, ran.deny ?? (ran.isError ? 'Build tool failed' : undefined))
    return ran
  })

  // Agent-started test runs land in the Tests tab too.
  on('tool.call', { tool: ['mcp__xcode__RunAllTests', 'mcp__xcode__RunSomeTests'] }, async ($, e, next) => {
    showTab($, 'tests')
    if ((await read($, tests)).tests.length === 0) {
      try {
        await loadTests($)
      } catch {
        // results still fill the list
      }
    }
    const only = Array.isArray(e.tests) ? (e.tests as TestSpec[]) : null
    await startTests($, only)
    const ran = await next(e)
    const sc = outputOf<TestRun>(ran)
    await finishTests($, sc, ran.deny ?? (ran.isError ? 'Test tool failed' : undefined))
    return ran
  })

  // Agent-started runs stream into the Console tab too.
  on('tool.call', { tool: 'mcp__xcode__RunProject' }, async ($, e, next) => {
    const ws = (e.workspaceIdentifier as string | undefined) ?? (await workspaceId($))
    if (!ws) return next(e)
    showTab($, 'run')
    await update($, run, (v): XcodeRun => ({ ...v, status: 'launching', error: undefined }))
    const ran = await next(e)
    const sc = outputOf<RunResult>(ran)
    await launched($, ws, sc, ran.deny ?? (ran.isError ? 'Run tool failed' : undefined))
    return ran
  })

  on('tool.call', { tool: 'mcp__xcode__StopProject' }, async ($, e, next) => {
    const ran = await next(e)
    const ws = (e.workspaceIdentifier as string | undefined) ?? (await workspaceId($))
    if (ws && ran.deny === undefined) await stopped($, ws)
    return ran
  })

  on('session.end', async ($, e, next) => {
    consolePoll?.cancel()
    poll?.cancel()
    testTick?.cancel()
    return next(e)
  })

  on('tool.call', { tool: ['mcp__xcode__XcodeSwitchScheme', 'mcp__xcode__XcodeSwitchRunDestination', 'mcp__xcode__XcodeSwitchTestPlan'] }, async ($, e, next) => {
    const ran = await next(e)
    void refreshTarget($)
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.surface === 'mobile') return next(e)
    const t = await read($, target)
    const b = await read($, build)
    const err = await read($, error)
    const ts = await read($, tests)
    const r = await read($, run)
    // Still connecting: awaitServer reports if it never does.
    if (!t && (!err || isNotConnected(err))) return next(e)
    const { Box, Text, Select, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    const errors = b.issues.filter(i => i.severity === 'error').length
    const warnings = b.issues.length - errors
    const failedTests = ts.tests.filter(x => x.state === 'failed').length
    const act = activity(b, ts, r, now)
    const openTab = (v: XcodeTab) => async () => {
      await update($, tab, () => v)
      await $.ui.open({ id: PANE, title: 'Xcode' })
    }

    return (
      <Box flexDirection="row" gap={1}>
        <Text dimColor></Text>
        {err && <Text color="red">{err}</Text>}
        {t && (
          <Select
            key="scheme"
            value={t.scheme}
            options={(t.schemes.length ? t.schemes : [t.scheme ?? '—']).map(s => ({ value: s }))}
            onSelect={(v: string) => void switchTo($, 'XcodeSwitchScheme', { workspaceIdentifier: t.workspace, schemeName: v })}
          />
        )}
        {t && <Text dimColor>▸</Text>}
        {t && (
          <Select
            key="destination"
            value={t.destination}
            options={(t.destinations.length ? t.destinations : [t.destination ?? '—']).map(d => ({ value: d }))}
            onSelect={(v: string) =>
              void switchTo($, 'XcodeSwitchRunDestination', { workspaceIdentifier: t.workspace, displayTitle: v })
            }
          />
        )}
        {act && <Text dimColor>│</Text>}
        {act && <Text color={act.color} dimColor={act.color === undefined}>{act.text}</Text>}
        {(errors > 0 || warnings > 0 || failedTests > 0) && <Text dimColor>│</Text>}
        {errors > 0 && <Button key="band-errors" plain label={`⛔${errors}`} onPress={openTab('build')} />}
        {warnings > 0 && <Button key="band-warnings" plain label={`⚠${warnings}`} onPress={openTab('build')} />}
        {failedTests > 0 && <Button key="band-tests" plain label={`✗${failedTests}`} onPress={openTab('tests')} />}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const b = await read($, build)
    const ts = await read($, tests)
    const r = await read($, run)
    const t = await read($, target)
    const stored = await read($, tab)
    // 'issues' was a tab before Build absorbed it.
    const current: XcodeTab = stored === 'tests' ? 'tests' : (stored as string) === 'console' || stored === 'run' ? 'run' : 'build'
    const now = await $.clock.now()
    const room = Math.max(3, (e.viewport?.rows ?? 24) - 8)
    const width = e.props.bodyColumns
    const setTab = (v: XcodeTab) => () => void update($, tab, () => v)
    const errors = b.issues.filter(i => i.severity === 'error')
    const warnings = b.issues.filter(i => i.severity !== 'error')
    const failedTests = ts.tests.filter(t => t.state === 'failed').length

    const badges = [errors.length && `⛔${errors.length}`, warnings.length && `⚠${warnings.length}`].filter(Boolean).join(' ')
    const tabs = (
      <Box flexDirection="row" gap={1}>
        <Button key="tab-build" plain label={`Build${badges ? ` ${badges}` : ''}`} hotkey="1"
          dimColor={current !== 'build'} onPress={setTab('build')} />
        <Text dimColor>│</Text>
        <Button key="tab-run" plain label={`Run${r.status === 'running' ? ' ●' : ''}`} hotkey="2"
          dimColor={current !== 'run'} onPress={setTab('run')} />
        <Text dimColor>│</Text>
        <Button key="tab-tests" plain label={`Tests${failedTests ? ` ✗${failedTests}` : ''}`} hotkey="3"
          dimColor={current !== 'tests'} onPress={setTab('tests')} />
      </Box>
    )

    let actions
    let moreActions
    let body
    if (current === 'tests') {
      if (ts.tests.length === 0 && ts.status === 'idle') {
        void update($, tests, (v): XcodeTests => (v.status === 'idle' ? { ...v, status: 'loading' } : v))
        void loadTests($)
          .then(() => update($, tests, (v): XcodeTests => (v.status === 'loading' ? { ...v, status: 'idle' } : v)))
          .catch(err =>
            update($, tests, (v): XcodeTests => ({ ...v, status: 'idle', error: String((err as Error).message ?? err) })),
          )
      }
      const icon: Record<XcodeTestState, [string, string | undefined]> = {
        idle: ['◇', undefined],
        running: ['◐', 'yellow'],
        passed: ['✓', 'green'],
        failed: ['✗', 'red'],
        skipped: ['⊘', 'gray'],
      }
      // Failed first, then grouped by target and suite (identifier up to the last '/').
      const rows: ({ kind: 'group'; label: string } | { kind: 'test'; test: XcodeTest })[] = []
      let group = ''
      const order = (t: XcodeTest) => (t.state === 'failed' ? 0 : 1)
      for (const t of [...ts.tests].sort((a, b) => order(a) - order(b))) {
        const suite = `${t.target} › ${t.id.split('/').slice(0, -1).join('/') || '—'}`
        if (suite !== group) rows.push({ kind: 'group', label: (group = suite) })
        rows.push({ kind: 'test', test: t })
      }
      const counts = (['passed', 'failed', 'skipped'] as const)
        .map(c => `${ts.tests.filter(t => t.state === c).length} ${c}`)
        .join(' · ')
      actions = (
        <Box flexDirection="row" gap={1}>
          <Button key="test-all" label="▶ Test (t)" hotkey="t" variant="primary" onPress={() => void runTests($, null)} />
          {failedTests > 0 && <Button key="test-failed" label="↻ Failed (f)" hotkey="f" onPress={() => void rerunFailed($)} />}
          <Button key="test-reload" label="Reload (l)" hotkey="l" onPress={() => void loadTests($)} />
        </Box>
      )
      moreActions = failedTests > 0 && (
        <Box flexDirection="row" gap={1}>
          <Button key="fix-tests" label="✦ Fix with Claude (x)" hotkey="x" onPress={() => void askToFixTests($)} />
        </Box>
      )
      body = (
        <Box flexDirection="column">
          {ts.status === 'loading' && <Text dimColor>Loading tests…</Text>}
          {(ts.status === 'passed' || ts.status === 'failed') && (
            <Text dimColor>{counts} · {ts.elapsed?.toFixed(1)}s</Text>
          )}
          {ts.error && <Text color="red" wrap="wrap">{ts.error}</Text>}
          {ts.status !== 'loading' && ts.tests.length === 0 && <Text dimColor>No tests. Press t or /tests.</Text>}
          {rows.slice(0, room).map((row, i) =>
            row.kind === 'group' ? (
              <Text key={`g-${i}`} dimColor wrap="truncate-end">
                {row.label}
              </Text>
            ) : (
              <Box key={`t-${i}`} flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Text color={icon[row.test.state][1]}>  {icon[row.test.state][0]}</Text>
                  <Button key={`run-${testKey(row.test)}`} plain label={row.test.name}
                    onPress={() => void runTests($, [specOf(row.test)])} />
                </Box>
                {row.test.errors.map((m, j) => (
                  <Box key={`e-${i}-${j}`} flexDirection="column" paddingLeft={4}>
                    {m.split('\n').map((line, k) => (
                      <Text key={`l-${k}`} color="red" wrap="wrap">
                        {line.replace(`${row.test.id}: `, '')}
                      </Text>
                    ))}
                  </Box>
                ))}
              </Box>
            ),
          )}
          {rows.length > room && <Text dimColor>…{rows.length - room} more</Text>}
        </Box>
      )
    } else if (current === 'run') {
      const visible = r.lines.filter(
        l => l.timestamp > r.clearedAt && (!r.isErrorsOnly || l.severity === 'error' || l.severity === 'fault'),
      )
      const color = (l: XcodeConsoleLine) =>
        l.severity === 'error' || l.severity === 'fault' ? 'red' : l.kind === 'stdio' ? undefined : 'gray'
      actions = (
        <Box flexDirection="row" gap={1}>
          {r.status === 'running' ? (
            <Button key="app-stop" label="■ Stop (s)" hotkey="s" variant="primary" onPress={() => void stopApp($)} />
          ) : (
            <Button key="app-run" label="▶ Run (r)" hotkey="r" variant="primary" onPress={() => void launchApp($)} />
          )}
          {visible.length > 0 && <Button key="ask-console" label="✦ Ask Claude (x)" hotkey="x" onPress={() => void askAboutConsole($)} />}
        </Box>
      )
      moreActions = (
        <Box flexDirection="row" gap={1}>
          <Button key="console-errors" label={r.isErrorsOnly ? 'Errors only ✓ (e)' : 'Errors only (e)'} hotkey="e"
            onPress={() => void update($, run, (v): XcodeRun => ({ ...v, isErrorsOnly: !v.isErrorsOnly }))} />
          <Button key="console-clear" label="Clear (k)" hotkey="k"
            onPress={() => void update($, run, (v): XcodeRun => ({ ...v, clearedAt: v.lines.at(-1)?.timestamp ?? v.clearedAt }))} />
        </Box>
      )
      body = (
        <Box flexDirection="column">
          {r.status !== 'running' && r.status !== 'launching' && (
            <Text dimColor wrap="wrap">
              Not running. Press r or /run to build and run {t?.scheme ?? 'the app'}
              {t?.destination ? ` on ${t.destination}` : ''}.
            </Text>
          )}
          {r.status === 'running' && (
            <Text dimColor wrap="truncate-end">
              {r.app ?? t?.scheme ?? 'App'}
              {t?.destination ? ` on ${t.destination}` : ''}
              {r.pid !== undefined ? ` · PID ${r.pid}` : ''}
            </Text>
          )}
          {r.status === 'failed' && <Text color="red" wrap="wrap">{r.error}</Text>}
          {visible.length === 0 && (r.status === 'running' || r.status === 'stopped') && <Text dimColor>No output.</Text>}
          {visible.length > room && <Text dimColor>…{visible.length - room} earlier</Text>}
          {visible.slice(-room).map((l, i) => (
            <Text key={`c-${i}`} color={color(l)} wrap="truncate-end">
              {l.time ? `${l.time} ` : ''}
              {l.text}
            </Text>
          ))}
        </Box>
      )
    } else {
      const list = [...errors, ...warnings]
      actions = (
        <Box flexDirection="row" gap={1}>
          <Button key="run-build" label="▶ Build (b)" hotkey="b" variant="primary" onPress={() => void runBuild($)} />
          {list.length > 0 && <Button key="fix-issues" label="✦ Fix with Claude (x)" hotkey="x" onPress={() => void askToFixIssues($)} />}
        </Box>
      )
      const elapsed = b.status === 'running' ? (now - b.startedAt) / 1000 : b.elapsed
      body = (
        <Box flexDirection="column">
          {b.status === 'idle' && <Text dimColor>No build yet. Press b or /build.</Text>}
          {b.status !== 'idle' && (
            <Text dimColor>
              {plural(b.tasks, 'task')} · {elapsed?.toFixed(1)}s
            </Text>
          )}
          {/* BuildProject's result text is written for the model; issues below say it better. */}
          {b.status === 'failed' && b.result && errors.length === 0 && <Text color="red" wrap="wrap">{b.result}</Text>}
          {b.task && (
            <Text wrap="truncate-end">
              {'› '}
              {b.task.slice(0, Math.max(10, width - 4))}
            </Text>
          )}
          {list.slice(0, room).map((issue, i) => {
            const file = issue.path ? issue.path.split('/').at(-1) : undefined
            return (
              <Box key={`issue-${i}`} flexDirection="column" marginTop={i === 0 ? 1 : 0}>
                <Box flexDirection="row" gap={1}>
                  <Text color={issue.severity === 'error' ? 'red' : 'yellow'}>
                    {issue.severity === 'error' ? '⛔' : '⚠'}
                  </Text>
                  {file && issue.path ? (
                    <Button key={`open-${i}`} plain label={`${file}${issue.line ? `:${issue.line}` : ''}`}
                      onPress={() =>
                        void $.process.run(issue.line ? ['xed', '--line', String(issue.line), issue.path!] : ['xed', issue.path!])
                      } />
                  ) : null}
                </Box>
                <Text wrap="wrap">  {issue.message}</Text>
              </Box>
            )
          })}
          {list.length > room && <Text dimColor>…{list.length - room} more</Text>}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {tabs}
        <Box marginTop={1}>{actions}</Box>
        {/* A second button row sits here, not nested in actions: nested rows lose mouse presses. */}
        {moreActions}
        {body}
      </Box>
    )
  })
}

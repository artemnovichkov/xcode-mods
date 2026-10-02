export type XcodeIssue = {
  severity: string
  message: string
  path?: string
  line?: number
}

export type XcodeBuild = {
  status: 'idle' | 'running' | 'succeeded' | 'failed'
  startedAt: number
  elapsed?: number
  /** Clock time the last build ended. */
  finishedAt?: number
  task?: string
  tasks: number
  issues: XcodeIssue[]
  result?: string
}

export type XcodeTarget = {
  workspace: string
  path: string
  scheme?: string
  destination?: string
  schemes: string[]
  destinations: string[]
}

export type XcodeTestState = 'idle' | 'running' | 'passed' | 'failed' | 'skipped'

export type XcodeTest = {
  target: string
  /** XCTestIdentifier: `CounterTests/increments()`. */
  id: string
  name: string
  state: XcodeTestState
  errors: string[]
}

export type XcodeTests = {
  status: 'idle' | 'loading' | 'running' | 'passed' | 'failed'
  startedAt: number
  elapsed?: number
  finishedAt?: number
  tests: XcodeTest[]
  summary?: string
  error?: string
}

export type XcodeConsoleLine = {
  kind: string
  /** OSLog severity: error, fault, info, debug, default. */
  severity?: string
  /** `HH:MM:SS` from the log line, when it has one. */
  time?: string
  text: string
  timestamp: number
}

export type XcodeRun = {
  status: 'idle' | 'launching' | 'running' | 'stopped' | 'failed'
  app?: string
  pid?: number
  session?: string
  lines: XcodeConsoleLine[]
  total: number
  /** Lines at or before this timestamp are hidden (Clear). */
  clearedAt: number
  isErrorsOnly: boolean
  /** Clock time the app stopped or failed to launch. */
  finishedAt?: number
  error?: string
}

export type XcodeTab = 'build' | 'run' | 'tests'

export type CanvasSnapshot = {
  /** Absolute path of the PNG Xcode wrote. */
  path: string
  /** Preview display name (`ContentView`). */
  name: string
  /** Swift file the preview lives in. */
  source?: string
  /** Device the preview rendered on (`iPhone Duo, iOS 27.1`). */
  device: string
  /** PNG pixel size; 0 when unknown. */
  width: number
  height: number
  /** Downscaled JPEG, base64, for surfaces without `Image`; latest snapshot only. */
  jpeg: string | null
}

export type CanvasPreview = {
  history: CanvasSnapshot[]
  /** Index into history being shown. */
  index: number
  /** File being rendered now. */
  rendering: string | null
  error: string | null
  /** Bumps on every new snapshot so the terminal re-reads files. */
  generation: number
}

declare module 'claude-code' {
  interface PluginState {
    'xcode-mods': {
      build: XcodeBuild
      target: XcodeTarget | null
      tests: XcodeTests
      run: XcodeRun
      tab: XcodeTab
      error: string | null
      preview: CanvasPreview
    }
  }
}

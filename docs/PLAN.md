# Plan & research notes

## Goal

Pack of Claude Code mods = "Xcode inside Claude Code" over **headless** Xcode MCP. Terminal: **Ghostty** (kitty graphics → `Image` element works); desktop app works too.

## Target shape

One plugin `xcode-mods`: band above prompt with scheme ▸ destination, pane with tabs **Build · Run · Tests** (`hooks/build.tsx`), **Canvas** pane (`hooks/canvas.tsx`). Was two plugins; merged for one-command install. Commands `/build` `/run` `/tests` `/stop` `/xcode` `/preview` call MCP directly via `$.mcp.call` (no model turn, no tokens).

Order:
1. ✅ **Build + Issues + destination band** → `build.tsx` (`BuildProject`, `GetBuildLog`, `XcodeListSchemes`, `XcodeListRunDestinations`)
2. ✅ **Preview** → `canvas.tsx` (`/preview`, history, auto re-render). Sim Mirror dropped.
3. ✅ **Tests** → tab in `build.tsx` (`GetTestList`, `RunAllTests`, `RunSomeTests`; `/tests [filter]`, rerun failed, run one)
4. ✅ **Console** → tab in `build.tsx` (`RunProject`, `GetConsoleOutput` polled 1s, `StopProject`; `/run`, `/stop`; `/run` clashes with the `run` skill, served via `command.run` hook anyway)
5. **Xcode context in system prompt**: `prompt.compose` section with active scheme, destination, last build/test result + errors → model skips status tool calls, fewer tokens.
6. **`/docs <query>`**: `DocumentationSearch` → Markdown pane.
7. Rest

## Ideas: Xcode features missing in Claude Code

| Xcode | Mod |
|---|---|
| Canvas | Preview pane: show every `RenderPreview` image, history, before/after; auto re-render after `Edit` of `*.swift` with `#Preview` |
| Simulator window | Sim Mirror: `simctl io screenshot` + `$.ui.blit` loop; DeviceInteraction screenshots; Duo hinge angle |
| Activity view | Build pane: poll `GetBuildLog` while `BuildProject` runs, current task, timer, issues as they appear; toast + sound at end |
| Issue Navigator | Issues pane: grouped by file, click → `xed --line N file` |
| Toolbar scheme/destination | band; `Select` → `XcodeSwitchScheme` / `XcodeSwitchRunDestination` |
| Test navigator | Test tree ◇✓✗; buttons "rerun failed" / "run this" → `RunSomeTests` |
| Debug console | Console pane: `GetConsoleOutput` or `simctl log stream` filtered by bundle id |
| Debugger | stack/vars pane, lldb input → `InvokeDebuggerCommand` |
| Organizer Crashes | `GetTopCrashIssues` table, expand stack |

## Ideas: MCP output awkward to read

- `XcodeRead` / `XcodeGrep`: JSON-escaped (`\n`, `\"`) → `ui.render` on `ToolResult`: unescape + `Code` highlight
- `GetTargetBuildSettings`: hundreds of keys → compact + searchable
- `XcodeListRunDestinations`: table grouped like Xcode picker
- `StringCatalogRead`: key × locale matrix, % done
- `GetTestList`: capped at 100, full list in file → read via `$.fs`, tree
- MCP Inspector pane: all xcode tools, args, recent calls raw JSON (useful for xcode-tools-docs)
- Schema watcher: on `mcp.connect` diff tools vs snapshot → toast "new tool in 27.x"

## Fun / later

Xcode Bingo (Clean Build Folder, Reset Package Caches… auto-marked by tool calls), achievements, Xcode-style fake spinner ("Indexing | Processing files 3 of 1"), YOU DIED on red tests, fold-to-approve on iPhone Duo sim, hinge click sounds.

## Facts found

- Mods can't see MCP progress notifications → build progress must come from polling `GetBuildLog` (`buildIsRunning`, `buildLogEntries[].buildTask`, `emittedIssues[]`). Real % not available. Maybe tail `fullLogPath` via `$.fs`.
- `BuildProject` result (structuredContent): `buildResult`, `errors[] {classification, filePath, lineNumber, message}`, `elapsedTime`, `fullLogPath`.
- Headless: tools take `workspaceIdentifier` (id from `XcodeListWorkspaces`; abs path not reliable, see below) instead of `tabIdentifier`. Extra tools: `XcodeOpenWorkspace`, `XcodeListWorkspaces`, `XcodeCloseWorkspace`, `XcodeNewProject`, `XcodeWrite`, `XcodeUpdate`.
- Mod API: `Image` (terminal, kitty/Ghostty), `Code`, `Markdown`, `Select`, `Button`, `Link`; `$.mcp.call(server, tool, args)` → `{content, isError, structuredContent}`; `tool.call` hook on `mcp__xcode__BuildProject` etc.
- Inspiration: cctop (btop-style pane), claude-agent-flow (live tree pane), vercel-deploys (polling), cc-arcade (band games), claude-slots (spinner).

- **Tested 2026-10-02**: `GetBuildLog` answers while `BuildProject` in flight (`buildIsRunning:true`, `buildResult:"The build is still running"`, partial `buildLogEntries`). Raw stdio probe: concurrent JSON-RPC calls OK. Claude's own tool calls serialize, but mods' `$.mcp.call` should not. Incremental Sandbox build ~1.4s → poll ~500ms.
- No `notifications/progress` from `BuildProject` even with `_meta.progressToken`.
- Abs path as `workspaceIdentifier` rejected in fresh `mcpbridge` session ("Unknown workspace identifier") even after `XcodeOpenWorkspace` → use returned `workspaceIdentifier` (e.g. `workspace-nx8i9yJvhe`), or resolve via `XcodeListWorkspaces`.

- Plugin name `xcode-mods`, not `xcode` (avoid clash with MCP server name; unconfirmed if it mattered).
- `hooks.json` takes one module per plugin; `$` is followed only into functions of the same file, never across an import.
- `XcodeListNavigatorIssues` absent in headless 27.2 → issues from `GetBuildLog` (`severity: warning`).
- Mod helpers taking `$` must be top-level functions (validator rule).

- `RenderPreview.sourceFilePath` = path in Xcode project organization (`Sandbox/Sandbox/ContentView.swift`), not disk path → resolve via `XcodeGlob` `**/*.swift`, case-insensitive name match. Errors come as `{"type":"error","data":"..."}` text.
- Test ids: `targetName` + `identifier` (`CounterTests/increments()`); `RunSomeTests` takes `{targetName, testIdentifier}`. Result `state`: `Passed`/`Failed`/…; results capped 100, failures first. Full list file: `TEST_TARGET:`/`TEST_IDENTIFIER:` blocks.
- `GetConsoleOutput.launchSessionInfo`: `Launch Session: Sandbox, ref: 751189f000, PID: 85121, State: started` → `expired` after stop (ref becomes 0). OSLog `content` prefixed `2026-10-02 11:42:44.239440+0500 [pid:tid] `.
- `simctl io <udid> screenshot` ≈1.5s per frame (2007×2853 iPhone Duo). Sim Mirror tried in the Canvas mod, dropped: view-only ~1 fps not useful.

- UX: band = Xcode toolbar (scheme ▸ destination, one activity slot, problem counters); pane = details. Tabs are verbs `Build · Run · Tests` (keys 1-3), `r` = tab's main action, `x` = Claude.

## Open questions

- Does `fullLogPath` get written during build?
- Background poll for builds not started by the agent? (headless → only agent builds, probably skip)

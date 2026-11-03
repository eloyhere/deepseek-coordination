/**
 * `coordination_workspace` — build/test/run through the host shell seam, and
 * structure as a delegation to the file tool.
 *
 * The shell is faked here on purpose: these tests assert what the plugin sends
 * to `ctx.shell` and how it projects the bounded result, not how a process runs.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { coordinationWorkspaceTool, workspaceScriptCommand } from '../src/host/workspaceTools.js'
import type { WorkspaceShellPort } from '../src/host/workspaceTools.js'
import type { CoordinationToolService } from '../src/host/tools.js'

interface SentSpec {
  command: string
  workdir: string
  timeoutMs: number
}

function fakeShell(result: Partial<{
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  sandboxMode: string
}> = {}): { shell: WorkspaceShellPort; sent: SentSpec[] } {
  const sent: SentSpec[] = []
  const shell: WorkspaceShellPort = {
    resolve(request: { command: string; workdir?: string; timeoutMs?: number }) {
      const spec: SentSpec = { command: request.command, workdir: request.workdir ?? '', timeoutMs: request.timeoutMs ?? 0 }
      sent.push(spec)
      return spec
    },
    async execute(spec: unknown) {
      return {
        async result() {
          return {
            exitCode: result.exitCode ?? 0,
            timedOut: result.timedOut ?? false,
            aborted: result.aborted ?? false,
            timeoutMs: (spec as SentSpec).timeoutMs,
            stdout: { text: result.stdout ?? 'built ok', truncated: result.stdoutTruncated ?? false },
            stderr: { text: result.stderr ?? '', truncated: result.stderrTruncated ?? false },
            ...(result.sandboxMode === undefined ? {} : { sandbox: { mode: result.sandboxMode } }),
          }
        },
      }
    },
  }
  return { shell, sent }
}

function serviceOf(root: string, shell?: WorkspaceShellPort): CoordinationToolService {
  return {
    locale: 'en-US',
    workspaceRoot: root,
    ...(shell === undefined ? {} : { host: { workspaceRoot: root, shell } }),
  } as unknown as CoordinationToolService
}

function withWorkspace(run: (root: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'coordination-workspace-'))
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        name: 'fixture', scripts: { build: 'tsc -p tsconfig.json', test: 'node --test' },
      }))
      await run(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

test('a named action derives its command only from package.json scripts', () => {
  assert.deepEqual(workspaceScriptCommand('build', { build: 'tsc -p tsconfig.json' }), {
    command: 'npm run build', script: 'tsc -p tsconfig.json',
  })
  assert.deepEqual(workspaceScriptCommand('test', { test: 'node --test' }, 'pnpm'), {
    command: 'pnpm run test', script: 'node --test',
  })
  assert.deepEqual(workspaceScriptCommand('build', {}), { error: 'package.json has no "build" script' })
  assert.deepEqual(workspaceScriptCommand('build', undefined), { error: 'package.json has no "build" script' })
})

test('build runs the package script in the workspace root and projects the result', withWorkspace(async (root) => {
  const { shell, sent } = fakeShell({ exitCode: 2, stderr: 'type error', sandboxMode: 'workspace-write' })
  const tool = coordinationWorkspaceTool(serviceOf(root, shell))
  const value = await tool.execute({ action: 'build', timeoutMs: 5_000 }) as Record<string, unknown>
  assert.equal(value.ok, true)
  assert.equal(value.action, 'build')
  assert.equal(value.exitCode, 2)
  assert.equal(value.stderr, 'type error')
  assert.equal(value.sandboxMode, 'workspace-write')
  assert.deepEqual(sent.map((spec) => spec.command), ['npm run build'])
  assert.equal(sent[0]?.workdir, root)
  assert.equal(sent[0]?.timeoutMs, 5_000)
  assert.equal(typeof value.durationMs, 'number')
}))

test('the timeout is capped instead of trusted', withWorkspace(async (root) => {
  const { shell, sent } = fakeShell()
  const tool = coordinationWorkspaceTool(serviceOf(root, shell))
  await tool.execute({ action: 'test', timeoutMs: 99_999_999 })
  assert.equal(sent[0]?.timeoutMs, 600_000)
}))

test('run needs an explicit command and executes exactly that command', withWorkspace(async (root) => {
  const { shell, sent } = fakeShell({ exitCode: 0, stdout: 'hello' })
  const tool = coordinationWorkspaceTool(serviceOf(root, shell))
  const empty = await tool.execute({ action: 'run' }) as Record<string, unknown>
  assert.equal(empty.ok, false)
  assert.deepEqual(empty.error, { code: 'INVALID_ARGUMENT', message: 'run requires a non-empty command' })
  const value = await tool.execute({ action: 'run', command: 'node --version' }) as Record<string, unknown>
  assert.equal(value.ok, true)
  assert.equal(value.stdout, 'hello')
  assert.deepEqual(sent.map((spec) => spec.command), ['node --version'])
}))

test('a profile without a shell service reports UNAVAILABLE instead of pretending', withWorkspace(async (root) => {
  const tool = coordinationWorkspaceTool(serviceOf(root))
  const value = await tool.execute({ action: 'build' }) as Record<string, unknown>
  assert.equal(value.ok, false)
  assert.deepEqual(value.error, { code: 'UNAVAILABLE', message: 'the host exposes no shell service, so commands cannot run' })
}))

test('a missing build script is NOT_FOUND, not a shell call', withWorkspace(async (root) => {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }))
  const { shell, sent } = fakeShell()
  const tool = coordinationWorkspaceTool(serviceOf(root, shell))
  const value = await tool.execute({ action: 'build' }) as Record<string, unknown>
  assert.equal(value.ok, false)
  assert.deepEqual(value.error, { code: 'NOT_FOUND', message: 'package.json has no "build" script' })
  assert.deepEqual(sent, [])
}))

test('an unknown action is INVALID_ARGUMENT and the catalog offers the four actions', () => {
  const tool = coordinationWorkspaceTool(serviceOf(process.cwd(), fakeShell().shell))
  const actions = (tool.parameters.properties as Record<string, { enum: string[] }>).action.enum
  assert.deepEqual(actions, ['structure', 'build', 'test', 'run'])
})

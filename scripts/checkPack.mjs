#!/usr/bin/env node
/**
 * Pack-time guard: `lib/` is gitignored, so a package published from a dirty or
 * unbuilt checkout silently ships a manifest whose `main` points at a missing
 * file. Pack exactly as npm would and assert every runtime artifact is present.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REQUIRED = [
  'lib/index.mjs',
  'lib/index.d.mts',
  'lib/compaction-backend.mjs',
  'lib/compaction-backend.d.mts',
  'lib/client.js',
  'cordis.patch.yml',
  'locale/en.json',
  'locale/zh.json',
  'icon.svg',
  'NOTICE',
  'scripts/migrateStore.mjs',
]

const npmCli = process.env.npm_execpath
const npmCommand = npmCli === undefined ? (process.platform === 'win32' ? 'npm.cmd' : 'npm') : process.execPath
const npmArgs = npmCli === undefined ? [] : [npmCli]
const packDir = mkdtempSync(join(tmpdir(), 'deepseek-coordination-pack-'))

try {
  const output = execFileSync(
    npmCommand,
    [...npmArgs, 'pack', '--json', '--pack-destination', packDir],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      shell: npmCli === undefined && process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  const start = output.search(/^\[/m)
  if (start < 0) throw new Error(`npm pack did not return JSON:\n${output}`)
  const parsed = JSON.parse(output.slice(start))
  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  if (!entry || typeof entry !== 'object') throw new Error(`unexpected npm pack result:\n${output}`)

  const files = new Set((entry.files ?? []).map((file) => file.path))
  const missing = REQUIRED.filter((path) => !files.has(path))
  if (missing.length > 0) {
    throw new Error(
      `tarball is missing runtime files:\n${missing.map((path) => `  - ${path}`).join('\n')}\n` +
        'Run `npm run build` before packing. If the build did not create them, ' +
        'check tsdown.config.ts and the files whitelist in package.json.',
    )
  }

  const tarball = join(packDir, entry.filename)
  const bytes = statSync(tarball).size
  if (bytes === 0) throw new Error(`tarball is empty: ${entry.filename}`)

  execFileSync(process.execPath, ['--check', 'lib/index.mjs'], { cwd: process.cwd(), stdio: 'ignore' })
  execFileSync(process.execPath, ['--check', 'scripts/migrateStore.mjs'], { cwd: process.cwd(), stdio: 'ignore' })

  console.log(`pack check ok: ${entry.filename} (${bytes} bytes); ${REQUIRED.length} required runtime files present`)
} finally {
  rmSync(packDir, { recursive: true, force: true })
}

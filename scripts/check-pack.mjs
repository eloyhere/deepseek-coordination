#!/usr/bin/env node
/**
 * Pack-time guard: `lib/` is gitignored, so a package published from a dirty or
 * unbuilt checkout silently ships a manifest whose `main` points at a missing
 * file. This script packs the package exactly as npm would and asserts that
 * every runtime artifact named by the `files` whitelist is in the tarball.
 *
 * It is intentionally dependency-free: it runs before `npm publish`, in CI, and
 * on a contributor machine that only has Node and npm.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// npm's JSON reports paths relative to the package root (no `package/` prefix).
const REQUIRED = [
  'lib/index.mjs',
  'lib/index.d.mts',
  'lib/client.js',
  'cordis.patch.yml',
]

// `npm run` sets npm_execpath; invoking that file through the current Node
// avoids `shell: true` on Windows (and its argument-escaping deprecation).
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

  // npm prints lifecycle output before the JSON array. The array starts on its
  // own line (`[`); build logs also contain `[` but never at line start.
  const start = output.search(/^\[/m)
  if (start < 0) throw new Error(`npm pack did not return JSON:\n${output}`)
  const parsed = JSON.parse(output.slice(start))
  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  if (!entry || typeof entry !== 'object') {
    throw new Error(`unexpected npm pack result:\n${output}`)
  }

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

  // Parsing the host entry catches syntax errors without executing plugin code.
  execFileSync(process.execPath, ['--check', 'lib/index.mjs'], {
    cwd: process.cwd(),
    stdio: 'ignore',
  })

  console.log(
    `pack check ok: ${entry.filename} (${bytes} bytes); ` +
      `${REQUIRED.length} required runtime files present`,
  )
} finally {
  rmSync(packDir, { recursive: true, force: true })
}

/**
 * Copy a legacy machine-wide AMP store into a workspace store with
 * SQLite's VACUUM INTO. DSH must be stopped so no WAL writer is active.
 *
 *   node scripts/migrateStore.mjs --to <workspace> [--from <amp.sqlite>]
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

function argument(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    console.error(`${name} requires a value`)
    process.exit(2)
  }
  return value
}

const targetRoot = argument('--to')
if (targetRoot === undefined) {
  console.error('usage: node scripts/migrateStore.mjs --to <workspace> [--from <amp.sqlite>]')
  process.exit(2)
}

const source = resolve(argument('--from', join(homedir(), '.dsh', 'storages', 'deepseek-coordination', 'amp.sqlite')))
const destination = resolve(targetRoot, '.deepseek-coordination', 'amp.sqlite')

if (!existsSync(source)) {
  console.error(`source store not found: ${source}`)
  process.exit(1)
}
if (existsSync(destination)) {
  console.error(`destination already exists: ${destination}`)
  process.exit(1)
}

mkdirSync(dirname(destination), { recursive: true })
const database = new DatabaseSync(source, { readOnly: true })
try {
  // VACUUM INTO requires a literal path and produces a clean, WAL-free copy.
  database.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`)
} finally {
  database.close()
}
console.log(`copied ${source}`)
console.log(`    to ${destination}`)

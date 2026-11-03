/** Bounded, read-only projections of an existing SyncTeX artifact; no filesystem access. */
import { gunzipSync } from 'node:zlib'

/** Both compressed input and inflated UTF-8 text are independently bounded. */
export const MAX_TEX_SYNC_BYTES = 4 * 1024 * 1024
export const MAX_TEX_SYNC_GZIP_BYTES = 4 * 1024 * 1024
export const MAX_TEX_SYNC_RECORDS = 50_000
/** Reject corrupted or implausible page/line/tag integers. */
const MAX_SYNC_INTEGER = 1_000_000_000
const MAX_SYNC_PAGE = 100_000

/** Only the companion artifact adjacent to the selected source is a candidate. */
export function texSyncCandidate(sourcePath: string): string | undefined {
  const source = relativeTexPath(sourcePath)
  if (source === undefined) return undefined
  return source.replace(/\.(?:tex|ltx|latex)$/i, '.synctex.gz')
}

/** Invalid gzip, decompression bombs and undecodable content have no mapping. */
export function inflateTexSync(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_TEX_SYNC_GZIP_BYTES) return undefined
  try {
    const inflated = gunzipSync(bytes, { maxOutputLength: MAX_TEX_SYNC_BYTES })
    const text = new TextDecoder('utf-8', { fatal: true }).decode(inflated)
    return text.includes('\0') ? undefined : text
  } catch {
    return undefined
  }
}

/**
 * Locate a source line in existing SyncTeX sheet records, without running TeX.
 * Exact relative Input paths win; otherwise a basename must identify exactly
 * one Input tag across the artifact (including absolute compiler input paths).
 * Input paths are metadata only: they are never opened or returned.
 *
 * The nearest recorded line wins. A tie prefers the following source line,
 * then the earlier page. This is source-map evidence, not a PDF text search.
 * Missing/ambiguous input tags and budget violations yield no mapping.
 */
export function texSyncPage(text: string, sourcePath: string, sourceLine: number): number | undefined {
  const source = relativeTexPath(sourcePath)
  if (source === undefined || !positiveInteger(sourceLine) || text.length > MAX_TEX_SYNC_BYTES ||
    Buffer.byteLength(text, 'utf8') > MAX_TEX_SYNC_BYTES || text.includes('\0')) return undefined

  const inputs = new Map<number, string>()
  let records = 0
  let version = false
  for (const line of linesOf(text)) {
    if (++records > MAX_TEX_SYNC_RECORDS) return undefined
    if (line === 'SyncTeX Version:1') version = true
    const input = /^Input:(\d+):(.+)$/.exec(line)
    if (input === null) continue
    const tag = Number(input[1])
    const file = input[2]?.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
    if (!positiveInteger(tag) || file === undefined || /[\x00-\x1f]/.test(file)) return undefined
    const previous = inputs.get(tag)
    if (previous !== undefined && previous !== file) return undefined
    inputs.set(tag, file)
  }
  if (!version) return undefined
  const exact = [...inputs].filter(([, file]) => file === source)
  const sourceName = basename(source)
  const matches = exact.length > 0 ? exact : [...inputs].filter(([, file]) => basename(file) === sourceName)
  if (matches.length !== 1) return undefined
  const targetTag = matches[0]?.[0]

  let content = false
  let page: number | undefined
  let best: { line: number; page: number; distance: number } | undefined
  for (const line of linesOf(text)) {
    if (line === 'Content:') { content = true; continue }
    if (line === 'Postamble:') break
    if (!content) continue
    if (line.startsWith('{')) {
      const sheet = /^\{(\d+)$/.exec(line)
      const number = sheet === null ? NaN : Number(sheet[1])
      page = positiveInteger(number) && number <= MAX_SYNC_PAGE ? number : undefined
      continue
    }
    if (/^\}\d*$/.test(line)) { page = undefined; continue }
    if (page === undefined) continue
    // Standard vbox/hbox and void box, kern, glue, rule, math and x records.
    const record = /^[\[(hvkgrx$](\d+),(\d+)(?:,-?\d+)?:/.exec(line)
    if (record === null || Number(record[1]) !== targetTag) continue
    const number = Number(record[2])
    if (!positiveInteger(number)) continue
    const distance = Math.abs(number - sourceLine)
    if (best === undefined || distance < best.distance ||
      (distance === best.distance && number >= sourceLine && best.line < sourceLine) ||
      (distance === best.distance && number === best.line && page < best.page)) {
      best = { line: number, page, distance }
    }
  }
  return best?.page
}

function relativeTexPath(path: string): string | undefined {
  const value = path.replace(/\\/g, '/')
  if (value.length === 0 || value.startsWith('/') || /[:\x00-\x1f]/.test(value)) return undefined
  const segments = value.split('/')
  if (segments.some((segment) => segment === '..' || segment.length === 0)) return undefined
  const relative = segments.filter((segment) => segment !== '.').join('/')
  return /\.(?:tex|ltx|latex)$/i.test(relative) ? relative : undefined
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_SYNC_INTEGER
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** Iterate without a potentially multi-million-entry split allocation. */
function* linesOf(text: string): Generator<string> {
  let start = 0
  while (start < text.length) {
    const next = text.indexOf('\n', start)
    const end = next === -1 ? text.length : next
    yield text.slice(start, end).replace(/\r$/, '')
    if (next === -1) break
    start = next + 1
  }
}

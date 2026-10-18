/**
 * Browser shim for `node:url`.
 *
 * `vfile` converts `file:` URLs to paths. There is no filesystem in the browser,
 * but the conversion is pure string work, so implement the two functions vfile
 * can reach and refuse anything that is not a local file URL.
 */
export function fileURLToPath(input: string | URL): string {
  const raw = typeof input === 'string' ? input : input.toString()
  if (!raw.startsWith('file://')) {
    throw new TypeError(`The URL must be of scheme file: ${raw}`)
  }
  const withoutScheme = raw.slice('file://'.length)
  const decoded = decodeURIComponent(withoutScheme)
  // Windows drive letters arrive as /C:/path; strip the leading slash.
  return /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded
}

export function pathToFileURL(path: string): URL {
  const normalised = String(path).replace(/\\/g, '/')
  const prefixed = normalised.startsWith('/') ? normalised : `/${normalised}`
  return new URL(`file://${encodeURI(prefixed)}`)
}

export default { fileURLToPath, pathToFileURL }

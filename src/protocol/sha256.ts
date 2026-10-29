/**
 * SHA-256 over UTF-8 text, as lowercase hex.
 *
 * The reference implementation carries its own portable SHA-256; this host
 * compiles for Node (the Cordis plugin runs in the harness process), so it uses
 * `node:crypto` instead. The observable contract is identical: the same input
 * produces the same 64 hex characters.
 *
 * The protocol layer is host-only. Importing it from `src/client` would pull
 * `node:crypto` into the browser bundle, which the client module table cannot
 * resolve.
 */
import { createHash } from 'node:crypto'

/** Lowercase hex SHA-256 of one UTF-8 string. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

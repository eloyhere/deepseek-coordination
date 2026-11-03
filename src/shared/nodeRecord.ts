/**
 * Canonical node record — the stable, body-free shape every parser output and
 * card projection is normalised to before it crosses the HTTP/tool boundary.
 *
 * The contract is deliberately flat about numbers:
 *
 * ```ts
 * { path, charset, byte: {start,end}, line: {start,end}, fingerprint,
 *   dirty, summary, brief, description, reference, purpose, children: [] }
 * ```
 *
 * Design notes:
 *
 *  - `byte` and `line` are nested `{ start, end }` pairs of `number`, not
 *    `bigint`. `bigint` cannot cross a JSON boundary (`JSON.stringify(1n)`
 *    throws), and every consumer here is JSON: the tool result, the `/config`
 *    style routes and the proxy's structural log. Files larger than
 *    `Number.MAX_SAFE_INTEGER` bytes are not a real case, so `number` is the
 *    honest type rather than a serialization hazard.
 *  - `children` is an inline tree, but the depth is **not** hard-coded here.
 *    The caller supplies the configured limit (the settings page owns it), so
 *    this module stays a pure shape helper. `limitDepth` truncates; deeper
 *    nodes still exist in the graph and are reached through `contains` edges.
 *  - Every text field defaults to `''` and every coordinate to `0`: a missing
 *    value is empty, never `undefined`, so the wire shape never varies.
 *  - A record is a tree; a node may have one parent. `attachChildren` refuses
 *    to attach the same record twice, which keeps the inline tree acyclic by
 *    construction.
 */

/** One `{ start, end }` coordinate pair. */
export interface NodeSpan {
  start: number
  end: number
}

/** Body-free node record, the only shape that crosses the boundary. */
export interface NodeRecord {
  path: string
  charset: string
  byte: NodeSpan
  line: NodeSpan
  fingerprint: string
  dirty: boolean
  summary: string
  brief: string
  description: string
  reference: string
  purpose: string
  children: NodeRecord[]
}

/** Loose input accepted by `createNodeRecord`; every field is optional. */
export interface NodeRecordInput {
  path?: string
  charset?: string
  byte?: Partial<NodeSpan>
  line?: Partial<NodeSpan>
  byteStart?: number
  byteEnd?: number
  lineStart?: number
  lineEnd?: number
  fingerprint?: string
  dirty?: boolean
  summary?: string
  brief?: string
  description?: string
  reference?: string
  purpose?: string
  children?: readonly NodeRecordInput[]
}

/**
 * A flat metadata shape (the parsers' `NodeMetadata`/`FlatFragment`) mapped
 * onto the record. Kept structural so this module does not import a parser.
 */
export interface FlatNodeFields {
  path?: string
  byteStart?: number
  byteEnd?: number
  lineStart?: number
  lineEnd?: number
  fingerprint?: string
  summary?: string
  brief?: string
  description?: string
  reference?: unknown
  purpose?: string
}

/** Coerce a possibly-undefined number to a non-negative integer. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0
}

/** Coerce a possibly-undefined string to a string. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Render an arbitrary reference into its wire string form. */
function referenceText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    const target = (value as { target?: unknown }).target
    if (typeof target === 'string') return target
  }
  return ''
}

/** Build one record, filling every absent field with its empty value. */
export function createNodeRecord(input: NodeRecordInput = {}): NodeRecord {
  return {
    path: text(input.path),
    charset: text(input.charset),
    byte: {
      start: count(input.byte?.start ?? input.byteStart),
      end: count(input.byte?.end ?? input.byteEnd),
    },
    line: {
      start: count(input.line?.start ?? input.lineStart),
      end: count(input.line?.end ?? input.lineEnd),
    },
    fingerprint: text(input.fingerprint),
    dirty: input.dirty === true,
    summary: text(input.summary),
    brief: text(input.brief),
    description: text(input.description),
    reference: text(input.reference),
    purpose: text(input.purpose),
    children: (input.children ?? []).map((child) => createNodeRecord(child)),
  }
}

/**
 * Map a parser's flat metadata onto a record.
 *
 * `charset` lives on the parse result, not on each node, so the caller passes
 * it in; the node-level fragment fields supply the coordinates.
 */
export function recordFromFlat(flat: FlatNodeFields, charset: string): NodeRecord {
  return createNodeRecord({
    path: flat.path,
    charset,
    byteStart: flat.byteStart,
    byteEnd: flat.byteEnd,
    lineStart: flat.lineStart,
    lineEnd: flat.lineEnd,
    fingerprint: flat.fingerprint,
    summary: flat.summary,
    brief: flat.brief,
    description: flat.description,
    reference: referenceText(flat.reference),
    purpose: flat.purpose,
  })
}

/**
 * Attach children and keep the tree acyclic.
 *
 * A record already reachable from `parent` is refused rather than silently
 * duplicated: a node has one parent, and a cycle would make the inline tree
 * unbounded.
 */
export function attachChildren(parent: NodeRecord, children: readonly NodeRecord[]): NodeRecord {
  const seen = new Set<NodeRecord>()
  const collect = (node: NodeRecord): void => {
    seen.add(node)
    for (const child of node.children) collect(child)
  }
  collect(parent)
  const accepted: NodeRecord[] = []
  for (const child of children) {
    if (seen.has(child)) continue
    seen.add(child)
    accepted.push(child)
  }
  return { ...parent, children: accepted }
}

/**
 * Truncate the inline tree to `maxDepth` levels of children.
 *
 * `maxDepth <= 0` drops all children; `1` keeps immediate children; `2` keeps
 * grandchildren. The limit is a setting, never a literal in this module.
 */
export function limitDepth(record: NodeRecord, maxDepth: number): NodeRecord {
  const depth = Number.isFinite(maxDepth) ? Math.max(0, Math.trunc(maxDepth)) : 0
  if (depth <= 0) return { ...record, children: [] }
  return {
    ...record,
    children: record.children.map((child) => limitDepth(child, depth - 1)),
  }
}

/** Total record count in the inline tree (the root included). */
export function countRecords(record: NodeRecord): number {
  let total = 1
  for (const child of record.children) total += countRecords(child)
  return total
}

/**
 * Produce the JSON-safe wire value.
 *
 * The record already contains only strings, numbers, booleans and arrays, so
 * this is a structural copy that freezes the shape: no `bigint`, no `undefined`,
 * no class instance leaks into the response.
 */
export function toWire(record: NodeRecord): NodeRecord {
  return {
    path: record.path,
    charset: record.charset,
    byte: { start: record.byte.start, end: record.byte.end },
    line: { start: record.line.start, end: record.line.end },
    fingerprint: record.fingerprint,
    dirty: record.dirty === true,
    summary: record.summary,
    brief: record.brief,
    description: record.description,
    reference: record.reference,
    purpose: record.purpose,
    children: record.children.map((child) => toWire(child)),
  }
}

/** Validate and normalise an untrusted wire value into a record. */
export function fromWire(value: unknown): NodeRecord {
  const input = typeof value === 'object' && value !== null ? (value as NodeRecordInput) : {}
  const children = Array.isArray(input.children) ? input.children.map((child) => fromWire(child)) : []
  return createNodeRecord({ ...input, children })
}

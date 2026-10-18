/**
 * Bounded registry of parsed nodes and the `NodeCard` / `coordination_describe`
 * projection.
 *
 * The registry is the agent's only way back to a parsed node: a tool receives an
 * opaque public `handle` (never a numeric identity, never an AST node, never a
 * file body) and asks the registry for the card or for the requested metadata
 * fields. Projection rules (`docs/domain-model-v24.md` §2.4):
 *
 *  - `NodeCard` carries identity/name/kind/summary/brief/reference, the six flat
 *    file fields (`path`, `byteStart`, `byteEnd`, `lineStart`, `lineEnd`,
 *    `fingerprint`) plus `status`/`usage`/`purpose`, capped at ~1 KiB;
 *  - `coordination_describe` always returns the brief, the reference and the
 *    flat fields, then only the fields the caller asked for
 *    (`summary`/`description`/`usage`/`purpose`); missing fields stay empty and
 *    are listed as unverifiable, never invented;
 *  - **no content**: the registry never stores file text, comment bodies, ASTs,
 *    adjacency maps or formula ASTs. `description` is the parser's capped
 *    doc-comment excerpt, not the body.
 *
 * Handles are deterministic (`sha256` over `path + kind + locator`) so
 * re-parsing the same file yields the same handle: a chain cache, a Plan
 * constraint or a client bookmark survives an edit, while the fingerprint/range
 * fields change. The registry itself is capacity-bounded (`LruList`, default
 * 10,000 nodes) — eviction means "parse again", never a wrong answer.
 *
 * When the host has a database, an optional {@link NodePersistenceSink}
 * (`GraphStore`) writes each card to the v24 `node` table, and {@link restore}
 * rehydrates the bounded newest rows on a new runtime with no parse; the handle
 * is the database key, so it survives a restart.
 *
 * Complexity: `register` O(nodes) per parse; `card`/`describe`/`facts` O(1)
 * average; `clear`/`dispose` O(n) reclamation.
 */
import { createHash } from 'node:crypto'
import { InvalidArgumentError, NotFoundError } from '../shared/error.js'
import { LruList } from '../shared/lru.js'
import type { ConceptMetadata } from '../shared/entity.js'
import type { Charset, NodeMetadata, NodeReference } from './text/parser.js'
import type { NodeStatus, ParsedFile } from './parse-service.js'

/* ------------------------------------------------------------------------- *
 * Handles and kinds
 * ------------------------------------------------------------------------- */

/**
 * Node kinds a parsed file can carry (`heading`/`div` are P0 parser kinds;
 * `interface`/`type`/`enumeration`/`namespace`/`variable` are language-
 * declaration kinds emitted by the Python/Java/Rust/PHP/C-family parsers).
 */
export type NodeKind =
  | 'project'
  | 'module'
  | 'document'
  /** OOXML workbook root (`xl/workbook.xml`); `sheet`/`range`/`formula` live under it. */
  | 'workbook'
  | 'book'
  | 'part'
  | 'chapter'
  | 'article'
  | 'section'
  | 'paragraph'
  /** Explicit hyperlink (`w:hyperlink` resolved through document rels); no display text. */
  | 'link'
  | 'sheet'
  | 'slide'
  | 'cell'
  | 'range'
  | 'formula'
  | 'class'
  /**
   * Type declarations, sorted: `enumeration`, `interface`, `namespace`
   * container and `type` alias. `enum` is a legacy spelling kept for
   * compatibility; no parser emits it.
   */
  | 'enum'
  | 'enumeration'
  | 'interface'
  | 'namespace'
  | 'type'
  | 'function'
  | 'method'
  /** A field / local / file-scope binding declared by a language parser. */
  | 'variable'
  | 'definition'
  | 'lemma'
  | 'proof'
  | 'property'
  | 'axiom'
  | 'theorem'
  | 'corollary'
  | 'claim'
  | 'example'
  | 'remark'
  | 'condition'
  | 'comment'
  | 'code'
  | 'importation'
  | 'exportation'
  | 'sign'
  | 'person'
  | 'venue'
  /** P0 structural nodes: a Markdown/HTML heading and a Pandoc fenced div. */
  | 'heading'
  | 'div'

/** Default registry capacity (nodes). */
export const DEFAULT_REGISTRY_CAPACITY = 10_000
/** NodeCard byte budget (~1 KiB per the domain model). */
export const NODE_CARD_MAX_BYTES = 1_024
/** Fields `coordination_describe` may request beyond the card. */
export const DESCRIBE_FIELDS = ['summary', 'description', 'usage', 'purpose'] as const
export type DescribeField = (typeof DESCRIBE_FIELDS)[number]

/** Stable public handle for the file-backed node of a workspace path. */
export function fileHandleFor(path: string): string {
  return handleOf(`file\u0000${normaliseKeyPath(path)}`)
}

/**
 * Stable public handle for one parsed node. `key` is the natural locator
 * (`nodeKeyOf`) so a reparse produces the same handle.
 */
export function nodeHandleFor(path: string | undefined, kind: string, key: string): string {
  return handleOf(`${path === undefined ? 'text' : normaliseKeyPath(path)}\u0000${kind}\u0000${key}`)
}

/** Natural key of a parser node: its locator, else `kind:spanStart`. */
export function nodeKeyOf(metadata: NodeMetadata): string {
  return metadata.locator ?? `${metadata.kind}:${metadata.span.start}`
}

function handleOf(seed: string): string {
  return `n${createHash('sha256').update(seed).digest('hex').slice(0, 24)}`
}

function normaliseKeyPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

/* ------------------------------------------------------------------------- *
 * Projections
 * ------------------------------------------------------------------------- */

/** The six flat file fields, authoritative over the nested reference. */
export interface FlatFields {
  path?: string
  byteStart?: number
  byteEnd?: number
  lineStart?: number
  lineEnd?: number
  fingerprint?: string
}

/** The model-facing node card. No body, no AST, no graph. */
export interface NodeCard {
  /** Public handle. */
  identity: string
  name: string
  kind: string
  /** What the node is (≤200), empty when the parser found no explicit source. */
  summary: string
  /** What the content says (≤300), empty when no explicit source exists. */
  brief: string
  /** Body-free locator; absent only for path-less text parses. */
  reference?: NodeReference
  path?: string
  byteStart?: number
  byteEnd?: number
  lineStart?: number
  lineEnd?: number
  fingerprint?: string
  charset?: Charset
  status?: NodeStatus
  /** Explicit `@usage` only (≤300); empty when unknown. */
  usage?: string
  /** Explicit `@purpose` only (≤200); empty when unknown. */
  purpose?: string
  /**
   * Explicit structural/domain concept the parser proved locally (domain
   * extraction). Body-free. The card keeps the same identity as its parser
   * node: a domain kind/locator is an *attribute*, never a second node.
   */
  domain?: ConceptMetadata
}

/** Host-only facts a chain projection needs; never returned to the model. */
export interface NodeFacts {
  handle: string
  kind: string
  name?: string
  /** Explicit statement label (`\label{...}`), when separate from the name. */
  label?: string
  path?: string
  byteStart?: number
  byteEnd?: number
  lineStart?: number
  lineEnd?: number
  fingerprint?: string
  status: NodeStatus
}

/** Result of `coordination_describe`: card + requested fields, no body. */
export interface DescribeResult {
  handle: string
  card: NodeCard
  status: NodeStatus
  brief: string
  reference?: NodeReference
  /** The six flat fields, always present (omitted individually when unknown). */
  fields: FlatFields
  /** Only the fields the caller asked for; missing ones are `''`. */
  requested: Partial<Record<DescribeField, string>>
  /** Requested fields that have no explicit source (never fabricated). */
  unverifiable: DescribeField[]
}

/**
 * One node row ready for the v24 `node` table (domain model §2.8).
 *
 * Body-free by construction: it is the `NodeCard` plus the explicit metadata
 * fields the card could not carry (`description`), the natural locator, the
 * owning file handle and the node's status. The persistence layer maps it to
 * columns; no `content`/`body`/AST field exists here.
 */
export interface NodePersistenceRecord {
  handle: string
  kind: string
  /** Natural parser locator (`function:foo`, `heading:120`, ...). */
  locator?: string
  /** Public handle of the owning file node, when this node lives under one. */
  ownerHandle?: string
  path?: string
  name?: string
  label?: string
  summary?: string
  brief?: string
  description?: string
  usage?: string
  purpose?: string
  byteStart?: number
  byteEnd?: number
  lineStart?: number
  lineEnd?: number
  fingerprint?: string
  charset?: string
  status: NodeStatus
  reference?: NodeReference
  /** Explicit domain concept, persisted as body-free JSON in `node.detail`. */
  domain?: ConceptMetadata
  /** Position within the file parse (0 = the file node itself). */
  ordinal?: number
  created?: number
  changed?: number
}

/** Host-only write hook; implemented by `GraphStore`, absent without a DB. */
export interface NodePersistenceSink {
  saveNode(record: NodePersistenceRecord): void
}

/** Constructor options; capacity can only be lowered. */
export interface NodeRegistryOptions {
  capacity?: number
  /** Persist every registered card (host only; the registry never reads it). */
  persist?: NodePersistenceSink
}

interface RegisteredNode {
  card: NodeCard
  facts: NodeFacts
  summary?: string
  description?: string
  usage?: string
  purpose?: string
}

/* ------------------------------------------------------------------------- *
 * Registry
 * ------------------------------------------------------------------------- */

/**
 * Capacity-bounded node registry. One instance per parse service / session; the
 * tool layer shares it so `coordination_parse` followed by
 * `coordination_describe`/`coordination_chain` sees the same handles.
 */
export class NodeRegistry {
  private readonly store: LruList<string, RegisteredNode>
  private readonly persist: NodePersistenceSink | undefined

  constructor(options: NodeRegistryOptions = {}) {
    const capacity = options.capacity ?? DEFAULT_REGISTRY_CAPACITY
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new InvalidArgumentError('registry capacity must be a positive integer', { capacity })
    }
    this.store = new LruList<string, RegisteredNode>(capacity)
    this.persist = options.persist
  }

  /** Number of registered nodes. O(1). */
  get size(): number {
    return this.store.size
  }

  /** Configured capacity. O(1). */
  get capacity(): number {
    return this.store.capacity
  }

  /**
   * Register every node of one parse and return its cards (file node first).
   * Re-registering a handle overwrites the previous card (fresh ranges and
   * fingerprint) instead of duplicating it.
   */
  register(parsed: ParsedFile): NodeCard[] {
    const cards: NodeCard[] = []
    const fileHandle = parsed.path === undefined
      ? nodeHandleFor(undefined, parsed.file.kind, nodeKeyOf(parsed.file))
      : fileHandleFor(parsed.path)
    cards.push(this.put(fileHandle, parsed.file, parsed, undefined, 0))
    let ordinal = 1
    for (const metadata of parsed.nodes) {
      const handle = parsed.path === undefined
        ? nodeHandleFor(undefined, metadata.kind, nodeKeyOf(metadata))
        : nodeHandleFor(parsed.path, metadata.kind, nodeKeyOf(metadata))
      cards.push(this.put(handle, metadata, parsed, fileHandle, ordinal))
      ordinal += 1
    }
    return cards
  }

  /**
   * Rehydrate previously persisted cards without a parse.
   *
   * `records` is expected newest-first (the store's bounded query order); they
   * are inserted oldest-first so the LRU's most-recent end matches the query,
   * and a capacity smaller than the row count keeps the newest nodes. Purely
   * in-memory: restore never calls the persistence sink, so rehydration cannot
   * rewrite the rows it just read.
   */
  restore(records: readonly NodePersistenceRecord[]): void {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index]
      if (record === undefined) continue
      const status = record.status
      const card = boundCard({
        identity: record.handle,
        name: record.name ?? '',
        kind: record.kind,
        summary: record.summary ?? '',
        brief: record.brief ?? '',
        ...(record.reference === undefined ? {} : { reference: record.reference }),
        ...(record.path === undefined ? {} : { path: record.path }),
        ...(record.byteStart === undefined ? {} : { byteStart: record.byteStart }),
        ...(record.byteEnd === undefined ? {} : { byteEnd: record.byteEnd }),
        ...(record.lineStart === undefined ? {} : { lineStart: record.lineStart }),
        ...(record.lineEnd === undefined ? {} : { lineEnd: record.lineEnd }),
        ...(record.fingerprint === undefined ? {} : { fingerprint: record.fingerprint }),
        ...(record.charset === undefined ? {} : { charset: record.charset as Charset }),
        status,
        ...(record.usage === undefined ? {} : { usage: record.usage }),
        ...(record.purpose === undefined ? {} : { purpose: record.purpose }),
        ...(record.domain === undefined ? {} : { domain: record.domain }),
      })
      const facts: NodeFacts = {
        handle: record.handle,
        kind: record.kind,
        ...(record.name === undefined ? {} : { name: record.name }),
        ...(record.label === undefined ? {} : { label: record.label }),
        ...(record.path === undefined ? {} : { path: record.path }),
        ...(record.byteStart === undefined ? {} : { byteStart: record.byteStart }),
        ...(record.byteEnd === undefined ? {} : { byteEnd: record.byteEnd }),
        ...(record.lineStart === undefined ? {} : { lineStart: record.lineStart }),
        ...(record.lineEnd === undefined ? {} : { lineEnd: record.lineEnd }),
        ...(record.fingerprint === undefined ? {} : { fingerprint: record.fingerprint }),
        status,
      }
      this.store.set(record.handle, {
        card,
        facts,
        ...(record.summary === undefined ? {} : { summary: record.summary }),
        ...(record.description === undefined ? {} : { description: record.description }),
        ...(record.usage === undefined ? {} : { usage: record.usage }),
        ...(record.purpose === undefined ? {} : { purpose: record.purpose }),
      })
    }
  }

  /** The card for a handle, or `undefined` when it was never registered/evicted. */
  card(handle: string): NodeCard | undefined {
    return this.store.peek(assertHandle(handle))?.card
  }

  /** Host-only facts for the chain engine; `undefined` when unknown. */
  facts(handle: string): NodeFacts | undefined {
    return this.store.peek(assertHandle(handle))?.facts
  }

  /** Membership test that does not refresh recency. */
  has(handle: string): boolean {
    return this.store.has(assertHandle(handle))
  }

  /**
   * `coordination_describe`: the card plus the requested metadata fields. Always
   * returns brief/reference/flat fields; throws `NotFoundError` for an unknown
   * handle and `InvalidArgumentError` for an unknown field.
   */
  describe(handle: string, fields: readonly string[] = []): DescribeResult {
    const registered = this.store.get(assertHandle(handle))
    if (registered === undefined) throw new NotFoundError('node', handle)
    const requested: Partial<Record<DescribeField, string>> = {}
    const unverifiable: DescribeField[] = []
    for (const field of fields) {
      if (!isDescribeField(field)) {
        throw new InvalidArgumentError('unknown describe field', {
          field,
          allowed: [...DESCRIBE_FIELDS],
        })
      }
      const value = describeValue(registered, field)
      requested[field] = value
      if (value.length === 0) unverifiable.push(field)
    }
    const card = registered.card
    const result: DescribeResult = {
      handle: card.identity,
      card,
      status: registered.facts.status,
      brief: card.brief,
      fields: flatFieldsOf(card),
      requested,
      unverifiable,
    }
    if (card.reference !== undefined) result.reference = card.reference
    return result
  }

  /** Drop every registered node. */
  clear(): void {
    this.store.clear()
  }

  /** Dispose alias; the registry owns no external resource. */
  dispose(): void {
    this.clear()
  }

  private put(
    handle: string,
    metadata: NodeMetadata,
    parsed: ParsedFile,
    ownerHandle: string | undefined,
    ordinal: number,
  ): NodeCard {
    const status = statusOf(metadata, parsed)
    const card = boundCard({
      identity: handle,
      name: metadata.name ?? '',
      kind: metadata.kind,
      summary: metadata.summary ?? '',
      brief: metadata.brief ?? '',
      ...(metadata.reference === undefined ? {} : { reference: metadata.reference }),
      ...flatCardFields(metadata),
      ...(metadata.charset === undefined ? {} : { charset: metadata.charset }),
      status,
      ...(metadata.usage === undefined ? {} : { usage: metadata.usage }),
      ...(metadata.purpose === undefined ? {} : { purpose: metadata.purpose }),
      ...(metadata.domain === undefined ? {} : { domain: metadata.domain }),
    })
    const facts: NodeFacts = {
      handle,
      kind: metadata.kind,
      ...(metadata.name === undefined ? {} : { name: metadata.name }),
      ...(metadata.label === undefined ? {} : { label: metadata.label }),
      ...(metadata.path === undefined ? {} : { path: metadata.path }),
      ...(metadata.byteStart === undefined ? {} : { byteStart: metadata.byteStart }),
      ...(metadata.byteEnd === undefined ? {} : { byteEnd: metadata.byteEnd }),
      ...(metadata.lineStart === undefined ? {} : { lineStart: metadata.lineStart }),
      ...(metadata.lineEnd === undefined ? {} : { lineEnd: metadata.lineEnd }),
      ...(metadata.fingerprint === undefined ? {} : { fingerprint: metadata.fingerprint }),
      status,
    }
    this.store.set(handle, {
      card,
      facts,
      ...(metadata.summary === undefined ? {} : { summary: metadata.summary }),
      ...(metadata.description === undefined ? {} : { description: metadata.description }),
      ...(metadata.usage === undefined ? {} : { usage: metadata.usage }),
      ...(metadata.purpose === undefined ? {} : { purpose: metadata.purpose }),
    })
    this.persist?.saveNode({
      handle,
      kind: metadata.kind,
      ...(metadata.locator === undefined ? {} : { locator: metadata.locator }),
      ...(ownerHandle === undefined ? {} : { ownerHandle }),
      ...(metadata.path === undefined ? {} : { path: metadata.path }),
      ...(metadata.name === undefined ? {} : { name: metadata.name }),
      ...(metadata.label === undefined ? {} : { label: metadata.label }),
      ...(metadata.summary === undefined ? {} : { summary: metadata.summary }),
      ...(metadata.brief === undefined ? {} : { brief: metadata.brief }),
      ...(metadata.description === undefined ? {} : { description: metadata.description }),
      ...(metadata.usage === undefined ? {} : { usage: metadata.usage }),
      ...(metadata.purpose === undefined ? {} : { purpose: metadata.purpose }),
      ...(metadata.byteStart === undefined ? {} : { byteStart: metadata.byteStart }),
      ...(metadata.byteEnd === undefined ? {} : { byteEnd: metadata.byteEnd }),
      ...(metadata.lineStart === undefined ? {} : { lineStart: metadata.lineStart }),
      ...(metadata.lineEnd === undefined ? {} : { lineEnd: metadata.lineEnd }),
      ...(metadata.fingerprint === undefined ? {} : { fingerprint: metadata.fingerprint }),
      ...(metadata.charset === undefined ? {} : { charset: metadata.charset }),
      ...(metadata.reference === undefined ? {} : { reference: metadata.reference }),
      ...(metadata.domain === undefined ? {} : { domain: metadata.domain }),
      status,
      ordinal,
    })
    return card
  }
}

/* ------------------------------------------------------------------------- *
 * Helpers
 * ------------------------------------------------------------------------- */

function assertHandle(handle: unknown): string {
  if (typeof handle !== 'string' || handle.length === 0) {
    throw new InvalidArgumentError('handle must be a non-empty public node handle')
  }
  return handle
}

function isDescribeField(value: string): value is DescribeField {
  return (DESCRIBE_FIELDS as readonly string[]).includes(value)
}

function describeValue(registered: RegisteredNode, field: DescribeField): string {
  switch (field) {
    case 'summary':
      return registered.summary ?? ''
    case 'description':
      return registered.description ?? ''
    case 'usage':
      return registered.usage ?? ''
    case 'purpose':
      return registered.purpose ?? ''
  }
}

/** `parsed` status wins; a node with no explicit name/label is `partial`. */
function statusOf(metadata: NodeMetadata, parsed: ParsedFile): NodeStatus {
  if (parsed.status === 'unverifiable') return 'unverifiable'
  if (parsed.truncated) return 'truncated'
  if ((metadata.name === undefined || metadata.name.length === 0) && metadata.label === undefined) {
    return 'partial'
  }
  return 'parsed'
}

function flatCardFields(metadata: NodeMetadata): FlatFields {
  return {
    ...(metadata.path === undefined ? {} : { path: metadata.path }),
    ...(metadata.byteStart === undefined ? {} : { byteStart: metadata.byteStart }),
    ...(metadata.byteEnd === undefined ? {} : { byteEnd: metadata.byteEnd }),
    ...(metadata.lineStart === undefined ? {} : { lineStart: metadata.lineStart }),
    ...(metadata.lineEnd === undefined ? {} : { lineEnd: metadata.lineEnd }),
    ...(metadata.fingerprint === undefined ? {} : { fingerprint: metadata.fingerprint }),
  }
}

function flatFieldsOf(card: NodeCard): FlatFields {
  return {
    ...(card.path === undefined ? {} : { path: card.path }),
    ...(card.byteStart === undefined ? {} : { byteStart: card.byteStart }),
    ...(card.byteEnd === undefined ? {} : { byteEnd: card.byteEnd }),
    ...(card.lineStart === undefined ? {} : { lineStart: card.lineStart }),
    ...(card.lineEnd === undefined ? {} : { lineEnd: card.lineEnd }),
    ...(card.fingerprint === undefined ? {} : { fingerprint: card.fingerprint }),
  }
}

/**
 * Enforce the ~1 KiB card budget in a deterministic order: first shrink the
 * domain concept to its kind/locator (the identity-bearing part), then the
 * nested reference's source span (the six flat fields stay authoritative), then
 * the reference itself, then the domain concept. Never truncates
 * `name`/`kind`/`identity`, and never adds a field that was not there.
 */
function boundCard(card: NodeCard): NodeCard {
  if (JSON.stringify(card).length <= NODE_CARD_MAX_BYTES) return card
  if (card.domain !== undefined) {
    card.domain = {
      kind: card.domain.kind,
      ...(card.domain.locator === undefined ? {} : { locator: card.domain.locator }),
    }
  }
  if (JSON.stringify(card).length <= NODE_CARD_MAX_BYTES) return card
  if (card.reference !== undefined && card.reference.span !== undefined) {
    const { span, ...rest } = card.reference
    void span
    card.reference = rest
  }
  if (JSON.stringify(card).length <= NODE_CARD_MAX_BYTES) return card
  card.reference = undefined
  if (JSON.stringify(card).length <= NODE_CARD_MAX_BYTES) return card
  card.domain = undefined
  return card
}

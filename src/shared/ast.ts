/**
 * The AST support layer for the future text, dependency and import parsers.
 *
 * This is deliberately *not* a parser: it supplies the token stream, spans,
 * node/tree model, iterative visitor and derived index that a parser in
 * `src/host/` will build. Everything is iterative (no recursion over the tree),
 * so a pathological source file cannot overflow the call stack.
 *
 * Node kinds are a string generic so each parser can keep its own closed union.
 * Spans are half-open (`start` inclusive, `end` exclusive) UTF-16 offsets with a
 * 1-based line and column for error messages.
 *
 * No Node, DOM, React or external dependency is used.
 */
import { InvalidArgumentError, InvalidStateError } from './error.js'
import { OrderedMap } from './map.js'

/**
 * A half-open source range: `start` inclusive, `end` exclusive, both UTF-16
 * offsets into the original text. `line` and `column` are 1-based.
 */
export interface SourceSpan {
  start: number
  end: number
  line: number
  column: number
}

/** The lexical categories the shared token contract recognises. */
export type TokenKind =
  | 'identifier'
  | 'keyword'
  | 'string'
  | 'number'
  | 'punctuation'
  | 'operator'
  | 'comment'
  | 'whitespace'
  | 'newline'
  | 'eof'
  | 'unknown'

/** One lexical token with its source text and span. */
export interface Token {
  kind: TokenKind
  text: string
  span: SourceSpan
}

/**
 * Merge two source spans in reading order.
 *
 * Time O(1), space O(1). The result starts at `left.start`, ends at `right.end`,
 * and keeps `left`'s line/column because that is where the merged range starts.
 * Throws `InvalidArgumentError` when `left` starts after `right` ends.
 */
export function mergeSpans(left: SourceSpan, right: SourceSpan): SourceSpan {
  if (left.start > right.end) {
    throw new InvalidArgumentError('cannot merge spans that are not in reading order', {
      left,
      right,
    })
  }
  return { start: left.start, end: right.end, line: left.line, column: left.column }
}

/** JSON projection of an AST node produced by `AstTree.toJSON`. */
export interface AstJson<K extends string = string> {
  kind: K
  span: SourceSpan
  value?: string
  children: Array<AstJson<K>>
}

/**
 * Visitor hooks for `visitAst`. Both methods are optional; `enter` runs before
 * a node's children and `leave` after them.
 */
export interface AstVisitor<K extends string = string> {
  enter?(node: AstNode<K>): void
  leave?(node: AstNode<K>): void
}

/**
 * One node in a parsed tree.
 *
 * Fields are public because parsers mutate `span` while extending a node and
 * rethread children. Operations:
 *  - `addChild`/`removeChild`: O(depth + children) and O(children);
 *  - `walk`, `descendants`, `find`, `findAll`: O(subtree) time, O(height) space;
 *  - `ancestors`, `depth`: O(depth) time, O(depth) space.
 *
 * `addChild` rejects a child that is already attached elsewhere, a duplicate
 * child, and any edge that would create a cycle; `AstTree.validate` re-checks
 * the whole shape.
 */
export class AstNode<K extends string = string> {
  /** Parser-defined node kind. */
  readonly kind: K
  /** Half-open source range; mutable while a parser extends the node. */
  span: SourceSpan
  /** Optional text payload (identifier name, literal value, ...). */
  value: string | undefined
  /** Owning parent, or `undefined` for a root. */
  parent: AstNode<K> | undefined
  /** Children in source order. */
  readonly children: Array<AstNode<K>>

  /**
   * @param kind Parser-defined kind.
   * @param span Half-open source range with 1-based line/column.
   * @param value Optional text payload.
   * Time O(1), space O(1). Throws `InvalidArgumentError` for a malformed span.
   */
  constructor(kind: K, span: SourceSpan, value?: string) {
    assertSpan(span)
    this.kind = kind
    this.span = span
    this.value = value
    this.parent = undefined
    this.children = []
  }

  /**
   * Attach a child at the end of `children`.
   * Time O(depth + children), space O(depth) for the cycle guard. Throws
   * `InvalidArgumentError` if the child is this node, is already attached to a
   * different parent, is already present here, or is an ancestor (cycle).
   */
  addChild(child: AstNode<K>): void {
    if (this.children.includes(child)) {
      throw new InvalidArgumentError('AST node already has this child', { kind: child.kind })
    }
    if (child.parent !== undefined && child.parent !== this) {
      throw new InvalidArgumentError('AST child already belongs to another parent', {
        kind: child.kind,
      })
    }
    const seen = new Set<AstNode<K>>()
    let ancestor: AstNode<K> | undefined = this
    while (ancestor !== undefined) {
      if (ancestor === child) {
        throw new InvalidArgumentError('adding this child would create an AST cycle', {
          kind: child.kind,
        })
      }
      if (seen.has(ancestor)) {
        throw new InvalidStateError('AST parent chain already contains a cycle')
      }
      seen.add(ancestor)
      ancestor = ancestor.parent
    }
    child.parent = this
    this.children.push(child)
  }

  /**
   * Detach one child. Time O(children), space O(1).
   * Returns false when the child is not attached here.
   */
  removeChild(child: AstNode<K>): boolean {
    const index = this.children.indexOf(child)
    if (index < 0) return false
    this.children.splice(index, 1)
    child.parent = undefined
    return true
  }

  /**
   * Pre-order walk of this subtree (self first, then children in source order).
   * Time O(subtree), space O(height) for the explicit stack.
   */
  *walk(): IterableIterator<AstNode<K>> {
    const stack: Array<AstNode<K>> = [this]
    while (stack.length > 0) {
      const node = stack.pop()
      if (node === undefined) continue
      yield node
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        stack.push(node.children[index])
      }
    }
  }

  /**
   * Pre-order walk of the children, excluding this node.
   * Time O(descendants), space O(height).
   */
  *descendants(): IterableIterator<AstNode<K>> {
    let first = true
    for (const node of this.walk()) {
      if (first) {
        first = false
        continue
      }
      yield node
    }
  }

  /**
   * First node in pre-order (including this node) that satisfies `predicate`.
   * Time O(subtree), space O(height).
   */
  find(predicate: (node: AstNode<K>) => boolean): AstNode<K> | undefined {
    for (const node of this.walk()) {
      if (predicate(node)) return node
    }
    return undefined
  }

  /**
   * Every node in pre-order that satisfies `predicate`.
   * Time O(subtree), space O(matches + height).
   */
  findAll(predicate: (node: AstNode<K>) => boolean): Array<AstNode<K>> {
    const matches: Array<AstNode<K>> = []
    for (const node of this.walk()) {
      if (predicate(node)) matches.push(node)
    }
    return matches
  }

  /**
   * Parent chain, nearest first, excluding this node.
   * Time O(depth), space O(depth) for the cycle guard. Throws
   * `InvalidStateError` if the parent chain is malformed into a cycle.
   */
  *ancestors(): IterableIterator<AstNode<K>> {
    const seen = new Set<AstNode<K>>()
    let current = this.parent
    while (current !== undefined) {
      if (seen.has(current)) throw new InvalidStateError('AST parent chain contains a cycle')
      seen.add(current)
      yield current
      current = current.parent
    }
  }

  /**
   * Distance from the root: 0 for a node without a parent.
   * Time O(depth), space O(depth) for the cycle guard. Throws
   * `InvalidStateError` if the parent chain is malformed into a cycle.
   */
  get depth(): number {
    const seen = new Set<AstNode<K>>()
    let current = this.parent
    let depth = 0
    while (current !== undefined) {
      if (seen.has(current)) throw new InvalidStateError('AST parent chain contains a cycle')
      seen.add(current)
      depth += 1
      current = current.parent
    }
    return depth
  }
}

/**
 * A parsed tree with exactly one root.
 *
 * `walk`/`toArray` are O(nodes), `findAll` is O(nodes), `size` is O(nodes),
 * `validate` is O(nodes) time and space, and `toJSON` is O(nodes) time and
 * space. All walks are iterative. `validate` checks the single-root rule, that
 * every parent link points back at the actual parent, that no node is reachable
 * twice (so the tree is acyclic and has no shared subtrees), that spans are
 * well formed, and that child spans are nested inside their parent.
 */
export class AstTree<K extends string = string> {
  /** Root node, or `undefined` for an empty tree. */
  root: AstNode<K> | undefined

  /**
   * @param root Optional root; throws `InvalidArgumentError` if it already has
   * a parent (a tree owns exactly one root).
   * Time O(1), space O(1).
   */
  constructor(root?: AstNode<K>) {
    if (root !== undefined && root.parent !== undefined) {
      throw new InvalidArgumentError('AST root must not have a parent')
    }
    this.root = root
  }

  /** Number of nodes in the tree. Time O(nodes), space O(height). */
  get size(): number {
    let total = 0
    for (const node of this.walk()) {
      void node
      total += 1
    }
    return total
  }

  /** Pre-order walk from the root; empty when the tree is empty. Time O(n). */
  *walk(): IterableIterator<AstNode<K>> {
    if (this.root === undefined) return
    yield* this.root.walk()
  }

  /** Every node in pre-order that satisfies `predicate`. Time O(n). */
  findAll(predicate: (node: AstNode<K>) => boolean): Array<AstNode<K>> {
    if (this.root === undefined) return []
    return this.root.findAll(predicate)
  }

  /** Pre-order snapshot. Time O(n), space O(n). */
  toArray(): Array<AstNode<K>> {
    return [...this.walk()]
  }

  /** Remove the root. Time O(1) for the reference, O(n) for reclamation. */
  clear(): void {
    this.root = undefined
  }

  /**
   * JSON projection, or `undefined` for an empty tree.
   * Time O(n), space O(n); iterative, so deep trees are safe.
   */
  toJSON(): AstJson<K> | undefined {
    if (this.root === undefined) return undefined
    const root = toAstJson(this.root)
    const stack: Array<{ node: AstNode<K>; json: AstJson<K> }> = [{ node: this.root, json: root }]
    while (stack.length > 0) {
      const frame = stack.pop()
      if (frame === undefined) continue
      for (const child of frame.node.children) {
        const childJson = toAstJson(child)
        frame.json.children.push(childJson)
        stack.push({ node: child, json: childJson })
      }
    }
    return root
  }

  /**
   * Check the single-root/acyclic/parent/nested-span invariants.
   * Time O(n), space O(n) for the visited set and stack. Returns true when the
   * tree is well formed; an empty tree is valid.
   */
  validate(): boolean {
    const root = this.root
    if (root === undefined) return true
    if (root.parent !== undefined) return false
    const visited = new Set<AstNode<K>>()
    const stack: Array<AstNode<K>> = [root]
    while (stack.length > 0) {
      const node = stack.pop()
      if (node === undefined) continue
      if (visited.has(node)) return false
      visited.add(node)
      if (!isSpanWellFormed(node.span)) return false
      for (const child of node.children) {
        if (child.parent !== node) return false
        if (child.span.start < node.span.start) return false
        if (child.span.end > node.span.end) return false
        stack.push(child)
      }
    }
    return true
  }
}

/**
 * Run a visitor over every node, iteratively, in pre-order with `enter` before
 * children and `leave` after them.
 *
 * Time O(nodes + visitor work), space O(nodes) worst case for the explicit
 * frame stack; no recursion. A visitor that mutates the tree while visiting is
 * outside the contract.
 */
export function visitAst<K extends string>(tree: AstTree<K>, visitor: AstVisitor<K>): void {
  if (tree.root === undefined) return
  const stack: Array<{ node: AstNode<K>; leaving: boolean }> = [{ node: tree.root, leaving: false }]
  while (stack.length > 0) {
    const frame = stack.pop()
    if (frame === undefined) continue
    if (frame.leaving) {
      visitor.leave?.(frame.node)
      continue
    }
    visitor.enter?.(frame.node)
    stack.push({ node: frame.node, leaving: true })
    for (let index = frame.node.children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: frame.node.children[index], leaving: false })
    }
  }
}

/**
 * A cursor over a token array.
 *
 * `peek`, `next`, `expect`, `save` and `restore` are all O(1); the constructor
 * copies the token array in O(n) so later mutation of the caller's array cannot
 * change parser behaviour. `eof` is true when the cursor is past the end or the
 * current token is an `eof` token. An `expect` mismatch throws
 * `InvalidArgumentError` with the expected and actual token data.
 */
export class TokenStream {
  private readonly tokens: Token[]
  private cursor = 0

  /**
   * @param tokens Tokens in source order; the array is copied.
   * Time O(n), space O(n).
   */
  constructor(tokens: Token[]) {
    this.tokens = [...tokens]
  }

  /** Number of tokens in the stream. Time O(1). */
  get size(): number {
    return this.tokens.length
  }

  /** Current cursor offset (0..size). Time O(1). */
  get position(): number {
    return this.cursor
  }

  /** True past the end, or when the current token is `eof`. Time O(1). */
  get eof(): boolean {
    if (this.cursor >= this.tokens.length) return true
    return this.tokens[this.cursor].kind === 'eof'
  }

  /**
   * Look ahead without advancing. `peek(0)` is the current token; past the end
   * returns `undefined`. Time O(1), space O(1). Throws `InvalidArgumentError`
   * for a negative or non-integer offset.
   */
  peek(offset = 0): Token | undefined {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new InvalidArgumentError('token lookahead offset must be a non-negative integer', {
        offset,
      })
    }
    return this.tokens[this.cursor + offset]
  }

  /**
   * Consume and return the current token, advancing one position.
   * Time O(1), space O(1). Returns `undefined` at the end.
   */
  next(): Token | undefined {
    if (this.cursor >= this.tokens.length) return undefined
    const token = this.tokens[this.cursor]
    this.cursor += 1
    return token
  }

  /**
   * Consume the current token only if its kind (and optional exact text)
   * matches; otherwise throw `InvalidArgumentError`.
   * Time O(1), space O(1).
   */
  expect(kind: TokenKind, text?: string): Token {
    const token = this.peek()
    if (token === undefined) {
      throw new InvalidArgumentError('token stream ended before the expected token', {
        expectedKind: kind,
        expectedText: text,
      })
    }
    if (token.kind !== kind || (text !== undefined && token.text !== text)) {
      throw new InvalidArgumentError('unexpected token', {
        expectedKind: kind,
        expectedText: text,
        actualKind: token.kind,
        actualText: token.text,
      })
    }
    this.cursor += 1
    return token
  }

  /** Capture the current cursor for a later `restore`. Time O(1). */
  save(): number {
    return this.cursor
  }

  /**
   * Return to a cursor captured by `save`. Time O(1), space O(1).
   * Throws `InvalidArgumentError` for a non-integer or out-of-range position.
   */
  restore(position: number): void {
    if (!Number.isInteger(position) || position < 0 || position > this.tokens.length) {
      throw new InvalidArgumentError('cannot restore the token stream to that position', {
        position,
        size: this.tokens.length,
      })
    }
    this.cursor = position
  }
}

/**
 * Derived lookup index over an AST.
 *
 * Built in O(n log n) because the start-offset key list is sorted; `ofKind` and
 * `startingAt` are O(1) average map lookups plus O(k) copying; `size` and
 * `kinds` are O(1) to obtain. `smallestContaining(offset)` binary-searches the
 * sorted start keys and scans backwards, O(log n) typical and O(n) worst case
 * for a pathological span layout; a span with `start === end` contains no
 * offset.
 *
 * The index is a snapshot: build a new one after mutating the tree. It uses
 * `OrderedMap` from `./map.js`, so kind buckets preserve first-appearance order
 * and start buckets preserve traversal order within a start offset.
 */
export class AstIndex<K extends string = string> {
  private readonly nodesByKind = new OrderedMap<K, Array<AstNode<K>>>()
  private readonly nodesByStart = new OrderedMap<number, Array<AstNode<K>>>()
  private readonly starts: number[] = []
  private total = 0

  /**
   * @param tree Tree to index; it is read once and not retained.
   * Time O(n log n), space O(n).
   */
  constructor(tree: AstTree<K>) {
    for (const node of tree.toArray()) {
      this.total += 1
      const kindBucket = this.nodesByKind.get(node.kind)
      if (kindBucket === undefined) this.nodesByKind.set(node.kind, [node])
      else kindBucket.push(node)
      const startBucket = this.nodesByStart.get(node.span.start)
      if (startBucket === undefined) this.nodesByStart.set(node.span.start, [node])
      else startBucket.push(node)
    }
    this.starts = [...this.nodesByStart.keys()].sort((left, right) => left - right)
  }

  /** Number of indexed nodes. Time O(1). */
  get size(): number {
    return this.total
  }

  /**
   * Nodes of one kind, in pre-order. Time O(1) average plus O(k) copy.
   * Returns a new array, so callers cannot mutate the index.
   */
  ofKind(kind: K): Array<AstNode<K>> {
    const bucket = this.nodesByKind.get(kind)
    return bucket === undefined ? [] : [...bucket]
  }

  /**
   * Nodes that start exactly at `offset`, in pre-order.
   * Time O(1) average plus O(k) copy.
   */
  startingAt(offset: number): Array<AstNode<K>> {
    const bucket = this.nodesByStart.get(offset)
    return bucket === undefined ? [] : [...bucket]
  }

  /**
   * Innermost indexed node whose half-open span contains `offset`, or
   * `undefined`. Time O(log n + c) typical and O(n) worst case; space O(1).
   */
  smallestContaining(offset: number): AstNode<K> | undefined {
    let low = 0
    let high = this.starts.length - 1
    let candidate = -1
    while (low <= high) {
      const middle = (low + high) >>> 1
      if (this.starts[middle] <= offset) {
        candidate = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    for (let cursor = candidate; cursor >= 0; cursor -= 1) {
      const bucket = this.nodesByStart.get(this.starts[cursor])
      if (bucket === undefined) continue
      let best: AstNode<K> | undefined
      for (const node of bucket) {
        if (node.span.start > offset || node.span.end <= offset) continue
        if (best === undefined || node.span.end - node.span.start < best.span.end - best.span.start) {
          best = node
        }
      }
      if (best !== undefined) return best
    }
    return undefined
  }

  /** Kinds present in the index, in first-appearance order. Time O(1) to obtain. */
  kinds(): IterableIterator<K> {
    return this.nodesByKind.keys()
  }
}

/** Throw unless `span` has integer offsets and 1-based positions. */
function assertSpan(span: SourceSpan): void {
  if (!isSpanWellFormed(span)) {
    throw new InvalidArgumentError('source span must have 0 <= start <= end and 1-based line/column', {
      span,
    })
  }
}

/** Non-throwing form of the span check, used by `validate`. */
function isSpanWellFormed(span: SourceSpan): boolean {
  if (!Number.isInteger(span.start) || !Number.isInteger(span.end)) return false
  if (span.start < 0 || span.end < span.start) return false
  if (!Number.isInteger(span.line) || span.line < 1) return false
  if (!Number.isInteger(span.column) || span.column < 1) return false
  return true
}

/** Shallow JSON projection of one node; children are filled by the caller. */
function toAstJson<K extends string>(node: AstNode<K>): AstJson<K> {
  const json: AstJson<K> = {
    kind: node.kind,
    span: { ...node.span },
    children: [],
  }
  if (node.value !== undefined) json.value = node.value
  return json
}

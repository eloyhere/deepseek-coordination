/**
 * A prefix tree over strings, for import-path prefix matching, keyword lookup
 * and any other "does something start with this" question.
 *
 * Keys are compared by UTF-16 code unit, matching `hashString` and plain string
 * indexing; a caller that needs code-point or locale-aware behaviour must
 * normalise the string first. Child edges are kept in insertion order, so
 * prefix traversal is deterministic but not lexicographic unless insertion
 * order happened to be sorted.
 *
 * Every operation is O(k) in the key length, with O(k) extra space for the
 * insertion/deletion path; total space is O(total characters) plus one node per
 * distinct prefix. No Node, DOM, React or external dependency is used.
 */
import { InvalidArgumentError } from './error.js'

interface TrieNode<V> {
  readonly children: Map<string, TrieNode<V>>
  terminal: boolean
  value: V | undefined
}

/** Create an empty trie node. */
function createTrieNode<V>(): TrieNode<V> {
  return { children: new Map<string, TrieNode<V>>(), terminal: false, value: undefined }
}

/**
 * A string-keyed prefix tree.
 *
 * `insert`, `get`, `has`, `startsWith` and `delete` are O(k) time in the key
 * length k; `keysWithPrefix`/`entriesWithPrefix` are O(k + m) for m emitted
 * entries; full iteration and `toArray` are O(total characters). Space is
 * O(total characters) for the stored keys. An empty string is a legal key and
 * lives at the root. `insert` of an existing key updates its value and returns
 * false; `delete` prunes now-useless nodes.
 */
export class Trie<V> implements Iterable<[string, V]> {
  private root: TrieNode<V> = createTrieNode<V>()
  private count = 0

  /**
   * @param entries Optional initial string/value pairs, inserted in order.
   * Time O(total characters), space O(total characters).
   */
  constructor(entries?: Iterable<readonly [string, V]>) {
    if (entries === undefined) return
    for (const [key, value] of entries) this.insert(key, value)
  }

  /** Number of stored keys. Time O(1). */
  get size(): number {
    return this.count
  }

  /**
   * Insert or update a key. Time O(k) in the key length, space O(k) for the new
   * nodes. Returns true when the key was new.
   */
  insert(key: string, value: V): boolean {
    let node = this.root
    for (let index = 0; index < key.length; index += 1) {
      const character = key[index]
      let child = node.children.get(character)
      if (child === undefined) {
        child = createTrieNode<V>()
        node.children.set(character, child)
      }
      node = child
    }
    if (node.terminal) {
      node.value = value
      return false
    }
    node.terminal = true
    node.value = value
    this.count += 1
    return true
  }

  /**
   * Read the value stored under an exact key. Time O(k), space O(1).
   * Returns `undefined` when absent; use `has` when `undefined` is a value.
   */
  get(key: string): V | undefined {
    const node = this.findNode(key)
    return node !== undefined && node.terminal ? node.value : undefined
  }

  /** Whether an exact key exists. Time O(k), space O(1). */
  has(key: string): boolean {
    const node = this.findNode(key)
    return node !== undefined && node.terminal
  }

  /**
   * Whether at least one stored key starts with `prefix` (an empty prefix is
   * always true). Time O(k), space O(1).
   */
  startsWith(prefix: string): boolean {
    return this.findNode(prefix) !== undefined
  }

  /**
   * Keys starting with `prefix`, in child insertion order.
   * Time O(k + m) for m emitted keys, space O(k + m).
   */
  keysWithPrefix(prefix: string): string[] {
    const keys: string[] = []
    for (const [key] of this.entriesWithPrefix(prefix)) keys.push(key)
    return keys
  }

  /**
   * Key/value pairs whose key starts with `prefix`, in child insertion order.
   * Time O(k + m) for m emitted pairs, space O(k + m).
   */
  entriesWithPrefix(prefix: string): Array<[string, V]> {
    const start = this.findNode(prefix)
    if (start === undefined) return []
    return [...this.iterate(start, prefix)]
  }

  /**
   * Remove a key and prune nodes that no longer lead to another key.
   * Time O(k), space O(k) for the recorded path. Returns false when absent.
   */
  delete(key: string): boolean {
    const nodes: Array<TrieNode<V>> = [this.root]
    const characters: string[] = []
    let node = this.root
    for (let index = 0; index < key.length; index += 1) {
      const character = key[index]
      const child = node.children.get(character)
      if (child === undefined) return false
      nodes.push(child)
      characters.push(character)
      node = child
    }
    if (!node.terminal) return false
    node.terminal = false
    node.value = undefined
    this.count -= 1
    for (let index = nodes.length - 1; index >= 1; index -= 1) {
      const current = nodes[index]
      if (current.terminal || current.children.size > 0) break
      nodes[index - 1].children.delete(characters[index - 1])
    }
    return true
  }

  /** Remove every key. Time O(total characters) for reclamation, space O(1). */
  clear(): void {
    this.root = createTrieNode<V>()
    this.count = 0
  }

  /**
   * Snapshot of every key/value pair in child insertion order.
   * Time O(total characters), space O(n).
   */
  toArray(): Array<[string, V]> {
    return [...this.iterate(this.root, '')]
  }

  /** Iterate every key/value pair in child insertion order. Time O(n). */
  [Symbol.iterator](): IterableIterator<[string, V]> {
    return this.iterate(this.root, '')
  }

  /** Walk to the node representing `key`, or undefined. Time O(k). */
  private findNode(key: string): TrieNode<V> | undefined {
    let node = this.root
    for (let index = 0; index < key.length; index += 1) {
      const child = node.children.get(key[index])
      if (child === undefined) return undefined
      node = child
    }
    return node
  }

  /**
   * Depth-first iteration of a subtree in child insertion order. Time O(m) for
   * m visited nodes, space O(m) worst case for the explicit stack.
   */
  private *iterate(start: TrieNode<V>, prefix: string): IterableIterator<[string, V]> {
    const stack: Array<{ node: TrieNode<V>; prefix: string }> = [{ node: start, prefix }]
    while (stack.length > 0) {
      const frame = stack.pop()
      if (frame === undefined) continue
      if (frame.node.terminal) yield [frame.prefix, frame.node.value as V]
      const children = [...frame.node.children.entries()]
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const entry = children[index]
        stack.push({ node: entry[1], prefix: frame.prefix + entry[0] })
      }
    }
  }
}

/**
 * Validate that a trie key is a string, for callers bridging untyped data.
 *
 * Time O(1), space O(1). Throws `InvalidArgumentError` when `key` is not a
 * string. Exposed because the parser layer will receive keys from JSON and
 * must fail loudly rather than coerce silently.
 */
export function assertTrieKey(key: unknown): asserts key is string {
  if (typeof key !== 'string') {
    throw new InvalidArgumentError('trie keys must be strings', { key: typeof key })
  }
}

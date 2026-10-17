/**
 * Map-shaped collections used by the coordination modules.
 *
 * `OrderedMap` preserves insertion order and offers O(1) access to both ends,
 * which is what the LRU sets in `./lru.js` and the AST index in `./ast.js`
 * need. `UnorderedMap` is a deliberately thin wrapper around the native `Map`:
 * no order promise, the engine's O(1) average dictionary underneath.
 *
 * Both are iterable, expose `size`, `clear` and `toArray`, and document their
 * order precisely. Neither touches Node, the DOM or React.
 */
import { LinearNode } from './node.js'

interface OrderedMapEntry<K, V> {
  readonly key: K
  value: V
}

/**
 * Insertion-order map backed by a native `Map` plus a doubly linked list.
 *
 * Every operation is O(1) average time and O(1) space per entry: the native
 * map finds the node, and the list gives O(1) appends and O(1) removal of the
 * first or last entry. Iteration is O(n) and follows insertion order; updating
 * an existing key keeps its original position, as `Map` does. Total space O(n).
 *
 * Caveat: iteration is live. Mutating the map during iteration is not supported
 * and can skip or repeat entries.
 */
export class OrderedMap<K, V> implements Iterable<[K, V]> {
  private readonly nodes = new Map<K, LinearNode<OrderedMapEntry<K, V>>>()
  private head: LinearNode<OrderedMapEntry<K, V>> | undefined
  private tail: LinearNode<OrderedMapEntry<K, V>> | undefined

  /**
   * @param entries Optional initial entries, inserted in iteration order.
   * Time O(n), space O(n) for n initial entries.
   */
  constructor(entries?: Iterable<readonly [K, V]>) {
    if (entries === undefined) return
    for (const [key, value] of entries) this.set(key, value)
  }

  /** Number of entries. Time O(1). */
  get size(): number {
    return this.nodes.size
  }

  /**
   * Read a value without changing its position. Time O(1) average, space O(1).
   * Returns `undefined` for a missing key; pair with `has` when `undefined` is
   * a legal value.
   */
  get(key: K): V | undefined {
    return this.nodes.get(key)?.value.value
  }

  /**
   * Insert a new key at the tail, or update an existing value in place without
   * moving it. Time O(1) average, space O(1) for a new entry.
   */
  set(key: K, value: V): this {
    const node = this.nodes.get(key)
    if (node !== undefined) {
      node.value.value = value
      return this
    }
    const created = new LinearNode<OrderedMapEntry<K, V>>({ key, value })
    if (this.tail === undefined) {
      this.head = created
      this.tail = created
    } else {
      created.previous = this.tail
      this.tail.next = created
      this.tail = created
    }
    this.nodes.set(key, created)
    return this
  }

  /**
   * Remove a key from wherever it sits in the order. Time O(1) average,
   * space O(1). Returns false when the key is absent.
   */
  delete(key: K): boolean {
    const node = this.nodes.get(key)
    if (node === undefined) return false
    this.unlink(node)
    this.nodes.delete(key)
    return true
  }

  /**
   * Remove the first (oldest inserted) entry. Time O(1) average, space O(1).
   * Returns false when the map is empty.
   */
  deleteFirst(): boolean {
    if (this.head === undefined) return false
    return this.delete(this.head.value.key)
  }

  /**
   * Remove the last (most recently inserted) entry. Time O(1) average,
   * space O(1). Returns false when the map is empty.
   */
  deleteLast(): boolean {
    if (this.tail === undefined) return false
    return this.delete(this.tail.value.key)
  }

  /** Membership test. Time O(1) average, space O(1). */
  has(key: K): boolean {
    return this.nodes.has(key)
  }

  /**
   * Value of the first inserted surviving entry, or `undefined` when empty.
   * Time O(1), space O(1).
   */
  first(): V | undefined {
    return this.head?.value.value
  }

  /**
   * Value of the last inserted surviving entry, or `undefined` when empty.
   * Time O(1), space O(1).
   */
  last(): V | undefined {
    return this.tail?.value.value
  }

  /** Key of the first inserted surviving entry. Time O(1), space O(1). */
  firstKey(): K | undefined {
    return this.head?.value.key
  }

  /** Key of the last inserted surviving entry. Time O(1), space O(1). */
  lastKey(): K | undefined {
    return this.tail?.value.key
  }

  /**
   * Remove every entry. Time O(n) for the nodes the runtime reclaims; the map
   * clear itself is O(1) amortized.
   */
  clear(): void {
    this.nodes.clear()
    this.head = undefined
    this.tail = undefined
  }

  /** Keys in insertion order. Time O(n), space O(1) per step. */
  *keys(): IterableIterator<K> {
    let node = this.head
    while (node !== undefined) {
      yield node.value.key
      node = node.next
    }
  }

  /** Values in insertion order. Time O(n), space O(1) per step. */
  *values(): IterableIterator<V> {
    let node = this.head
    while (node !== undefined) {
      yield node.value.value
      node = node.next
    }
  }

  /**
   * `[key, value]` pairs in insertion order. Time O(n), space O(1) per step.
   */
  *entries(): IterableIterator<[K, V]> {
    let node = this.head
    while (node !== undefined) {
      yield [node.value.key, node.value.value]
      node = node.next
    }
  }

  /** Snapshot of the entries in insertion order. Time O(n), space O(n). */
  toArray(): Array<[K, V]> {
    return [...this.entries()]
  }

  /** Alias of `entries`. Time O(n). */
  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries()
  }

  /** Splice a node out of the list in O(1), clearing its links. */
  private unlink(node: LinearNode<OrderedMapEntry<K, V>>): void {
    if (node.previous === undefined) this.head = node.next
    else node.previous.next = node.next
    if (node.next === undefined) this.tail = node.previous
    else node.next.previous = node.previous
    node.previous = undefined
    node.next = undefined
  }
}

/**
 * A thin, order-free wrapper around the native `Map`.
 *
 * Every operation inherits `Map`'s O(1) average time (O(n) worst case under
 * adversarial key hashing) and O(1) space per entry. Iteration and `toArray`
 * expose the engine's native order, which this class deliberately does not
 * promise; callers that need a stable order must use `OrderedMap`.
 */
export class UnorderedMap<K, V> implements Iterable<[K, V]> {
  private readonly store: Map<K, V>

  /**
   * @param entries Optional initial entries.
   * Time O(n), space O(n) for n initial entries.
   */
  constructor(entries?: Iterable<readonly [K, V]>) {
    this.store = new Map<K, V>(entries)
  }

  /** Number of entries. Time O(1). */
  get size(): number {
    return this.store.size
  }

  /** Read a value. Time O(1) average, space O(1). */
  get(key: K): V | undefined {
    return this.store.get(key)
  }

  /** Insert or replace a value. Time O(1) average, space O(1) per new entry. */
  set(key: K, value: V): this {
    this.store.set(key, value)
    return this
  }

  /** Membership test. Time O(1) average, space O(1). */
  has(key: K): boolean {
    return this.store.has(key)
  }

  /** Remove a key. Time O(1) average, space O(1). */
  delete(key: K): boolean {
    return this.store.delete(key)
  }

  /** Remove every entry. Time O(n) for reclamation, O(1) amortized for the map. */
  clear(): void {
    this.store.clear()
  }

  /** Keys in the engine's native order; no order promise. Time O(n). */
  keys(): IterableIterator<K> {
    return this.store.keys()
  }

  /** Values in the engine's native order; no order promise. Time O(n). */
  values(): IterableIterator<V> {
    return this.store.values()
  }

  /** Pairs in the engine's native order; no order promise. Time O(n). */
  entries(): IterableIterator<[K, V]> {
    return this.store.entries()
  }

  /** Snapshot in the engine's native order. Time O(n), space O(n). */
  toArray(): Array<[K, V]> {
    return [...this.store.entries()]
  }

  /** Alias of `entries`. Time O(n). */
  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.store.entries()
  }
}

/**
 * Capacity-bounded caches: key/value LRUs, LRU sets and recency-ordered lists.
 *
 * The two key/value caches are thin public facades over `HashLruList` and
 * `HashWeakLruList` in `./hash.js`, so there is exactly one array-LRU
 * implementation in the library and no second copy of its tombstone/compaction
 * logic to drift out of sync.
 *
 * Set and list variants share the same capacity contract: a capacity is an
 * integer clamped to 1..100000, every structure evicts down to exactly its
 * capacity, and `resize` evicts immediately when it shrinks. "LRU" here means
 * recency as defined by the structure: `get`/`touch`/`add` refresh recency for
 * the keyed caches and sets, while the ordered list treats `push` as insertion
 * recency and exposes `touch(index)` for an explicit promotion (plain reads
 * never reorder a list, so an index stays valid until a mutation).
 *
 * No Node, DOM, React or external dependency is used.
 */
import { InvalidArgumentError } from './error.js'
import { HashLruList, HashWeakLruList, normaliseCapacity } from './hash.js'
import { OrderedMap } from './map.js'

/**
 * General-purpose key/value LRU cache.
 *
 * `get` and `touch` promote the key to most-recently used, `peek` and `has` do
 * not, and `set` always promotes. Time O(1) amortized per operation, space
 * O(capacity). Iteration and `toArray` run most-recent first. Missing keys read
 * as `undefined`; use `has` when `undefined` is a legal value.
 */
export class LruList<K, V> implements Iterable<[K, V]> {
  private readonly store: HashLruList<K, V>

  /**
   * @param capacity Maximum live entries; clamped to 1..100000.
   * Time O(1), space O(1).
   */
  constructor(capacity = 64) {
    this.store = new HashLruList<K, V>(capacity)
  }

  /** Number of live entries. Time O(1). */
  get size(): number {
    return this.store.size
  }

  /** Configured maximum number of live entries. Time O(1). */
  get capacity(): number {
    return this.store.capacity
  }

  /**
   * Read a value and promote its key. Time O(1) amortized, space O(1).
   */
  get(key: K): V | undefined {
    return this.store.get(key)
  }

  /** Read a value without promoting it. Time O(1), space O(1). */
  peek(key: K): V | undefined {
    return this.store.peek(key)
  }

  /**
   * Promote a key without reading its value. Time O(1) amortized.
   * Returns false when the key is absent.
   */
  touch(key: K): boolean {
    return this.store.touch(key)
  }

  /**
   * Insert or update a key, promote it, and evict the least-recently used entry
   * when over capacity. Time O(1) amortized, space O(1).
   */
  set(key: K, value: V): this {
    this.store.set(key, value)
    return this
  }

  /** Remove a key. Time O(1) amortized. Returns false when absent. */
  delete(key: K): boolean {
    return this.store.delete(key)
  }

  /** Membership test that never promotes. Time O(1), space O(1). */
  has(key: K): boolean {
    return this.store.has(key)
  }

  /**
   * Change the capacity, evicting least-recently used entries when it shrinks.
   * Time O(1) amortized to grow, O(k) to shrink past k entries.
   */
  resize(capacity: number): void {
    this.store.resize(capacity)
  }

  /** Remove every entry. Time O(n) for reclamation. */
  clear(): void {
    this.store.clear()
  }

  /** Keys from most-recently used to least-recently used. Time O(n). */
  keys(): IterableIterator<K> {
    return this.store.keys()
  }

  /** Values from most-recently used to least-recently used. Time O(n). */
  values(): IterableIterator<V> {
    return this.store.values()
  }

  /** Pairs from most-recently used to least-recently used. Time O(n). */
  entries(): IterableIterator<[K, V]> {
    return this.store.entries()
  }

  /** Snapshot in most-recent-first order. Time O(n), space O(n). */
  toArray(): Array<[K, V]> {
    return this.store.toArray()
  }

  /** Alias of `entries`. Time O(n). */
  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.store.entries()
  }
}

/**
 * Weak-key variant of `LruList`.
 *
 * Keys are held through `WeakRef`; values are strong. `get`/`touch` promote,
 * `peek`/`has` do not, iteration skips collected keys. Time O(1) amortized per
 * keyed operation; `size` is O(n) because it sweeps collected references, and
 * `clear` is O(1) plus reclamation. Garbage-collection timing is not
 * deterministic, so a collected entry may occupy capacity until the next sweep
 * or finalizer callback. Space O(capacity).
 */
export class WeakLruList<K extends object, V> implements Iterable<[K, V]> {
  private readonly store: HashWeakLruList<K, V>

  /**
   * @param capacity Maximum live entries; clamped to 1..100000.
   * Time O(1), space O(1).
   */
  constructor(capacity = 64) {
    this.store = new HashWeakLruList<K, V>(capacity)
  }

  /** Number of reachable entries; sweeps collected keys first. Time O(n). */
  get size(): number {
    return this.store.size
  }

  /** Configured maximum number of live entries. Time O(1). */
  get capacity(): number {
    return this.store.capacity
  }

  /** Read and promote a live value. Time O(1) amortized. */
  get(key: K): V | undefined {
    return this.store.get(key)
  }

  /** Read a live value without promoting it. Time O(1). */
  peek(key: K): V | undefined {
    return this.store.peek(key)
  }

  /** Promote a live key. Time O(1) amortized. */
  touch(key: K): boolean {
    return this.store.touch(key)
  }

  /** Insert or update a key and evict the least-recently used entry. */
  set(key: K, value: V): this {
    this.store.set(key, value)
    return this
  }

  /** Remove a key. Time O(1) amortized. */
  delete(key: K): boolean {
    return this.store.delete(key)
  }

  /** Membership test that never promotes. Time O(1). */
  has(key: K): boolean {
    return this.store.has(key)
  }

  /** Change the capacity, evicting least-recently used entries when it shrinks. */
  resize(capacity: number): void {
    this.store.resize(capacity)
  }

  /** Remove every entry and forget every key reference. */
  clear(): void {
    this.store.clear()
  }

  /** Live keys, most-recently used first. Time O(n). */
  keys(): IterableIterator<K> {
    return this.store.keys()
  }

  /** Live values, most-recently used first. Time O(n). */
  values(): IterableIterator<V> {
    return this.store.values()
  }

  /** Live pairs, most-recently used first. Time O(n). */
  entries(): IterableIterator<[K, V]> {
    return this.store.entries()
  }

  /** Snapshot of live entries, most-recent first. Time O(n), space O(n). */
  toArray(): Array<[K, V]> {
    return this.store.toArray()
  }

  /** Alias of `entries`. Time O(n). */
  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.store.entries()
  }
}

/**
 * A capacity-bounded set with a defined recency order.
 *
 * `add` inserts a new value or refreshes an existing one and returns true only
 * when the set grew; `touch` refreshes without inserting; `has` and `delete`
 * never refresh. Eviction removes the least-recently used value, exactly down to
 * capacity. Time O(1) average per operation, O(k) for shrinking `resize`, O(n)
 * for iteration and `toArray`; space O(capacity). Iteration and `toArray` run
 * least-recently used first, so `toArray()[0]` is the next value to be evicted.
 */
export class OrderedLruSet<T> implements Iterable<T> {
  private readonly store = new OrderedMap<T, true>()
  private limit: number

  /**
   * @param capacity Maximum live values; clamped to 1..100000.
   * Time O(1), space O(1).
   */
  constructor(capacity = 64) {
    this.limit = normaliseCapacity(capacity)
  }

  /** Number of values. Time O(1). */
  get size(): number {
    return this.store.size
  }

  /** Configured maximum number of values. Time O(1). */
  get capacity(): number {
    return this.limit
  }

  /**
   * Insert or refresh a value, returning true only when it was new.
   * Time O(1) average, space O(1).
   */
  add(value: T): boolean {
    const existed = this.store.delete(value)
    this.store.set(value, true)
    if (!existed) this.evictOverflow()
    return !existed
  }

  /** Membership test that never refreshes. Time O(1) average. */
  has(value: T): boolean {
    return this.store.has(value)
  }

  /**
   * Refresh a value that is already present without inserting it.
   * Time O(1) average. Returns false when the value is absent.
   */
  touch(value: T): boolean {
    if (!this.store.has(value)) return false
    this.store.delete(value)
    this.store.set(value, true)
    return true
  }

  /** Remove a value. Time O(1) average. */
  delete(value: T): boolean {
    return this.store.delete(value)
  }

  /**
   * Change the capacity, evicting least-recently used values when it shrinks.
   * Time O(1) amortized to grow, O(k) to shrink past k values.
   */
  resize(capacity: number): void {
    this.limit = normaliseCapacity(capacity)
    this.evictOverflow()
  }

  /** Remove every value. Time O(n) for reclamation. */
  clear(): void {
    this.store.clear()
  }

  /**
   * Snapshot from least-recently used to most-recently used.
   * Time O(n), space O(n).
   */
  toArray(): T[] {
    return [...this.store.keys()]
  }

  /** Iterate from least-recently used to most-recently used. Time O(n). */
  [Symbol.iterator](): IterableIterator<T> {
    return this.store.keys()
  }

  /** Remove least-recently used values until the capacity is respected. */
  private evictOverflow(): void {
    while (this.store.size > this.limit) this.store.deleteFirst()
  }
}

/**
 * A capacity-bounded set with no iteration order promise.
 *
 * `add` and `touch` refresh recency, `has` never does, and eviction removes the
 * value whose recency is oldest. Time O(1) average per keyed operation, O(k) for
 * shrinking `resize`, O(n) for iteration and `toArray`; space O(capacity). The
 * implementation uses a native `Map` whose insertion order is refreshed on
 * `add`/`touch`; that order is an implementation detail, not a contract — callers
 * that need a defined order must use `OrderedLruSet`.
 */
export class UnorderedLruSet<T> implements Iterable<T> {
  private readonly store = new Map<T, true>()
  private limit: number

  /**
   * @param capacity Maximum live values; clamped to 1..100000.
   * Time O(1), space O(1).
   */
  constructor(capacity = 64) {
    this.limit = normaliseCapacity(capacity)
  }

  /** Number of values. Time O(1). */
  get size(): number {
    return this.store.size
  }

  /** Configured maximum number of values. Time O(1). */
  get capacity(): number {
    return this.limit
  }

  /**
   * Insert or refresh a value, returning true only when it was new.
   * Time O(1) average, space O(1).
   */
  add(value: T): boolean {
    const existed = this.store.delete(value)
    this.store.set(value, true)
    if (!existed) this.evictOverflow()
    return !existed
  }

  /** Membership test that never refreshes. Time O(1) average. */
  has(value: T): boolean {
    return this.store.has(value)
  }

  /**
   * Refresh a value that is already present without inserting it.
   * Time O(1) average. Returns false when the value is absent.
   */
  touch(value: T): boolean {
    if (!this.store.delete(value)) return false
    this.store.set(value, true)
    return true
  }

  /** Remove a value. Time O(1) average. */
  delete(value: T): boolean {
    return this.store.delete(value)
  }

  /**
   * Change the capacity, evicting the oldest-recency values when it shrinks.
   * Time O(1) amortized to grow, O(k) to shrink past k values.
   */
  resize(capacity: number): void {
    this.limit = normaliseCapacity(capacity)
    this.evictOverflow()
  }

  /** Remove every value. Time O(n) for reclamation. */
  clear(): void {
    this.store.clear()
  }

  /** Snapshot; no order promise. Time O(n), space O(n). */
  toArray(): T[] {
    return [...this.store.keys()]
  }

  /** Iterate; no order promise. Time O(n). */
  [Symbol.iterator](): IterableIterator<T> {
    return this.store.keys()
  }

  /** Remove oldest-recency values until the capacity is respected. */
  private evictOverflow(): void {
    while (this.store.size > this.limit) {
      const oldest = this.store.keys().next()
      if (oldest.done === true) return
      this.store.delete(oldest.value)
    }
  }
}

/**
 * A capacity-bounded list that allows duplicates, ordered from oldest to newest.
 *
 * `push` appends at the most-recent end and evicts from the oldest end, `shift`
 * removes and returns the oldest value, `get`/`peek` read by index without
 * changing recency, and `touch(index)` explicitly moves one occurrence to the
 * most-recent end. `push`/`shift` are O(1) amortized, `get`/`peek` are O(1),
 * `touch` is O(n) because it shifts the tail of the array, and iteration /
 * `toArray` are O(n) from oldest to newest. Space O(capacity) plus at most a
 * small amortized slack from the head cursor.
 *
 * Duplicates are ordinary independent entries; touching one occurrence does not
 * move its twin.
 */
export class OrderedLruList<T> implements Iterable<T> {
  private slots: Array<T | undefined> = []
  private start = 0
  private limit: number

  /**
   * @param capacity Maximum live values; clamped to 1..100000.
   * Time O(1), space O(1).
   */
  constructor(capacity = 64) {
    this.limit = normaliseCapacity(capacity)
  }

  /** Number of values, duplicates included. Time O(1). */
  get size(): number {
    return this.slots.length - this.start
  }

  /** Configured maximum number of values. Time O(1). */
  get capacity(): number {
    return this.limit
  }

  /**
   * Append a value at the most-recent end, evicting oldest values when over
   * capacity. Time O(1) amortized, space O(1).
   */
  push(value: T): this {
    this.slots.push(value)
    while (this.size > this.limit) this.shift()
    return this
  }

  /**
   * Read the value at `index`, where 0 is the oldest and `size - 1` is the most
   * recent. Does not change recency. Time O(1), space O(1). Throws
   * `InvalidArgumentError` for a non-integer or out-of-range index.
   */
  get(index: number): T | undefined {
    this.assertIndex(index)
    return this.slots[this.start + index] as T
  }

  /**
   * Alias of `get` with a name that states it will not promote. Time O(1).
   * Throws `InvalidArgumentError` for a non-integer or out-of-range index.
   */
  peek(index: number): T | undefined {
    return this.get(index)
  }

  /**
   * Move the occurrence at `index` to the most-recent end.
   * Time O(n) because the array tail shifts, space O(1). Throws
   * `InvalidArgumentError` for a non-integer or out-of-range index.
   */
  touch(index: number): void {
    this.assertIndex(index)
    if (index === this.size - 1) return
    const value = this.slots.splice(this.start + index, 1)[0] as T
    this.slots.push(value)
  }

  /**
   * Remove and return the oldest value, or `undefined` when empty.
   * Time O(1) amortized, space O(1).
   */
  shift(): T | undefined {
    if (this.size === 0) return undefined
    const value = this.slots[this.start]
    this.slots[this.start] = undefined
    this.start += 1
    this.compactIfNeeded()
    return value
  }

  /**
   * Change the capacity, evicting oldest values when it shrinks.
   * Time O(1) amortized to grow, O(k) to shrink past k values.
   */
  resize(capacity: number): void {
    this.limit = normaliseCapacity(capacity)
    while (this.size > this.limit) this.shift()
  }

  /** Remove every value. Time O(1) plus reclamation of the old array. */
  clear(): void {
    this.slots = []
    this.start = 0
  }

  /** Snapshot from oldest to newest. Time O(n), space O(n). */
  toArray(): T[] {
    return Array.from(this)
  }

  /** Iterate from oldest to newest. Time O(n). */
  *[Symbol.iterator](): IterableIterator<T> {
    for (let index = this.start; index < this.slots.length; index += 1) {
      yield this.slots[index] as T
    }
  }

  /** Throw unless `index` addresses a live slot. */
  private assertIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.size) {
      throw new InvalidArgumentError('list index must be an integer within [0, size)', {
        index,
        size: this.size,
      })
    }
  }

  /**
   * Drop the consumed array prefix once it dominates the array, keeping the
   * O(1) shift cost amortized. Time O(n) per compaction, amortized O(1).
   */
  private compactIfNeeded(): void {
    if (this.start < 1024 && this.start * 2 < this.slots.length) return
    if (this.start === 0) return
    this.slots = this.slots.slice(this.start)
    this.start = 0
  }
}

/**
 * A capacity-bounded list that allows duplicates, with no iteration order
 * promise.
 *
 * Entries are stored in a `Map<sequence, value>` keyed by a monotonically
 * increasing insertion serial. `push` inserts at the newest serial and evicts
 * the oldest surviving serial, so eviction is insertion-recency FIFO unless
 * `touch(value)` moves one matching occurrence to a fresh serial. `peek` returns
 * the next eviction candidate without removing it. `push` is O(1) amortized,
 * `peek` O(1), `touch` O(n) because duplicates make the value ambiguous, and
 * iteration / `toArray` are O(n) in the current serial order (an implementation
 * detail, not a contract). Space O(capacity).
 */
export class UnorderedLruList<T> implements Iterable<T> {
  private readonly store = new Map<number, T>()
  private nextSequence = 0
  private limit: number

  /**
   * @param capacity Maximum live values; clamped to 1..100000.
   * Time O(1), space O(1).
   */
  constructor(capacity = 64) {
    this.limit = normaliseCapacity(capacity)
  }

  /** Number of values, duplicates included. Time O(1). */
  get size(): number {
    return this.store.size
  }

  /** Configured maximum number of values. Time O(1). */
  get capacity(): number {
    return this.limit
  }

  /**
   * Append a value at the newest end, evicting the oldest values when over
   * capacity. Time O(1) amortized, space O(1).
   */
  push(value: T): this {
    this.store.set(this.nextSequence, value)
    this.nextSequence += 1
    this.evictOverflow()
    return this
  }

  /**
   * The next eviction candidate: the oldest surviving value, without removing
   * it. Time O(1) average, space O(1).
   */
  peek(): T | undefined {
    const oldest = this.store.values().next()
    return oldest.done === true ? undefined : oldest.value
  }

  /**
   * Move the oldest occurrence equal to `value` (SameValueZero) to the newest
   * serial, refreshing its eviction priority. Time O(n), space O(1).
   * Returns false when no equal occurrence exists.
   */
  touch(value: T): boolean {
    for (const [sequence, entry] of this.store) {
      if (!sameValueZero(entry, value)) continue
      this.store.delete(sequence)
      this.store.set(this.nextSequence, entry)
      this.nextSequence += 1
      return true
    }
    return false
  }

  /**
   * Change the capacity, evicting oldest values when it shrinks.
   * Time O(1) amortized to grow, O(k) to shrink past k values.
   */
  resize(capacity: number): void {
    this.limit = normaliseCapacity(capacity)
    this.evictOverflow()
  }

  /** Remove every value. Time O(n) for reclamation. */
  clear(): void {
    this.store.clear()
    this.nextSequence = 0
  }

  /** Snapshot in current serial order; no order promise. Time O(n), space O(n). */
  toArray(): T[] {
    return [...this.store.values()]
  }

  /** Iterate in current serial order; no order promise. Time O(n). */
  [Symbol.iterator](): IterableIterator<T> {
    return this.store.values()
  }

  /** Remove oldest values until the capacity is respected. */
  private evictOverflow(): void {
    while (this.store.size > this.limit) {
      const oldest = this.store.keys().next()
      if (oldest.done === true) return
      this.store.delete(oldest.value)
    }
  }
}

/** SameValueZero equality, matching native `Set`/`Map` membership. */
function sameValueZero(left: unknown, right: unknown): boolean {
  if (left === right) return true
  return typeof left === 'number' && typeof right === 'number' && Number.isNaN(left) && Number.isNaN(right)
}

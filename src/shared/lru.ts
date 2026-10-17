/**
 * Capacity-bounded caches: the single canonical key/value LRU, its weak-key
 * variant, LRU sets and recency-ordered lists.
 *
 * `LruList` is the only array-backed LRU implementation in the library. It
 * keeps a `Map` from key to array slot plus an array of entries; deleting or
 * promoting an entry only tombstones its slot, so every operation is O(1)
 * amortized, and the array is compacted when tombstones outnumber live entries.
 * `WeakLruList` composes `LruList<WeakRef<K>, V>` instead of duplicating that
 * storage. The set and list variants likewise compose lower-level primitives:
 * both LRU sets delegate eviction to `LruList`, `OrderedLruList` is a `Deque`
 * with a capacity, and `UnorderedLruList` is an `OrderedMap<sequence, value>`
 * plus a monotone sequence counter.
 *
 * Set and list variants share the same capacity contract: a capacity is an
 * integer clamped to 1..100000, every structure evicts down to exactly its
 * capacity, and `resize` evicts immediately when it shrinks. "LRU" here means
 * recency as defined by the structure: `get`/`touch`/`add` refresh recency for
 * the keyed caches and sets, while the ordered list treats `push` as insertion
 * recency and exposes `touch(index)` for an explicit promotion (plain reads
 * never reorder a list, so an index stays valid until a mutation).
 *
 * `normaliseCapacity` is imported from `./hash.js` only as a pure leaf helper;
 * this module imports no LRU class from another file.
 *
 * No Node, DOM, React or external dependency is used.
 */
import { InvalidArgumentError } from './error.js'
import { normaliseCapacity } from './hash.js'
import { OrderedMap } from './map.js'
import { Deque } from './stack.js'

interface LruEntry<K, V> {
  readonly key: K
  value: V
}

/**
 * General-purpose key/value LRU cache, the canonical implementation.
 *
 * `get` and `touch` promote the key to most-recently used, `peek` and `has` do
 * not, and `set` always promotes. Time O(1) amortized per operation, space
 * O(capacity). Iteration and `toArray` run most-recent first. Missing keys read
 * as `undefined`; use `has` when `undefined` is a legal value.
 *
 * The backing store is a `Map` from key to array slot plus an array of entries.
 * Deleting or promoting an entry tombstones its slot rather than shifting the
 * array, so every keyed operation stays O(1) amortized. The array is compacted
 * when tombstones exceed half of its slots; that compaction is O(n) but can run
 * only after at least n/2 operations created tombstones, so the amortized cost
 * remains constant. Space is O(capacity).
 *
 * Iteration is live: mutating during iteration is not supported and can skip or
 * repeat entries.
 */
export class LruList<K, V> implements Iterable<[K, V]> {
  private readonly slotByKey = new Map<K, number>()
  private slots: Array<LruEntry<K, V> | undefined> = []
  /** First slot that may still hold a live entry; everything before is a tombstone. */
  private oldest = 0
  private tombstones = 0
  private limit: number

  /**
   * @param capacity Maximum live entries; clamped to 1..100000.
   * Time O(1), space O(1).
   */
  constructor(capacity = 64) {
    this.limit = normaliseCapacity(capacity)
  }

  /** Number of live entries. Time O(1). */
  get size(): number {
    return this.slotByKey.size
  }

  /** Configured maximum number of live entries. Time O(1). */
  get capacity(): number {
    return this.limit
  }

  /**
   * Read a value and promote its key to most-recently used.
   * Time O(1) amortized, space O(1). Returns `undefined` for a missing key; use
   * `has` when `undefined` is a legal stored value.
   */
  get(key: K): V | undefined {
    const index = this.slotByKey.get(key)
    if (index === undefined) return undefined
    const entry = this.slots[index]
    if (entry === undefined) {
      this.slotByKey.delete(key)
      return undefined
    }
    this.promote(key, index)
    return entry.value
  }

  /**
   * Read a value without changing recency. Time O(1), space O(1).
   */
  peek(key: K): V | undefined {
    const index = this.slotByKey.get(key)
    if (index === undefined) return undefined
    const entry = this.slots[index]
    if (entry === undefined) {
      this.slotByKey.delete(key)
      return undefined
    }
    return entry.value
  }

  /**
   * Promote a key to most-recently used without reading its value.
   * Time O(1) amortized, space O(1). Returns false when the key is absent.
   */
  touch(key: K): boolean {
    const index = this.slotByKey.get(key)
    if (index === undefined) return false
    if (this.slots[index] === undefined) {
      this.slotByKey.delete(key)
      return false
    }
    this.promote(key, index)
    return true
  }

  /**
   * Insert or update a key, moving it to most-recently used and evicting the
   * least-recently used entry if the capacity is exceeded.
   * Time O(1) amortized (eviction and compaction included), space O(1).
   */
  set(key: K, value: V): this {
    const index = this.slotByKey.get(key)
    if (index !== undefined) {
      const entry = this.slots[index]
      if (entry !== undefined) {
        entry.value = value
        this.promote(key, index)
        return this
      }
      this.slotByKey.delete(key)
    }
    const entry: LruEntry<K, V> = { key, value }
    this.slots.push(entry)
    this.slotByKey.set(key, this.slots.length - 1)
    while (this.slotByKey.size > this.limit) this.evictOldest()
    this.compactIfNeeded()
    return this
  }

  /**
   * Remove a key. Time O(1) amortized, space O(1). Returns false when absent.
   */
  delete(key: K): boolean {
    const index = this.slotByKey.get(key)
    if (index === undefined) return false
    this.slotByKey.delete(key)
    if (this.slots[index] !== undefined) {
      this.slots[index] = undefined
      this.tombstones += 1
      if (index === this.oldest) this.advanceOldest()
      this.compactIfNeeded()
    }
    return true
  }

  /** Membership test that never changes recency. Time O(1), space O(1). */
  has(key: K): boolean {
    return this.slotByKey.has(key)
  }

  /**
   * Change the capacity, evicting least-recently used entries when it shrinks.
   * Time O(1) amortized when growing, O(k) when shrinking past k entries (each
   * evicted entry is O(1)), space O(1).
   */
  resize(capacity: number): void {
    this.limit = normaliseCapacity(capacity)
    while (this.slotByKey.size > this.limit) this.evictOldest()
    this.compactIfNeeded()
  }

  /** Remove every entry. Time O(1) for the maps, O(n) for the dropped array. */
  clear(): void {
    this.slotByKey.clear()
    this.slots = []
    this.oldest = 0
    this.tombstones = 0
  }

  /**
   * Keys from most-recently used to least-recently used.
   * Time O(n) for a full pass, space O(1) per step.
   */
  *keys(): IterableIterator<K> {
    for (const [key] of this.entries()) yield key
  }

  /**
   * Values from most-recently used to least-recently used.
   * Time O(n) for a full pass, space O(1) per step.
   */
  *values(): IterableIterator<V> {
    for (const [, value] of this.entries()) yield value
  }

  /**
   * `[key, value]` pairs from most-recently used to least-recently used.
   * Time O(n) for a full pass, space O(1) per step.
   */
  *entries(): IterableIterator<[K, V]> {
    for (let index = this.slots.length - 1; index >= this.oldest; index -= 1) {
      const entry = this.slots[index]
      if (entry !== undefined) yield [entry.key, entry.value]
    }
  }

  /**
   * Snapshot of the entries in most-recent-first order. Time O(n), space O(n).
   */
  toArray(): Array<[K, V]> {
    return [...this.entries()]
  }

  /** Alias of `entries`, so the cache is directly iterable. Time O(n). */
  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries()
  }

  /** Move a live key to the end of the slot array. Time O(1) amortized. */
  private promote(key: K, index: number): void {
    if (index === this.slots.length - 1) return
    const entry = this.slots[index]
    if (entry === undefined) return
    const moved: LruEntry<K, V> = { key: entry.key, value: entry.value }
    this.slots.push(moved)
    this.slotByKey.set(key, this.slots.length - 1)
    this.slots[index] = undefined
    this.tombstones += 1
    this.compactIfNeeded()
  }

  /** Advance the oldest cursor past leading tombstones. Time O(1) amortized. */
  private advanceOldest(): void {
    while (this.oldest < this.slots.length && this.slots[this.oldest] === undefined) {
      this.oldest += 1
    }
  }

  /** Evict the least-recently used live entry. Time O(1) amortized. */
  private evictOldest(): void {
    this.advanceOldest()
    if (this.oldest >= this.slots.length) return
    const entry = this.slots[this.oldest]
    if (entry === undefined) return
    this.slots[this.oldest] = undefined
    this.tombstones += 1
    this.oldest += 1
    this.slotByKey.delete(entry.key)
  }

  /**
   * Rebuild the slot array when tombstones exceed half of it.
   * Time O(n) in the live entries plus tombstones; amortized O(1) per mutation
   * because a compaction is only reachable after at least n/2 tombstones.
   */
  private compactIfNeeded(): void {
    if (this.tombstones === 0) return
    if (this.tombstones * 2 <= this.slots.length) return
    const live: Array<LruEntry<K, V>> = []
    for (let index = this.oldest; index < this.slots.length; index += 1) {
      const entry = this.slots[index]
      if (entry !== undefined) live.push(entry)
    }
    this.slots = live
    for (let index = 0; index < live.length; index += 1) {
      this.slotByKey.set(live[index].key, index)
    }
    this.oldest = 0
    this.tombstones = 0
  }
}

/**
 * Weak-key variant of `LruList`.
 *
 * Composes `LruList<WeakRef<K>, V>` and keeps a `WeakMap` from each key to its
 * reference; keys are held weakly, values strongly. `get`/`touch` promote,
 * `peek`/`has` do not, iteration skips collected keys. Time O(1) amortized per
 * keyed operation; `size` is O(n) because it sweeps collected references, and
 * `clear` is O(1) plus reclamation. A `FinalizationRegistry` (when the runtime
 * provides one) drops entries as keys are collected, but garbage-collection
 * timing is not deterministic, so a collected entry may occupy capacity until
 * the next sweep or finalizer callback. Space O(capacity).
 *
 * Caveat: the finalizer callback closes over this instance, so the runtime
 * keeps the cache alive until every registered key has been collected.
 */
export class WeakLruList<K extends object, V> implements Iterable<[K, V]> {
  private readonly store: LruList<WeakRef<K>, V>
  private references = new WeakMap<K, WeakRef<K>>()
  private readonly registry: FinalizationRegistry<WeakRef<K>> | undefined

  /**
   * @param capacity Maximum live entries; clamped to 1..100000.
   * Time O(1), space O(1).
   */
  constructor(capacity = 64) {
    this.store = new LruList<WeakRef<K>, V>(capacity)
    if (typeof FinalizationRegistry !== 'undefined') {
      this.registry = new FinalizationRegistry<WeakRef<K>>((reference) => {
        this.store.delete(reference)
      })
    } else {
      this.registry = undefined
    }
  }

  /**
   * Number of entries that are still reachable. Sweeps dead entries first, so
   * time O(n) worst case and space O(1); an empty or fully live cache is O(n)
   * only because the sweep cannot know that without dereferencing.
   */
  get size(): number {
    this.sweep()
    return this.store.size
  }

  /** Configured maximum number of live entries. Time O(1). */
  get capacity(): number {
    return this.store.capacity
  }

  /**
   * Read a live value and promote it to most-recently used.
   * Time O(1) amortized, space O(1). Returns `undefined` when the key was
   * collected or is absent; use `has` when `undefined` is a legal value.
   */
  get(key: K): V | undefined {
    const reference = this.references.get(key)
    if (reference === undefined) return undefined
    const value = this.store.get(reference)
    if (value === undefined && !this.store.has(reference)) {
      this.references.delete(key)
      return undefined
    }
    return value
  }

  /** Read a live value without changing recency. Time O(1), space O(1). */
  peek(key: K): V | undefined {
    const reference = this.references.get(key)
    if (reference === undefined) return undefined
    const value = this.store.peek(reference)
    if (value === undefined && !this.store.has(reference)) {
      this.references.delete(key)
      return undefined
    }
    return value
  }

  /**
   * Promote a live key to most-recently used. Time O(1) amortized. Returns false
   * when the key is absent or already collected.
   */
  touch(key: K): boolean {
    const reference = this.references.get(key)
    if (reference === undefined) return false
    return this.store.touch(reference)
  }

  /**
   * Insert or update a key, promote it, and evict the least-recently used entry
   * when the capacity is exceeded. Time O(1) amortized, space O(1). The key is
   * registered with the finalization registry only once per live entry.
   */
  set(key: K, value: V): this {
    let reference = this.references.get(key)
    if (reference === undefined || !this.store.has(reference)) {
      reference = new WeakRef(key)
      this.references.set(key, reference)
      this.registry?.register(key, reference, reference)
    }
    this.store.set(reference, value)
    return this
  }

  /**
   * Remove a key. Time O(1) amortized, space O(1). Returns false when absent.
   */
  delete(key: K): boolean {
    const reference = this.references.get(key)
    if (reference === undefined) return false
    this.references.delete(key)
    this.registry?.unregister(reference)
    return this.store.delete(reference)
  }

  /** Membership test that never changes recency. Time O(1), space O(1). */
  has(key: K): boolean {
    const reference = this.references.get(key)
    if (reference === undefined) return false
    return this.store.has(reference)
  }

  /**
   * Change the capacity, evicting least-recently used entries when it shrinks.
   * Time O(1) amortized to grow, O(k) to shrink past k entries.
   */
  resize(capacity: number): void {
    this.store.resize(capacity)
  }

  /**
   * Remove every entry and forget every key reference. Time O(1) plus the work
   * the runtime spends dropping the old WeakMap and array.
   */
  clear(): void {
    this.store.clear()
    this.references = new WeakMap<K, WeakRef<K>>()
  }

  /** Live keys from most-recently used to least-recently used. Time O(n). */
  *keys(): IterableIterator<K> {
    for (const [key] of this.entries()) yield key
  }

  /** Live values from most-recently used to least-recently used. Time O(n). */
  *values(): IterableIterator<V> {
    for (const [, value] of this.entries()) yield value
  }

  /**
   * Live `[key, value]` pairs from most-recently used to least-recently used.
   * Time O(n), space O(1) per step; collected references are skipped.
   */
  *entries(): IterableIterator<[K, V]> {
    for (const [reference, value] of this.store.entries()) {
      const key = reference.deref()
      if (key !== undefined) yield [key, value]
    }
  }

  /** Snapshot of live entries, most-recent first. Time O(n), space O(n). */
  toArray(): Array<[K, V]> {
    return [...this.entries()]
  }

  /** Alias of `entries`. Time O(n). */
  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries()
  }

  /**
   * Drop entries whose weak reference no longer dereferences.
   * Time O(n) in the backing entry count, space O(number of dead entries).
   */
  private sweep(): void {
    const collected: Array<WeakRef<K>> = []
    for (const [reference] of this.store.entries()) {
      if (reference.deref() === undefined) collected.push(reference)
    }
    for (const reference of collected) this.store.delete(reference)
  }
}

/**
 * A capacity-bounded set with a defined recency order.
 *
 * Composes `LruList<T, true>`: `add` inserts a new value or refreshes an
 * existing one and returns true only when the set grew; `touch` refreshes
 * without inserting; `has` and `delete` never refresh. Eviction removes the
 * least-recently used value, exactly down to capacity. Time O(1) average per
 * operation, O(k) for shrinking `resize`, O(n) for iteration and `toArray`;
 * space O(capacity). Iteration and `toArray` run least-recently used first, so
 * `toArray()[0]` is the next value to be evicted.
 */
export class OrderedLruSet<T> implements Iterable<T> {
  private readonly store: LruList<T, true>

  /**
   * @param capacity Maximum live values; clamped to 1..100000.
   * Time O(1), space O(1).
   */
  constructor(capacity = 64) {
    this.store = new LruList<T, true>(capacity)
  }

  /** Number of values. Time O(1). */
  get size(): number {
    return this.store.size
  }

  /** Configured maximum number of values. Time O(1). */
  get capacity(): number {
    return this.store.capacity
  }

  /**
   * Insert or refresh a value, returning true only when it was new.
   * Time O(1) average, space O(1).
   */
  add(value: T): boolean {
    const existed = this.store.has(value)
    this.store.set(value, true)
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
    return this.store.touch(value)
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
    this.store.resize(capacity)
  }

  /** Remove every value. Time O(n) for reclamation. */
  clear(): void {
    this.store.clear()
  }

  /**
   * Snapshot from least-recently used to most-recently used.
   * Time O(n), space O(n) for the snapshot.
   */
  toArray(): T[] {
    return [...this]
  }

  /**
   * Iterate from least-recently used to most-recently used.
   * Time O(n), space O(n) because the underlying LRU iterates most-recent
   * first and the snapshot is walked backwards (the order promise is exact).
   */
  *[Symbol.iterator](): IterableIterator<T> {
    const keys = [...this.store.keys()]
    for (let index = keys.length - 1; index >= 0; index -= 1) yield keys[index]
  }
}

/**
 * A capacity-bounded set with no iteration order promise.
 *
 * Composes `LruList<T, true>`: `add` and `touch` refresh recency, `has` never
 * does, and eviction removes the value whose recency is oldest. Time O(1)
 * average per keyed operation, O(k) for shrinking `resize`, O(n) for iteration
 * and `toArray`; space O(capacity). The concrete iteration order is
 * least-recently used to most-recently used (the same order the previous
 * native-Map implementation exposed), but that is an implementation detail, not
 * a contract: callers that need a defined order must use `OrderedLruSet`.
 */
export class UnorderedLruSet<T> implements Iterable<T> {
  private readonly store: LruList<T, true>

  /**
   * @param capacity Maximum live values; clamped to 1..100000.
   * Time O(1), space O(1).
   */
  constructor(capacity = 64) {
    this.store = new LruList<T, true>(capacity)
  }

  /** Number of values. Time O(1). */
  get size(): number {
    return this.store.size
  }

  /** Configured maximum number of values. Time O(1). */
  get capacity(): number {
    return this.store.capacity
  }

  /**
   * Insert or refresh a value, returning true only when it was new.
   * Time O(1) average, space O(1).
   */
  add(value: T): boolean {
    const existed = this.store.has(value)
    this.store.set(value, true)
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
    return this.store.touch(value)
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
    this.store.resize(capacity)
  }

  /** Remove every value. Time O(n) for reclamation. */
  clear(): void {
    this.store.clear()
  }

  /** Snapshot; no order promise. Time O(n), space O(n) for the snapshot. */
  toArray(): T[] {
    return [...this]
  }

  /**
   * Iterate; no order promise. The concrete order happens to be
   * least-recently used first, matching the former native-Map implementation,
   * but callers must not depend on it. Time O(n), space O(n) for the snapshot.
   */
  *[Symbol.iterator](): IterableIterator<T> {
    const keys = [...this.store.keys()]
    for (let index = keys.length - 1; index >= 0; index -= 1) yield keys[index]
  }
}

/**
 * A capacity-bounded list that allows duplicates, ordered from oldest to newest.
 *
 * Composes `Deque<T>` (the shared ring-buffer primitive) for storage, so this
 * class no longer keeps a parallel array/head cursor. `push` appends at the
 * most-recent end and evicts from the oldest end, `shift` removes and returns
 * the oldest value, `get`/`peek` read by index without changing recency, and
 * `touch(index)` explicitly moves one occurrence to the most-recent end.
 * `push`/`shift` are O(1) amortized, `get`/`peek` are O(1), `touch` is O(n)
 * because it rebuilds the deque without the moved occurrence (O(n) temporary
 * space), and iteration / `toArray` are O(n) from oldest to newest. Space
 * O(capacity).
 *
 * Duplicates are ordinary independent entries; touching one occurrence does not
 * move its twin.
 */
export class OrderedLruList<T> implements Iterable<T> {
  private readonly store = new Deque<T>()
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
   * Append a value at the most-recent end, evicting oldest values when over
   * capacity. Time O(1) amortized, space O(1).
   */
  push(value: T): this {
    this.store.push(value)
    while (this.store.size > this.limit) this.store.shift()
    return this
  }

  /**
   * Read the value at `index`, where 0 is the oldest and `size - 1` is the most
   * recent. Does not change recency. Time O(1), space O(1). Throws
   * `InvalidArgumentError` for a non-integer or out-of-range index.
   */
  get(index: number): T | undefined {
    this.assertIndex(index)
    return this.store.at(index)
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
   * Time O(n) and O(n) temporary space because the deque is rebuilt without the
   * moved occurrence. Throws `InvalidArgumentError` for a non-integer or
   * out-of-range index.
   */
  touch(index: number): void {
    this.assertIndex(index)
    if (index === this.size - 1) return
    const values = this.store.toArray()
    const value = values[index]
    this.store.clear()
    for (let cursor = 0; cursor < values.length; cursor += 1) {
      if (cursor !== index) this.store.push(values[cursor])
    }
    this.store.push(value)
  }

  /**
   * Remove and return the oldest value, or `undefined` when empty.
   * Time O(1) amortized, space O(1).
   */
  shift(): T | undefined {
    return this.store.shift()
  }

  /**
   * Change the capacity, evicting oldest values when it shrinks.
   * Time O(1) amortized to grow, O(k) to shrink past k values.
   */
  resize(capacity: number): void {
    this.limit = normaliseCapacity(capacity)
    while (this.store.size > this.limit) this.store.shift()
  }

  /** Remove every value. Time O(1) plus reclamation of the old buffer. */
  clear(): void {
    this.store.clear()
  }

  /** Snapshot from oldest to newest. Time O(n), space O(n). */
  toArray(): T[] {
    return this.store.toArray()
  }

  /** Iterate from oldest to newest. Time O(n), space O(1) per step. */
  [Symbol.iterator](): IterableIterator<T> {
    return this.store[Symbol.iterator]()
  }

  /** Throw unless `index` addresses a live slot. */
  private assertIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.store.size) {
      throw new InvalidArgumentError('list index must be an integer within [0, size)', {
        index,
        size: this.store.size,
      })
    }
  }
}

/**
 * A capacity-bounded list that allows duplicates, with no iteration order
 * promise.
 *
 * Composes `OrderedMap<number, T>` keyed by a monotonically increasing insertion
 * serial, plus the serial counter. `push` inserts at the newest serial and
 * `deleteFirst` evicts the oldest surviving serial, so eviction is
 * insertion-recency FIFO unless `touch(value)` moves one matching occurrence to
 * a fresh serial. `peek` returns the next eviction candidate without removing
 * it. `push` is O(1) amortized, `peek` O(1), `touch` O(n) because duplicates
 * make the value ambiguous, and iteration / `toArray` are O(n) in the current
 * serial order (an implementation detail, not a contract). Space O(capacity).
 */
export class UnorderedLruList<T> implements Iterable<T> {
  private readonly store = new OrderedMap<number, T>()
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
   * it. Time O(1), space O(1).
   */
  peek(): T | undefined {
    return this.store.first()
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
    while (this.store.size > this.limit) this.store.deleteFirst()
  }
}

/** SameValueZero equality, matching native `Set`/`Map` membership. */
function sameValueZero(left: unknown, right: unknown): boolean {
  if (left === right) return true
  return typeof left === 'number' && typeof right === 'number' && Number.isNaN(left) && Number.isNaN(right)
}

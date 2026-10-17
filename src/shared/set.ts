/**
 * Set-shaped collections with four different ordering guarantees.
 *
 * `OrderedSet` preserves insertion order, `UnorderedSet` delegates to the
 * native `Set`, `OrderedSkipSet` is sorted by a comparator, and
 * `UnorderedSkipSet` iterates in hash order. All four expose `size`, `clear`,
 * `add`, `delete`, `has`, `toArray` and are iterable; `add` returns true only
 * when the value was not already present, matching `Set` semantics rather than
 * native `Set.add`'s chaining return value.
 *
 * The skip-set implementations reuse the skip lists in `./list.js` (and thus
 * inherit the 24-level cap and the non-finite-comparator rejection). No Node,
 * DOM or React APIs are used.
 */
import { OrderedMap } from './map.js'
import { OrderedSkipList, UnorderedSkipList } from './list.js'
import { defaultComparator } from './tree.js'
import type { Comparator } from './tree.js'

/**
 * An insertion-ordered set.
 *
 * Every operation is O(1) average time and O(1) space per entry; iteration and
 * `toArray` are O(n) in insertion order. Space O(n). `add` of an existing value
 * leaves the order unchanged and returns false.
 */
export class OrderedSet<T> implements Iterable<T> {
  private readonly store: OrderedMap<T, true>

  /**
   * @param values Optional initial values, inserted in iteration order.
   * Time O(n), space O(n).
   */
  constructor(values?: Iterable<T>) {
    this.store = new OrderedMap<T, true>()
    if (values !== undefined) {
      for (const value of values) this.store.set(value, true)
    }
  }

  /** Number of values. Time O(1). */
  get size(): number {
    return this.store.size
  }

  /**
   * Insert a value if absent. Time O(1) average, space O(1).
   * Returns true only when the set grew.
   */
  add(value: T): boolean {
    if (this.store.has(value)) return false
    this.store.set(value, true)
    return true
  }

  /** Remove a value. Time O(1) average, space O(1). */
  delete(value: T): boolean {
    return this.store.delete(value)
  }

  /** Membership test. Time O(1) average, space O(1). */
  has(value: T): boolean {
    return this.store.has(value)
  }

  /** First inserted surviving value, or `undefined`. Time O(1). */
  first(): T | undefined {
    return this.store.firstKey()
  }

  /** Last inserted surviving value, or `undefined`. Time O(1). */
  last(): T | undefined {
    return this.store.lastKey()
  }

  /** Remove every value. Time O(n) for reclamation. */
  clear(): void {
    this.store.clear()
  }

  /** Values in insertion order. Time O(n), space O(n) for the snapshot. */
  toArray(): T[] {
    return [...this.store.keys()]
  }

  /** Iterate in insertion order. Time O(n). */
  [Symbol.iterator](): IterableIterator<T> {
    return this.store.keys()
  }
}

/**
 * A thin wrapper around the native `Set`.
 *
 * O(1) average time per operation (O(n) worst case under adversarial hashing),
 * O(1) space per entry, O(n) iteration. No order promise: iteration follows the
 * engine's native order and may change between engines or versions.
 */
export class UnorderedSet<T> implements Iterable<T> {
  private readonly store: Set<T>

  /**
   * @param values Optional initial values.
   * Time O(n), space O(n).
   */
  constructor(values?: Iterable<T>) {
    this.store = new Set<T>(values)
  }

  /** Number of values. Time O(1). */
  get size(): number {
    return this.store.size
  }

  /**
   * Insert a value if absent. Time O(1) average, space O(1).
   * Returns true only when the set grew.
   */
  add(value: T): boolean {
    if (this.store.has(value)) return false
    this.store.add(value)
    return true
  }

  /** Remove a value. Time O(1) average, space O(1). */
  delete(value: T): boolean {
    return this.store.delete(value)
  }

  /** Membership test. Time O(1) average, space O(1). */
  has(value: T): boolean {
    return this.store.has(value)
  }

  /** Remove every value. Time O(n) for reclamation. */
  clear(): void {
    this.store.clear()
  }

  /** Snapshot in the engine's native order; no order promise. Time O(n). */
  toArray(): T[] {
    return [...this.store]
  }

  /** Iterate in the engine's native order. Time O(n). */
  [Symbol.iterator](): IterableIterator<T> {
    return this.store.values()
  }
}

/**
 * A sorted set implemented on top of `OrderedSkipList`.
 *
 * `add`, `delete` and `has` are expected O(log n) time (O(n) worst case only for
 * a degenerate tower shape) and O(1) space per operation; `range` is
 * O(log n + k); `toArray` is O(n). Space O(n). Duplicate values are rejected and
 * iteration is ascending.
 */
export class OrderedSkipSet<T> implements Iterable<T> {
  private readonly store: OrderedSkipList<T>

  /**
   * @param comparator Total order over `T`; defaults to the natural order.
   * @param seed Optional seed for the deterministic level generator.
   * Time O(1), space O(1).
   */
  constructor(comparator: Comparator<T> = defaultComparator, seed?: number) {
    this.store = new OrderedSkipList<T>(comparator, seed)
  }

  /** Number of values. Time O(1). */
  get size(): number {
    return this.store.size
  }

  /**
   * Insert a value if absent. Expected O(log n) time, O(1) space.
   * Returns true only when the set grew.
   */
  add(value: T): boolean {
    if (this.store.has(value)) return false
    this.store.insert(value)
    return true
  }

  /** Remove a value. Expected O(log n) time, O(1) space. */
  delete(value: T): boolean {
    return this.store.delete(value)
  }

  /** Membership test. Expected O(log n) time, O(1) space. */
  has(value: T): boolean {
    return this.store.has(value)
  }

  /** Smallest value, or `undefined`. Time O(1). */
  first(): T | undefined {
    return this.store.first()
  }

  /** Largest value, or `undefined`. Time O(n) because links are forward-only. */
  last(): T | undefined {
    return this.store.last()
  }

  /**
   * Values with `low <= value <= high`, ascending.
   * Expected O(log n + k) time and O(1) space for k yielded values.
   */
  range(low?: T, high?: T): IterableIterator<T> {
    return this.store.range(low, high)
  }

  /** Remove every value. Time O(maximum level), space O(1). */
  clear(): void {
    this.store.clear()
  }

  /** Snapshot in ascending order. Time O(n), space O(n). */
  toArray(): T[] {
    return this.store.toArray()
  }

  /** Iterate in ascending order. Time O(n). */
  [Symbol.iterator](): IterableIterator<T> {
    return this.store.entries()
  }
}

/**
 * A hash-ordered set implemented on top of `UnorderedSkipList`.
 *
 * `has` is O(1) average via the hash bucket (O(n) worst case when every value
 * collides); `add`/`delete` are expected O(log n + cost of hashing the value).
 * Space O(n). Duplicate values are rejected, but iteration follows hash-bucket
 * order, which is deterministic and deliberately not numeric or lexical order.
 */
export class UnorderedSkipSet<T> implements Iterable<T> {
  private readonly store: UnorderedSkipList<T>

  /**
   * @param seed Optional seed for the deterministic level generator.
   * Time O(1), space O(1).
   */
  constructor(seed?: number) {
    this.store = new UnorderedSkipList<T>(seed)
  }

  /** Number of values. Time O(1). */
  get size(): number {
    return this.store.size
  }

  /**
   * Insert a value if absent. Expected O(log n + cost of hashing the value),
   * space O(1). Returns true only when the set grew.
   */
  add(value: T): boolean {
    if (this.store.has(value)) return false
    this.store.insert(value)
    return true
  }

  /** Remove a value. Expected O(log n + cost of hashing the value). */
  delete(value: T): boolean {
    return this.store.delete(value)
  }

  /** Membership test. Average O(1 + bucket length), space O(1). */
  has(value: T): boolean {
    return this.store.has(value)
  }

  /** Remove every value. Time O(n) for reclamation. */
  clear(): void {
    this.store.clear()
  }

  /** Snapshot in hash-bucket order; no semantic order promise. Time O(n). */
  toArray(): T[] {
    return this.store.toArray()
  }

  /** Iterate in hash-bucket order; no semantic order promise. Time O(n). */
  [Symbol.iterator](): IterableIterator<T> {
    return this.store.entries()
  }
}

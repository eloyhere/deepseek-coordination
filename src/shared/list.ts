/**
 * Skip lists for sorted and hash-ordered sequences.
 *
 * `OrderedSkipList` is a sorted sequence that allows duplicates and offers
 * expected O(log n) search/insert/delete. `UnorderedSkipList` reuses the same
 * skip-list storage, ordered by `stableHash(value)` plus an insertion serial,
 * so iteration has a deterministic hash order but no semantic ordering; a hash
 * bucket map gives O(1) average membership.
 *
 * Levels are chosen by a seeded xorshift32 generator: the same operation
 * sequence on a fresh instance always produces the same level sequence, which
 * keeps tests reproducible without sharing mutable global state. The tower
 * height is capped at 24 in both classes, and a comparator that returns a
 * non-finite number is rejected with `InvalidArgumentError`.
 *
 * No Node, DOM, React or external dependency is used.
 */
import { InvalidArgumentError } from './error.js'
import { stableHash } from './hash.js'
import { SkipNode } from './node.js'
import { compareValues, defaultComparator } from './tree.js'
import type { Comparator } from './tree.js'

/** Hard cap on skip-list tower height. */
const MaximumSkipLevel = 24

/** Seed used when the caller does not care about the level sequence. */
const DefaultRandomSeed = 0x9e3779b9

/** Normalise a user seed to a non-zero unsigned 32-bit integer. */
function normaliseSeed(seed: number): number {
  if (!Number.isInteger(seed)) {
    throw new InvalidArgumentError('skip list seed must be an integer', { seed })
  }
  const normalised = seed >>> 0
  return normalised === 0 ? DefaultRandomSeed : normalised
}

/**
 * A sorted skip list that allows duplicate values.
 *
 * Expected time O(log n) for `insert`, `delete`, `has`, `range` start and
 * iteration start, with O(n) worst case if the random tower shape degenerates
 * (probability effectively zero). Space is O(n); each node holds at most 24
 * forward links. `first` is O(1); `last` is O(n) because links are singly
 * forward. `toArray` and a full iteration are O(n).
 *
 * Duplicates are kept adjacent. `insert` always adds one occurrence and `delete`
 * removes exactly one equal occurrence, so the structure behaves like a sorted
 * multiset. Iteration and `range` are ascending. Mutating during iteration is
 * not supported.
 */
export class OrderedSkipList<T> implements Iterable<T> {
  private readonly comparator: Comparator<T>
  private readonly heads: Array<SkipNode<T, T> | undefined>
  private readonly initialSeed: number
  private seed: number
  private levels = 0
  private count = 0

  /**
   * @param comparator Total order over `T`; defaults to the natural order.
   * @param seed Seed for the deterministic xorshift level generator.
   * Time O(1), space O(maximum level).
   */
  constructor(comparator: Comparator<T> = defaultComparator, seed = DefaultRandomSeed) {
    this.comparator = comparator
    this.initialSeed = normaliseSeed(seed)
    this.seed = this.initialSeed
    this.heads = new Array<SkipNode<T, T> | undefined>(MaximumSkipLevel).fill(undefined)
  }

  /** Number of stored occurrences. Time O(1). */
  get size(): number {
    return this.count
  }

  /**
   * Insert one occurrence of `value`, keeping duplicates adjacent.
   * Expected O(log n) time, O(1) space in expectation (the update array is at
   * most 24 entries, which is O(1) for the fixed cap).
   */
  insert(value: T): void {
    const level = this.nextLevel()
    const node = new SkipNode<T, T>(value, value, level)
    const update = new Array<SkipNode<T, T> | undefined>(level).fill(undefined)
    let previous: SkipNode<T, T> | undefined = undefined
    for (let depth = this.levels - 1; depth >= 0; depth -= 1) {
      let candidate: SkipNode<T, T> | undefined = previous === undefined ? this.heads[depth] : previous.next[depth]
      while (candidate !== undefined && this.compare(candidate.key, value) < 0) {
        previous = candidate
        candidate = candidate.next[depth]
      }
      if (depth < level) update[depth] = previous
    }
    for (let depth = 0; depth < level; depth += 1) {
      const last = update[depth]
      node.next[depth] = last === undefined ? this.heads[depth] : last.next[depth]
      if (last === undefined) this.heads[depth] = node
      else last.next[depth] = node
    }
    if (level > this.levels) this.levels = level
    this.count += 1
  }

  /**
   * Remove one occurrence equal to `value`, if present.
   * Expected O(log n) time, O(1) space. Returns false when absent.
   */
  delete(value: T): boolean {
    if (this.levels === 0) return false
    const update = new Array<SkipNode<T, T> | undefined>(this.levels).fill(undefined)
    let previous: SkipNode<T, T> | undefined = undefined
    for (let depth = this.levels - 1; depth >= 0; depth -= 1) {
      let candidate: SkipNode<T, T> | undefined = previous === undefined ? this.heads[depth] : previous.next[depth]
      while (candidate !== undefined && this.compare(candidate.key, value) < 0) {
        previous = candidate
        candidate = candidate.next[depth]
      }
      update[depth] = previous
    }
    const target = previous === undefined ? this.heads[0] : previous.next[0]
    if (target === undefined || this.compare(target.key, value) !== 0) return false
    for (let depth = 0; depth < target.next.length; depth += 1) {
      const last = update[depth]
      if (last === undefined) {
        if (this.heads[depth] === target) this.heads[depth] = target.next[depth]
      } else if (last.next[depth] === target) {
        last.next[depth] = target.next[depth]
      }
    }
    this.count -= 1
    while (this.levels > 0 && this.heads[this.levels - 1] === undefined) this.levels -= 1
    return true
  }

  /** Membership test. Expected O(log n) time, O(1) space. */
  has(value: T): boolean {
    const node = this.findLowerBound(value)
    return node !== undefined && this.compare(node.key, value) === 0
  }

  /** Smallest value, or `undefined` when empty. Time O(1), space O(1). */
  first(): T | undefined {
    return this.heads[0]?.key
  }

  /** Largest value, or `undefined` when empty. Time O(n), space O(1). */
  last(): T | undefined {
    let node = this.heads[0]
    if (node === undefined) return undefined
    while (node.next[0] !== undefined) node = node.next[0]
    return node.key
  }

  /**
   * Values with `low <= value <= high`, ascending, in O(log n + k) time for k
   * yielded values and O(1) space. An omitted bound is unbounded; a lower bound
   * greater than the upper bound yields nothing.
   */
  *range(low?: T, high?: T): IterableIterator<T> {
    if (low !== undefined && high !== undefined && this.compare(low, high) > 0) return
    let node = low === undefined ? this.heads[0] : this.findLowerBound(low)
    while (node !== undefined) {
      if (high !== undefined && this.compare(node.key, high) > 0) return
      yield node.key
      node = node.next[0]
    }
  }

  /** Snapshot in ascending order. Time O(n), space O(n). */
  toArray(): T[] {
    return [...this.entries()]
  }

  /** Ascending iteration. Time O(n), space O(1) per step. */
  *entries(): IterableIterator<T> {
    let node = this.heads[0]
    while (node !== undefined) {
      yield node.key
      node = node.next[0]
    }
  }

  /** Alias of `entries`. Time O(n). */
  [Symbol.iterator](): IterableIterator<T> {
    return this.entries()
  }

  /**
   * Remove every value and restart the deterministic level sequence from the
   * constructor seed. Time O(maximum level), space O(1).
   */
  clear(): void {
    this.heads.fill(undefined)
    this.levels = 0
    this.count = 0
    this.seed = this.initialSeed
  }

  /** Compare two values through the configurable comparator. */
  private compare(left: T, right: T): number {
    return compareValues(this.comparator, left, right)
  }

  /** First node whose key is >= `value`, or `undefined`; expected O(log n). */
  private findLowerBound(value: T): SkipNode<T, T> | undefined {
    if (this.levels === 0) return undefined
    let previous: SkipNode<T, T> | undefined = undefined
    for (let depth = this.levels - 1; depth >= 0; depth -= 1) {
      let candidate: SkipNode<T, T> | undefined = previous === undefined ? this.heads[depth] : previous.next[depth]
      while (candidate !== undefined && this.compare(candidate.key, value) < 0) {
        previous = candidate
        candidate = candidate.next[depth]
      }
    }
    return previous === undefined ? this.heads[0] : previous.next[0]
  }

  /** Draw a tower height from the seeded xorshift stream. */
  private nextLevel(): number {
    let level = 1
    while (level < MaximumSkipLevel && (this.nextRandom() & 1) === 1) level += 1
    return level
  }

  /** Xorshift32 step; deterministic, non-zero state, O(1). */
  private nextRandom(): number {
    let state = this.seed
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    this.seed = state
    return state
  }
}

interface HashEntry<T> {
  readonly hash: number
  readonly serial: number
  readonly value: T
}

/** Compare hash entries by hash, then insertion serial. */
function compareHashEntries<T>(left: HashEntry<T>, right: HashEntry<T>): number {
  return left.hash - right.hash || left.serial - right.serial
}

/** SameValueZero equality, matching native `Set`/`Map` membership. */
function sameValueZero(left: unknown, right: unknown): boolean {
  if (left === right) return true
  return typeof left === 'number' && typeof right === 'number' && Number.isNaN(left) && Number.isNaN(right)
}

/**
 * A skip list ordered by `stableHash(value)`, with no semantic ordering promise.
 *
 * The storage is the same sorted skip list used by `OrderedSkipList`, but the
 * sort key is `(stableHash(value), insertionSerial)`. A `Map<hash, entries[]>`
 * bucket index makes `has` O(1 + bucket length) average, O(n) worst case when
 * every value collides on one hash. `insert` and `delete` are expected
 * O(log n + cost(stableHash(value))) because the value must be hashed and, for
 * `delete`, located inside its bucket. Space O(n). Iteration is in hash order,
 * which is deterministic for a given value set but is not numeric or lexical
 * order; duplicates are allowed and adjacent duplicates keep insertion order.
 *
 * The tower height cap is inherited from `OrderedSkipList` (24). There is no
 * user comparator, and the internal comparator only subtracts two 32-bit
 * integers and two serials, so its results are always finite.
 */
export class UnorderedSkipList<T> implements Iterable<T> {
  private readonly store: OrderedSkipList<HashEntry<T>>
  private readonly buckets = new Map<number, Array<HashEntry<T>>>()
  private serial = 0

  /**
   * @param seed Optional seed for the deterministic xorshift level generator.
   * Time O(1), space O(maximum level).
   */
  constructor(seed = DefaultRandomSeed) {
    this.store = new OrderedSkipList<HashEntry<T>>(compareHashEntries, seed)
  }

  /** Number of stored occurrences. Time O(1). */
  get size(): number {
    return this.store.size
  }

  /**
   * Insert one occurrence of `value`. Expected O(log n + size of
   * `stableHash(value)`), space O(1). Duplicates are allowed.
   */
  insert(value: T): void {
    const hash = stableHash(value)
    const entry: HashEntry<T> = { hash, serial: this.serial, value }
    this.serial += 1
    this.store.insert(entry)
    const bucket = this.buckets.get(hash)
    if (bucket === undefined) this.buckets.set(hash, [entry])
    else bucket.push(entry)
  }

  /**
   * Remove one occurrence equal to `value` (SameValueZero). Expected O(1 +
   * bucket length + log n), space O(1). Returns false when absent.
   */
  delete(value: T): boolean {
    const hash = stableHash(value)
    const bucket = this.buckets.get(hash)
    if (bucket === undefined) return false
    for (let index = 0; index < bucket.length; index += 1) {
      const entry = bucket[index]
      if (sameValueZero(entry.value, value)) {
        bucket.splice(index, 1)
        if (bucket.length === 0) this.buckets.delete(hash)
        return this.store.delete(entry)
      }
    }
    return false
  }

  /**
   * Membership test using the hash bucket. Average O(1 + bucket length), worst
   * O(n) when all hashes collide; O(1) space.
   */
  has(value: T): boolean {
    const bucket = this.buckets.get(stableHash(value))
    if (bucket === undefined) return false
    for (const entry of bucket) {
      if (sameValueZero(entry.value, value)) return true
    }
    return false
  }

  /** Remove every occurrence. Time O(n) for reclamation, space O(1). */
  clear(): void {
    this.store.clear()
    this.buckets.clear()
    this.serial = 0
  }

  /** Snapshot in hash-bucket order. Time O(n), space O(n). */
  toArray(): T[] {
    return [...this.entries()]
  }

  /** Iteration in hash-bucket order. Time O(n), space O(1) per step. */
  *entries(): IterableIterator<T> {
    for (const entry of this.store.entries()) yield entry.value
  }

  /** Alias of `entries`. Time O(n). */
  [Symbol.iterator](): IterableIterator<T> {
    return this.entries()
  }
}

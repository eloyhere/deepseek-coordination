/**
 * Linear structures: a ring-buffer deque, a stack facade over it, and a queue
 * facade over it.
 *
 * The deque keeps values in a power-of-two-growing circular array with a head
 * cursor, so `push`, `pop`, `shift` and `unshift` are O(1) amortized (an
 * occasional O(n) copy when the buffer doubles or halves) and `at` is O(1).
 * `Stack` reuses the deque and optionally caps its depth, dropping the oldest
 * entry when the cap is exceeded; `Queue` is FIFO over the same buffer.
 *
 * No Node, DOM, React or external dependency is used.
 */
import { InvalidArgumentError } from './error.js'

/** Initial ring size; the buffer always stays a power of two. */
const InitialCapacity = 8

/** Smallest allowed stack depth. */
const MinimumDepth = 1

/**
 * A double-ended queue backed by a circular buffer.
 *
 * `push`/`pop` operate on the back, `unshift`/`shift` on the front, `at` indexes
 * from the front (oldest). All four mutations are O(1) amortized; a grow or
 * shrink copies O(n) once and is amortized away by the geometric capacity
 * policy. `at` is O(1), `toArray` and iteration are O(n) front-to-back. Space is
 * O(n) with at most 4x slack because the buffer halves when it drops to a
 * quarter full. Iteration order is front (oldest) to back (newest).
 */
export class Deque<T> implements Iterable<T> {
  private buffer: Array<T | undefined> = new Array<T | undefined>(InitialCapacity).fill(undefined)
  private head = 0
  private count = 0

  /**
   * @param values Optional initial values, pushed front-to-back in order.
   * Time O(n), space O(n).
   */
  constructor(values?: Iterable<T>) {
    if (values === undefined) return
    for (const value of values) this.push(value)
  }

  /** Number of values. Time O(1). */
  get size(): number {
    return this.count
  }

  /** Append at the back. Time O(1) amortized, space O(1) amortized. */
  push(value: T): this {
    this.ensureCapacity()
    const index = (this.head + this.count) % this.buffer.length
    this.buffer[index] = value
    this.count += 1
    return this
  }

  /**
   * Add at the front. Time O(1) amortized, space O(1) amortized.
   */
  unshift(value: T): this {
    this.ensureCapacity()
    this.head = (this.head - 1 + this.buffer.length) % this.buffer.length
    this.buffer[this.head] = value
    this.count += 1
    return this
  }

  /**
   * Remove and return the back value, or `undefined` when empty.
   * Time O(1) amortized, space O(1).
   */
  pop(): T | undefined {
    if (this.count === 0) return undefined
    const index = (this.head + this.count - 1) % this.buffer.length
    const value = this.buffer[index]
    this.buffer[index] = undefined
    this.count -= 1
    this.shrinkIfNeeded()
    return value
  }

  /**
   * Remove and return the front value, or `undefined` when empty.
   * Time O(1) amortized, space O(1).
   */
  shift(): T | undefined {
    if (this.count === 0) return undefined
    const value = this.buffer[this.head]
    this.buffer[this.head] = undefined
    this.head = (this.head + 1) % this.buffer.length
    this.count -= 1
    this.shrinkIfNeeded()
    return value
  }

  /**
   * Read the value at `index`, where 0 is the front (oldest) and `size - 1` is
   * the back (newest). Time O(1), space O(1). Throws `InvalidArgumentError` for
   * a non-integer or out-of-range index.
   */
  at(index: number): T | undefined {
    this.assertIndex(index)
    return this.buffer[(this.head + index) % this.buffer.length] as T
  }

  /** Remove every value. Time O(n) to drop the old buffer, space O(1). */
  clear(): void {
    this.buffer = new Array<T | undefined>(InitialCapacity).fill(undefined)
    this.head = 0
    this.count = 0
  }

  /** Snapshot from front to back. Time O(n), space O(n). */
  toArray(): T[] {
    return Array.from(this)
  }

  /** Iterate from front (oldest) to back (newest). Time O(n). */
  *[Symbol.iterator](): IterableIterator<T> {
    for (let offset = 0; offset < this.count; offset += 1) {
      yield this.buffer[(this.head + offset) % this.buffer.length] as T
    }
  }

  /** Throw unless `index` addresses a live slot. */
  private assertIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) {
      throw new InvalidArgumentError('deque index must be an integer within [0, size)', {
        index,
        size: this.count,
      })
    }
  }

  /** Double the buffer before an insertion that would overflow it. */
  private ensureCapacity(): void {
    if (this.count < this.buffer.length) return
    this.resize(this.buffer.length * 2)
  }

  /** Halve the buffer once it is only a quarter full. */
  private shrinkIfNeeded(): void {
    if (this.buffer.length <= InitialCapacity) return
    if (this.count * 4 > this.buffer.length) return
    this.resize(Math.max(InitialCapacity, this.buffer.length / 2))
  }

  /** Copy the live range into a fresh buffer of `size` slots. Time O(n). */
  private resize(size: number): void {
    const replacement = new Array<T | undefined>(size).fill(undefined)
    for (let offset = 0; offset < this.count; offset += 1) {
      replacement[offset] = this.buffer[(this.head + offset) % this.buffer.length]
    }
    this.buffer = replacement
    this.head = 0
  }
}

/**
 * A last-in-first-out stack over `Deque`.
 *
 * `push`/`pop`/`peek`/`at` are O(1) amortized; `at(0)` is the top, `at(size - 1)`
 * the bottom. With `maxDepth`, a push that would exceed the depth evicts the
 * oldest (bottom) entry in O(1) amortized, so memory stays bounded. `toArray`
 * and iteration run top-to-bottom in O(n). Space O(depth). Duplicates are
 * allowed.
 */
export class Stack<T> implements Iterable<T> {
  private readonly store = new Deque<T>()
  private readonly limit: number | undefined

  /**
   * @param maxDepth Optional positive integer cap; exceeding it drops the
   * oldest entries. Invalid values throw `InvalidArgumentError`.
   * Time O(1), space O(1).
   */
  constructor(maxDepth?: number) {
    if (maxDepth === undefined) {
      this.limit = undefined
      return
    }
    if (!Number.isInteger(maxDepth) || maxDepth < MinimumDepth) {
      throw new InvalidArgumentError('stack maxDepth must be a positive integer', { maxDepth })
    }
    this.limit = maxDepth
  }

  /** Number of entries. Time O(1). */
  get size(): number {
    return this.store.size
  }

  /**
   * Push onto the top, evicting the oldest entry when the depth cap is reached.
   * Time O(1) amortized, space O(1).
   */
  push(value: T): this {
    this.store.push(value)
    while (this.limit !== undefined && this.store.size > this.limit) this.store.shift()
    return this
  }

  /**
   * Remove and return the top value, or `undefined` when empty.
   * Time O(1) amortized, space O(1).
   */
  pop(): T | undefined {
    return this.store.pop()
  }

  /** Read the top value without removing it. Time O(1). */
  peek(): T | undefined {
    if (this.store.size === 0) return undefined
    return this.store.at(this.store.size - 1)
  }

  /**
   * Read by depth from the top: `at(0)` is the top, `at(size - 1)` the bottom.
   * Time O(1). Throws `InvalidArgumentError` for a non-integer or out-of-range
   * index.
   */
  at(index: number): T | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.store.size) {
      throw new InvalidArgumentError('stack index must be an integer within [0, size)', {
        index,
        size: this.store.size,
      })
    }
    return this.store.at(this.store.size - 1 - index)
  }

  /** Remove every entry. Time O(n) for reclamation, space O(1). */
  clear(): void {
    this.store.clear()
  }

  /** Snapshot from top to bottom. Time O(n), space O(n). */
  toArray(): T[] {
    return Array.from(this)
  }

  /** Iterate from top to bottom. Time O(n). */
  *[Symbol.iterator](): IterableIterator<T> {
    for (let index = this.store.size - 1; index >= 0; index -= 1) {
      yield this.store.at(index) as T
    }
  }
}

/**
 * A first-in-first-out queue over `Deque`.
 *
 * `enqueue` and `dequeue` are O(1) amortized, `peek` is O(1), `toArray` and
 * iteration are O(n) front-to-back. Space O(n). Duplicates are allowed.
 */
export class Queue<T> implements Iterable<T> {
  private readonly store = new Deque<T>()

  /**
   * @param values Optional initial values, enqueued front-to-back.
   * Time O(n), space O(n).
   */
  constructor(values?: Iterable<T>) {
    if (values === undefined) return
    for (const value of values) this.store.push(value)
  }

  /** Number of entries. Time O(1). */
  get size(): number {
    return this.store.size
  }

  /** Append at the back. Time O(1) amortized, space O(1). */
  enqueue(value: T): this {
    this.store.push(value)
    return this
  }

  /**
   * Remove and return the front value, or `undefined` when empty.
   * Time O(1) amortized, space O(1).
   */
  dequeue(): T | undefined {
    return this.store.shift()
  }

  /** Read the front value without removing it. Time O(1). */
  peek(): T | undefined {
    if (this.store.size === 0) return undefined
    return this.store.at(0)
  }

  /** Remove every entry. Time O(n) for reclamation, space O(1). */
  clear(): void {
    this.store.clear()
  }

  /** Snapshot from front to back. Time O(n), space O(n). */
  toArray(): T[] {
    return this.store.toArray()
  }

  /** Iterate from front to back. Time O(n). */
  [Symbol.iterator](): IterableIterator<T> {
    return this.store[Symbol.iterator]()
  }
}

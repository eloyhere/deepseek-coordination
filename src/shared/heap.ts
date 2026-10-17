/**
 * Binary heaps for priority work: evidence ranking, retry scheduling, and any
 * other queue where the smallest or largest item must pop first.
 *
 * `BinaryHeap` is a classic array-backed binary min-heap; pass a reversed
 * comparator for a max-heap. `IndexedHeap` adds a `Map<T, index>` so an arbitrary
 * entry can be removed or its priority refreshed in O(log n) instead of O(n).
 *
 * Both sift up while the child precedes its parent and sift down by swapping
 * with the preceding child; neither is stable (equal-priority entries have no
 * defined relative order). No Node, DOM, React or external dependency is used.
 */
import { InvalidArgumentError } from './error.js'
import { compareValues, defaultComparator } from './tree.js'
import type { Comparator } from './tree.js'

/**
 * An array-backed binary min-heap.
 *
 * `push` and `pop` are O(log n) worst-case time; `peek` is O(1); building from
 * an iterable is O(n) via Floyd heapify; `toArray` and a full iteration are O(n)
 * in heap order, not sorted order. Space O(n). Duplicates are allowed and are
 * independent entries; their relative order is unspecified.
 *
 * Caveat: `toArray()` does not sort. Use repeated `pop()` for sorted output.
 */
export class BinaryHeap<T> implements Iterable<T> {
  private readonly comparator: Comparator<T>
  private items: T[]

  /**
   * @param comparator Total order; the entry that compares smallest pops first.
   * @param values Optional initial values, heapified in O(n).
   * Time O(n) for n initial values, space O(n).
   */
  constructor(comparator: Comparator<T> = defaultComparator, values?: Iterable<T>) {
    this.comparator = comparator
    this.items = values === undefined ? [] : [...values]
    for (let index = Math.floor(this.items.length / 2) - 1; index >= 0; index -= 1) {
      this.siftDown(index)
    }
  }

  /** Number of entries. Time O(1). */
  get size(): number {
    return this.items.length
  }

  /** Add an entry. Time O(log n) worst case, space O(1) amortized. */
  push(value: T): this {
    this.items.push(value)
    this.siftUp(this.items.length - 1)
    return this
  }

  /**
   * Remove and return the entry that compares smallest, or `undefined` when
   * empty. Time O(log n) worst case, space O(1).
   */
  pop(): T | undefined {
    if (this.items.length === 0) return undefined
    const top = this.items[0]
    const last = this.items.pop()
    if (last !== undefined && this.items.length > 0) {
      this.items[0] = last
      this.siftDown(0)
    }
    return top
  }

  /**
   * Read the entry that compares smallest without removing it.
   * Time O(1), space O(1).
   */
  peek(): T | undefined {
    return this.items[0]
  }

  /** Remove every entry. Time O(n) for reclamation. */
  clear(): void {
    this.items = []
  }

  /**
   * Snapshot in heap-array order, not sorted order. Time O(n), space O(n).
   * Deterministic for a given operation sequence, but the order is an
   * implementation detail callers must not interpret as priority order.
   */
  toArray(): T[] {
    return [...this.items]
  }

  /** Iterate in heap-array order, not sorted order. Time O(n). */
  [Symbol.iterator](): IterableIterator<T> {
    return this.items[Symbol.iterator]()
  }

  /** Compare two values through the configurable comparator. */
  private compare(left: T, right: T): number {
    return compareValues(this.comparator, left, right)
  }

  /** Bubble an entry toward the root; O(log n). */
  private siftUp(start: number): number {
    let index = start
    while (index > 0) {
      const parent = (index - 1) >>> 1
      if (this.compare(this.items[index], this.items[parent]) >= 0) break
      this.swap(index, parent)
      index = parent
    }
    return index
  }

  /** Bubble an entry toward the leaves; O(log n). */
  private siftDown(start: number): number {
    let index = start
    while (true) {
      const left = index * 2 + 1
      if (left >= this.items.length) break
      const right = left + 1
      let smallest = left
      if (right < this.items.length && this.compare(this.items[right], this.items[left]) < 0) {
        smallest = right
      }
      if (this.compare(this.items[smallest], this.items[index]) >= 0) break
      this.swap(index, smallest)
      index = smallest
    }
    return index
  }

  /** Swap two heap slots; O(1). */
  private swap(left: number, right: number): void {
    const hold = this.items[left]
    this.items[left] = this.items[right]
    this.items[right] = hold
  }
}

/**
 * A binary min-heap with identity-addressed entries.
 *
 * A `Map<T, index>` mirrors every entry's heap slot, so `remove`, `update` and
 * `decreaseKey` are O(log n) worst-case time instead of O(n), at the cost of
 * O(n) extra map space. `push` and `pop` are O(log n); `peek`, `has` and `size`
 * are O(1); `toArray` and iteration are O(n) in heap order. Space O(n).
 *
 * Values are unique by SameValueZero because they are map keys: `push` of an
 * existing value returns false, and the constructor rejects duplicates with
 * `InvalidArgumentError`. The heap is not stable. `decreaseKey` only sifts up and
 * assumes the comparator now ranks the value earlier; `update` re-sifts in both
 * directions after the caller mutated an object value in place.
 */
export class IndexedHeap<T> implements Iterable<T> {
  private readonly comparator: Comparator<T>
  private readonly positions = new Map<T, number>()
  private items: T[]

  /**
   * @param comparator Total order; the entry that compares smallest pops first.
   * @param values Optional initial values, heapified in O(n).
   * Time O(n) for n values, space O(n). Throws `InvalidArgumentError` if
   * `values` repeats a value.
   */
  constructor(comparator: Comparator<T> = defaultComparator, values?: Iterable<T>) {
    this.comparator = comparator
    this.items = values === undefined ? [] : [...values]
    for (let index = 0; index < this.items.length; index += 1) {
      const value = this.items[index]
      if (this.positions.has(value)) {
        throw new InvalidArgumentError('IndexedHeap does not allow duplicate values', { value })
      }
      this.positions.set(value, index)
    }
    for (let index = Math.floor(this.items.length / 2) - 1; index >= 0; index -= 1) {
      this.siftDown(index)
    }
  }

  /** Number of entries. Time O(1). */
  get size(): number {
    return this.items.length
  }

  /**
   * Add a value that is not already present. Time O(log n) worst case.
   * Returns false when the value is present.
   */
  push(value: T): boolean {
    if (this.positions.has(value)) return false
    this.items.push(value)
    this.positions.set(value, this.items.length - 1)
    this.siftUp(this.items.length - 1)
    return true
  }

  /**
   * Remove and return the entry that compares smallest, or `undefined` when
   * empty. Time O(log n) worst case, space O(1).
   */
  pop(): T | undefined {
    if (this.items.length === 0) return undefined
    const top = this.items[0]
    this.removeAt(0)
    return top
  }

  /** Read the smallest entry without removing it. Time O(1). */
  peek(): T | undefined {
    return this.items[0]
  }

  /** Membership test. Time O(1) average, space O(1). */
  has(value: T): boolean {
    return this.positions.has(value)
  }

  /**
   * Remove an arbitrary entry. Time O(log n) worst case, space O(1).
   * Returns false when the value is absent.
   */
  remove(value: T): boolean {
    const index = this.positions.get(value)
    if (index === undefined) return false
    this.removeAt(index)
    return true
  }

  /**
   * Re-establish heap order after the caller changed the value's priority in
   * place. Time O(log n) worst case, space O(1). Returns false when absent.
   */
  update(value: T): boolean {
    const index = this.positions.get(value)
    if (index === undefined) return false
    const moved = this.siftUp(index)
    this.siftDown(moved)
    return true
  }

  /**
   * Sift a present value toward the root after its priority improved.
   * Time O(log n) worst case, space O(1). Returns false when absent.
   */
  decreaseKey(value: T): boolean {
    const index = this.positions.get(value)
    if (index === undefined) return false
    this.siftUp(index)
    return true
  }

  /** Remove every entry. Time O(n) for reclamation. */
  clear(): void {
    this.items = []
    this.positions.clear()
  }

  /** Snapshot in heap-array order, not sorted order. Time O(n), space O(n). */
  toArray(): T[] {
    return [...this.items]
  }

  /** Iterate in heap-array order, not sorted order. Time O(n). */
  [Symbol.iterator](): IterableIterator<T> {
    return this.items[Symbol.iterator]()
  }

  /** Compare two values through the configurable comparator. */
  private compare(left: T, right: T): number {
    return compareValues(this.comparator, left, right)
  }

  /** Remove the entry at `index`, repairing the heap and the position map. */
  private removeAt(index: number): void {
    const removed = this.items[index]
    const last = this.items.pop()
    this.positions.delete(removed)
    if (last === undefined || index >= this.items.length) return
    this.items[index] = last
    this.positions.set(last, index)
    const moved = this.siftUp(index)
    this.siftDown(moved)
  }

  /** Bubble an entry toward the root; O(log n). */
  private siftUp(start: number): number {
    let index = start
    while (index > 0) {
      const parent = (index - 1) >>> 1
      if (this.compare(this.items[index], this.items[parent]) >= 0) break
      this.swap(index, parent)
      index = parent
    }
    return index
  }

  /** Bubble an entry toward the leaves; O(log n). */
  private siftDown(start: number): number {
    let index = start
    while (true) {
      const left = index * 2 + 1
      if (left >= this.items.length) break
      const right = left + 1
      let smallest = left
      if (right < this.items.length && this.compare(this.items[right], this.items[left]) < 0) {
        smallest = right
      }
      if (this.compare(this.items[smallest], this.items[index]) >= 0) break
      this.swap(index, smallest)
      index = smallest
    }
    return index
  }

  /** Swap two heap slots and update both positions; O(1). */
  private swap(left: number, right: number): void {
    const hold = this.items[left]
    this.items[left] = this.items[right]
    this.items[right] = hold
    this.positions.set(this.items[left], left)
    this.positions.set(this.items[right], right)
  }
}

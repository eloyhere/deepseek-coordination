/**
 * Deterministic hashing and the two array-backed LRU caches.
 *
 * Everything in this module is pure JavaScript: no Node built-ins, no DOM, no
 * external packages. The hash functions are stable across processes and between
 * the Host and the browser half of the plugin, which is what
 * `UnorderedSkipList` in `./list.js` relies on for its bucket order.
 *
 * The LRU caches keep a `Map` from key to array slot plus an array of entries.
 * Deleting or promoting an entry only tombstones its slot, so every operation
 * is O(1) amortized; the array is compacted when tombstones outnumber live
 * entries, which is also where the O(n) work hides (it never happens twice
 * without at least n/2 intervening mutations).
 */
import { InvalidArgumentError } from './error.js'

/** Smallest capacity any LRU cache accepts; smaller requests clamp to it. */
const MinimumCapacity = 1

/** Largest capacity any LRU cache accepts; larger requests clamp to it. */
const MaximumCapacity = 100000

const FnvOffsetBasis = 0x811c9dc5
const FnvPrime = 0x01000193

/** Type tags keep values of different kinds from colliding in `stableHash`. */
const TagUndefined = 0x1f2e3d4c
const TagNull = 0x2a3b4c5d
const TagFalse = 0x3b4c5d6e
const TagTrue = 0x4c5d6e7f
const TagNumber = 0x5d6e7f80
const TagBigInt = 0x6e7f8091
const TagString = 0x7f8091a2
const TagSymbol = 0x8091a2b3
const TagFunction = 0x91a2b3c4
const TagArray = 0xa2b3c4d5
const TagObject = 0xb3c4d5e6
const TagDate = 0xc4d5e6f7
const TagMap = 0xd5e6f7a8
const TagSet = 0xe6f7a8b9
const TagCycle = 0xf7a8b9ca
const TagDepthLimit = 0x08b9cadb
const TagUnknown = 0x19cadbec

/** Deepest object nesting `stableHash` inspects; deeper values hash a marker. */
const MaximumHashDepth = 6

/*
 * One shared scratch pair reads the IEEE-754 words of a number without
 * allocating a new buffer per call. Writing and reading happen back to back in
 * the same synchronous call, so the shared state is never observed torn.
 */
const NumberScratch = new Float64Array(1)
const NumberWords = new Uint32Array(NumberScratch.buffer)
const EndianProbe = new Uint16Array([0x1234])
const IsLittleEndian = new Uint8Array(EndianProbe.buffer)[0] === 0x34

/**
 * FNV-1a (32 bit) over UTF-16 code units.
 *
 * Time O(n) in the string length, space O(1), no allocation. The hash is stable
 * across engines and processes. Caveat: code units, not code points, are hashed,
 * so an astral character contributes two rounds, and canonically equivalent
 * Unicode strings with different code units hash differently.
 */
export function hashString(value: string): number {
  let hash = FnvOffsetBasis
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, FnvPrime)
  }
  return hash >>> 0
}

/**
 * Mix the IEEE-754 bit pattern of a number into a stable 32-bit hash.
 *
 * Time O(1), space O(1). Integers, fractions, `-0`/`0`, `Infinity` and
 * `-Infinity` all hash deterministically. All NaN payloads collapse to one
 * canonical NaN hash so callers never depend on engine-specific NaN bits.
 * Caveat: the result exposes the same value zero would, so callers that need to
 * distinguish `-0` from `0` must do so themselves (the two are deliberately
 * equal here, matching `===`).
 */
export function hashNumber(value: number): number {
  if (Number.isNaN(value)) return mixWords(0, 0x7ff80000)
  if (value === 0) return mixWords(0, 0)
  NumberScratch[0] = value
  const low = IsLittleEndian ? NumberWords[0] : NumberWords[1]
  const high = IsLittleEndian ? NumberWords[1] : NumberWords[0]
  return mixWords(low, high)
}

/**
 * Order-sensitive combination of two 32-bit hashes.
 *
 * Time O(1), space O(1). `hashCombine(left, right)` and
 * `hashCombine(right, left)` are different values for essentially every pair,
 * which is why arrays and sorted object keys can be folded in sequence without
 * losing order information.
 */
export function hashCombine(left: number, right: number): number {
  let hash = Math.imul((left >>> 0) ^ 0x9e3779b9, 0x85ebca6b)
  hash ^= hash >>> 13
  hash = Math.imul(hash ^ (right >>> 0), 0xc2b2ae35)
  hash ^= hash >>> 16
  return hash >>> 0
}

/**
 * Structural hash of a JavaScript value.
 *
 * Supports `undefined`, `null`, booleans, numbers, strings, bigints, symbols
 * (by description), functions (by name), arrays (ordered), dates (by time),
 * maps and sets (iteration order) and plain objects with sorted own enumerable
 * string keys. Time O(size) in the number of inspected properties, space O(depth)
 * for the recursion stack plus a `seen` set of O(depth) live ancestors.
 *
 * Caveats: nesting deeper than six levels is folded into one marker hash; a
 * value that refers back to one of its own ancestors is likewise folded into a
 * cycle marker, so the function always terminates. Symbols with the same
 * description collide, functions with the same name collide, class identity and
 * prototypes are not inspected, and non-enumerable properties are ignored.
 */
export function stableHash(value: unknown): number {
  return hashValue(value, 0, new Set<object>())
}

/**
 * Clamp an LRU capacity into the supported range and reject non-integers.
 *
 * Time O(1), space O(1). Values below 1 become 1 and values above 100000 become
 * 100000; `NaN`, `Infinity` and fractional values throw `InvalidArgumentError`
 * because silently rounding them would hide a caller bug.
 */
export function normaliseCapacity(capacity: number): number {
  if (!Number.isInteger(capacity)) {
    throw new InvalidArgumentError('capacity must be an integer between 1 and 100000', { capacity })
  }
  if (capacity < MinimumCapacity) return MinimumCapacity
  if (capacity > MaximumCapacity) return MaximumCapacity
  return capacity
}

interface HashLruEntry<K, V> {
  readonly key: K
  value: V
}

/**
 * A Map + Array LRU: most-recently used entries are at the end of the array.
 *
 * `get` and `touch` promote, `peek` and `has` do not, and `set` always moves the
 * key to the most-recent position. Time O(1) amortized for every operation;
 * the array is compacted when tombstones exceed half of its slots, and that
 * compaction is O(n) but can only run after at least n/2 operations that created
 * tombstones, so the amortized cost stays constant. Space O(capacity).
 *
 * Iteration (`keys`, `values`, `entries`, `toArray`) runs most-recent first and
 * skips tombstones. The iterator is live: mutating during iteration is not
 * supported and can skip or repeat entries.
 */
export class HashLruList<K, V> implements Iterable<[K, V]> {
  private readonly slotByKey = new Map<K, number>()
  private slots: Array<HashLruEntry<K, V> | undefined> = []
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
   * Number of tombstoned array slots, exposed for diagnostics and tests.
   * Time O(1). Stays at or below half of the slot array between compactions.
   */
  get tombstoneCount(): number {
    return this.tombstones
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
    const entry: HashLruEntry<K, V> = { key, value }
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
    const moved: HashLruEntry<K, V> = { key: entry.key, value: entry.value }
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
    const live: Array<HashLruEntry<K, V>> = []
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
 * A weak-key variant of `HashLruList`.
 *
 * Keys are held through `WeakRef`, values strongly. The internal ordering is
 * the same Map + Array LRU; the key object is only dereferenced when an entry is
 * read, iterated or swept. A `FinalizationRegistry` (when the runtime provides
 * one) also drops entries as keys are collected, but garbage-collection timing
 * is not deterministic: a dead entry may keep occupying capacity until a sweep,
 * which happens on `size`, iteration, `get`/`peek` of that key, or the next
 * finalizer callback. Space O(capacity). Every operation is O(1) amortized
 * except `size`, which is O(n) because it sweeps collected references.
 *
 * Caveat: the finalizer callback closes over this instance, so the runtime keeps
 * the cache alive until every registered key has been collected.
 */
export class HashWeakLruList<K extends object, V> implements Iterable<[K, V]> {
  private readonly store: HashLruList<WeakRef<K>, V>
  private references = new WeakMap<K, WeakRef<K>>()
  private readonly registry: FinalizationRegistry<WeakRef<K>> | undefined

  /**
   * @param capacity Maximum live entries; clamped to 1..100000.
   * Time O(1), space O(1).
   */
  constructor(capacity = 64) {
    this.store = new HashLruList<WeakRef<K>, V>(capacity)
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
   * Number of tombstones in the backing LRU, for diagnostics. Time O(1).
   * Dead keys that have not been swept yet are not counted separately.
   */
  get tombstoneCount(): number {
    return this.store.tombstoneCount
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

/** Avalanche the two IEEE-754 words into one unsigned 32-bit hash. */
function mixWords(low: number, high: number): number {
  let hash = FnvOffsetBasis
  hash = Math.imul(hash ^ (low >>> 0), FnvPrime)
  hash = Math.imul(hash ^ (high >>> 0), FnvPrime)
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b)
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35)
  hash ^= hash >>> 16
  return hash >>> 0
}

/** Recursive worker for `stableHash`; `depth` and `seen` guard cycles and depth. */
function hashValue(value: unknown, depth: number, seen: Set<object>): number {
  switch (typeof value) {
    case 'undefined':
      return TagUndefined
    case 'boolean':
      return value ? TagTrue : TagFalse
    case 'number':
      return hashCombine(TagNumber, hashNumber(value))
    case 'string':
      return hashCombine(TagString, hashString(value))
    case 'bigint':
      return hashCombine(TagBigInt, hashString(value.toString()))
    case 'symbol':
      return hashCombine(TagSymbol, hashString(value.description ?? ''))
    case 'function':
      return hashCombine(TagFunction, hashString(value.name))
    case 'object': {
      if (value === null) return TagNull
      if (seen.has(value)) return TagCycle
      if (depth >= MaximumHashDepth) return TagDepthLimit
      seen.add(value)
      try {
        return hashObject(value, depth, seen)
      } finally {
        seen.delete(value)
      }
    }
    default:
      return TagUnknown
  }
}

/** Hash an already-admitted object value; arrays and built-ins get type tags. */
function hashObject(value: object, depth: number, seen: Set<object>): number {
  if (Array.isArray(value)) {
    const elements: unknown[] = value
    let hash = hashCombine(TagArray, hashNumber(elements.length))
    for (const element of elements) {
      hash = hashCombine(hash, hashValue(element, depth + 1, seen))
    }
    return hash
  }
  if (value instanceof Date) {
    return hashCombine(TagDate, hashNumber(value.getTime()))
  }
  if (value instanceof Map) {
    const entries = value as Map<unknown, unknown>
    let hash = hashCombine(TagMap, hashNumber(entries.size))
    for (const [key, entry] of entries) {
      hash = hashCombine(hash, hashValue(key, depth + 1, seen))
      hash = hashCombine(hash, hashValue(entry, depth + 1, seen))
    }
    return hash
  }
  if (value instanceof Set) {
    const elements = value as Set<unknown>
    let hash = hashCombine(TagSet, hashNumber(elements.size))
    for (const element of elements) {
      hash = hashCombine(hash, hashValue(element, depth + 1, seen))
    }
    return hash
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  let hash = hashCombine(TagObject, hashNumber(keys.length))
  for (const key of keys) {
    hash = hashCombine(hash, hashString(key))
    hash = hashCombine(hash, hashValue(record[key], depth + 1, seen))
  }
  return hash
}

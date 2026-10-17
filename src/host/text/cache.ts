/**
 * Bounded parse cache.
 *
 * The key is the invalidation contract from `docs/file-processing-v24.md` §7:
 * `path + mtime + size + parserId`. A file edit changes `mtime` and often
 * `size`, so the next lookup misses; a parser upgrade changes `parserId`
 * (`javascript@2`) and also misses. No content hash is needed here — the file
 * layer owns freshness, and the cache never reads a file.
 *
 * `LruList` (shared) supplies O(1) amortized get/set/evict and recency order;
 * this module only builds/validates the key and tracks hit/miss/eviction stats.
 *
 * Complexity: O(1) amortized per operation, O(capacity) space.
 */
import { LruList } from '../../shared/lru.js'
import { InvalidArgumentError } from '../../shared/error.js'
import type { ParseResult } from './parser.js'

/** Inputs that identify one parse result. */
export interface CacheFingerprint {
  /** Workspace-relative path. */
  path: string
  /** File mtime in milliseconds. */
  mtime: number
  /** File size in bytes. */
  size: number
  /** Parser id, optionally versioned (`javascript@2`). */
  parserId: string
}

/** Cache counters; all O(1) to read. */
export interface ParseCacheStats {
  hits: number
  misses: number
  evictions: number
  size: number
  capacity: number
}

/**
 * Capacity-bounded `ParseResult` cache keyed by `path+mtime+size+parserId`.
 *
 * Default capacity 256 files, matching the parse-cache budget. Use one cache per
 * project/tenant when the same absolute path could appear in two roots.
 */
export class ParseCache {
  private readonly store: LruList<string, ParseResult>
  private hitCount = 0
  private missCount = 0
  private evictionCount = 0

  /**
   * @param capacity Maximum live entries, clamped by `LruList` to 1..100000.
   * Time O(1), space O(1).
   */
  constructor(capacity = 256) {
    this.store = new LruList<string, ParseResult>(capacity)
  }

  /** Number of live entries. Time O(1). */
  get size(): number {
    return this.store.size
  }

  /** Configured capacity. Time O(1). */
  get capacity(): number {
    return this.store.capacity
  }

  /**
   * Stable cache key. Exposed so tests and callers can assert invalidation
   * without reaching into the store.
   *
   * Time O(path length), space O(key length).
   */
  key(fingerprint: CacheFingerprint): string {
    validateFingerprint(fingerprint)
    return `${fingerprint.parserId}\u0000${fingerprint.path}\u0000${fingerprint.mtime}\u0000${fingerprint.size}`
  }

  /**
   * Read a cached result, promoting it. Counts a hit or miss.
   * Time O(1) amortized.
   */
  get(fingerprint: CacheFingerprint): ParseResult | undefined {
    const value = this.store.get(this.key(fingerprint))
    if (value === undefined) this.missCount += 1
    else this.hitCount += 1
    return value
  }

  /**
   * Read without promoting or counting. Time O(1).
   */
  peek(fingerprint: CacheFingerprint): ParseResult | undefined {
    return this.store.peek(this.key(fingerprint))
  }

  /**
   * Insert or update a result, evicting the least-recently used entry when over
   * capacity. Time O(1) amortized.
   */
  set(fingerprint: CacheFingerprint, result: ParseResult): this {
    const key = this.key(fingerprint)
    const known = this.store.has(key)
    if (!known && this.store.size >= this.store.capacity) this.evictionCount += 1
    this.store.set(key, result)
    return this
  }

  /** Remove one entry. Time O(1) amortized. */
  delete(fingerprint: CacheFingerprint): boolean {
    return this.store.delete(this.key(fingerprint))
  }

  /** Membership test that does not promote. Time O(1). */
  has(fingerprint: CacheFingerprint): boolean {
    return this.store.has(this.key(fingerprint))
  }

  /** Remove every entry. Time O(n) for reclamation. */
  clear(): void {
    this.store.clear()
  }

  /**
   * Change the capacity, evicting when it shrinks. Time O(1) amortized.
   */
  resize(capacity: number): void {
    this.store.resize(capacity)
  }

  /** Counter snapshot. Time O(1). */
  stats(): ParseCacheStats {
    return {
      hits: this.hitCount,
      misses: this.missCount,
      evictions: this.evictionCount,
      size: this.store.size,
      capacity: this.store.capacity,
    }
  }

  /** Keys from most to least recently used. Time O(n). */
  keys(): IterableIterator<string> {
    return this.store.keys()
  }
}

function validateFingerprint(fingerprint: CacheFingerprint): void {
  if (fingerprint === null || typeof fingerprint !== 'object') {
    throw new InvalidArgumentError('cache fingerprint must be an object')
  }
  if (typeof fingerprint.path !== 'string' || fingerprint.path.length === 0) {
    throw new InvalidArgumentError('cache fingerprint path must be a non-empty string')
  }
  if (!Number.isFinite(fingerprint.mtime) || fingerprint.mtime < 0) {
    throw new InvalidArgumentError('cache fingerprint mtime must be a non-negative number', {
      mtime: fingerprint.mtime,
    })
  }
  if (!Number.isInteger(fingerprint.size) || fingerprint.size < 0) {
    throw new InvalidArgumentError('cache fingerprint size must be a non-negative integer', {
      size: fingerprint.size,
    })
  }
  if (typeof fingerprint.parserId !== 'string' || fingerprint.parserId.length === 0) {
    throw new InvalidArgumentError('cache fingerprint parserId must be a non-empty string')
  }
}

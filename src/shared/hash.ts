/**
 * Deterministic hashing plus the capacity-clamping leaf helper.
 *
 * Everything in this module is pure JavaScript: no Node built-ins, no DOM, no
 * external packages. The hash functions are stable across processes and between
 * the Host and the browser half of the plugin, which is what
 * `UnorderedSkipList` in `./list.js` relies on for its bucket order.
 *
 * This module deliberately exports no cache or LRU. The only array-backed LRU
 * in the shared layer lives in `./lru.js`, where `LruList` owns the Map + slot
 * array and `WeakLruList` composes it. The former `HashLruList`/`HashWeakLruList`
 * memo lived here; that storage is now private to those public caches, so no
 * second LRU core is exported. `normaliseCapacity` remains here as a tiny,
 * deterministic leaf helper shared by every bounded structure.
 */
import { InvalidArgumentError } from './error.js'

/** Smallest capacity any bounded collection accepts; smaller requests clamp to it. */
const MinimumCapacity = 1

/** Largest capacity any bounded collection accepts; larger requests clamp to it. */
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
 * Clamp a bounded-collection capacity into the supported range and reject
 * non-integers.
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

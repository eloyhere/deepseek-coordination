/**
 * Lossless-JSON safety for values that cross the tool boundary.
 *
 * DSH validates every tool result by detaching it into plain JSON: a nested
 * `undefined`, `NaN`, `Infinity`, `-0`, a class instance, a `Map`, a cycle or a
 * hole in a sparse array makes the whole value "not lossless JSON" and the
 * harness rejects the tool call. A live run caught exactly that on
 * `coordination_selection`, where a foreign port supplied a field the type
 * declares as present but the runtime omitted.
 *
 * `jsonSafe` returns a detached plain copy, dropping the parts JSON cannot
 * carry and coercing the numeric ones, and reports whether anything changed so
 * the caller can log it instead of failing the call. It is the tool boundary's
 * contract, not a general serializer: dates become ISO strings, a `Map` becomes
 * an object, a `Set` becomes an array, and a cycle drops the offending edge.
 */

export interface JsonSafeResult<T> {
  /** A detached value whose `JSON.parse(JSON.stringify(value))` equals it. */
  value: T
  /** True when anything had to be dropped or coerced. */
  changed: boolean
}

const MaxDepth = 32

type Seen = Set<object>

/**
 * Detach `input` into lossless JSON.
 *
 * Absent (`undefined`) object properties are dropped, absent array items become
 * `null`, non-finite numbers and `-0` become `null`/`0`, `bigint` becomes a
 * string, functions and symbols are dropped, and a repeated object reference is
 * cut rather than followed.
 */
export function jsonSafe<T>(input: T): JsonSafeResult<T> {
  const seen: Seen = new Set()
  let changed = false

  const convert = (value: unknown, depth: number): unknown => {
    if (value === undefined) {
      changed = true
      return undefined
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
      return value
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        changed = true
        return null
      }
      if (Object.is(value, -0)) {
        changed = true
        return 0
      }
      return value
    }
    if (typeof value === 'bigint') {
      changed = true
      return value.toString()
    }
    if (typeof value === 'function' || typeof value === 'symbol') {
      changed = true
      return undefined
    }
    if (depth >= MaxDepth) {
      changed = true
      return null
    }

    const object = value as Record<string, unknown> | unknown[]
    if (seen.has(object as object)) {
      changed = true
      return undefined
    }
    seen.add(object as object)
    try {
      if (Array.isArray(object)) {
        const out: unknown[] = []
        for (let index = 0; index < object.length; index += 1) {
          if (!Object.hasOwn(object, index)) {
            changed = true
            out.push(null)
            continue
          }
          const item = convert(object[index], depth + 1)
          out.push(item === undefined ? null : item)
        }
        return out
      }
      if (object instanceof Date) {
        changed = true
        return Number.isNaN(object.getTime()) ? null : object.toISOString()
      }
      if (object instanceof Map) {
        changed = true
        const out: Record<string, unknown> = {}
        for (const [key, item] of object) {
          out[String(key)] = convert(item, depth + 1)
        }
        return out
      }
      if (object instanceof Set) {
        changed = true
        return [...object].map((item) => convert(item, depth + 1)).filter((item) => item !== undefined)
      }
      const record = object as Record<string, unknown>
      const prototype = Object.getPrototypeOf(record)
      if (prototype !== Object.prototype && prototype !== null) changed = true
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(record)) {
        let item: unknown
        try {
          item = record[key]
        } catch {
          changed = true
          continue
        }
        const converted = convert(item, depth + 1)
        if (converted === undefined) {
          changed = true
          continue
        }
        out[key] = converted
      }
      return out
    } finally {
      seen.delete(object as object)
    }
  }

  const value = convert(input, 0) as T
  return { value, changed }
}

/** Detach any value into the lossless JSON the tool boundary accepts. */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

export function jsonSafe(value: unknown): JsonValue {
  if (value === undefined) return null
  try {
    const text = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'bigint') return item.toString()
      if (typeof item === 'function' || typeof item === 'symbol') return undefined
      if (typeof item === 'number' && !Number.isFinite(item)) return null
      return item
    })
    return text === undefined ? null : (JSON.parse(text) as JsonValue)
  } catch {
    return String(value)
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function stringArg(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

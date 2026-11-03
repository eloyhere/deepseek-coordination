/**
 * Attach `tookMs` to model-facing tool results.
 *
 * The audit showed only `coordination_index` reported its duration; every other
 * call left the model guessing whether a silent 3 ms lookup or a 900 ms scan had
 * happened. This decorator measures each call once, at registration, so no tool
 * implementation repeats the timing code:
 *
 *  - the value is decorated only for non-array object results (an error envelope
 *    gets the field too, so a failed call is measurable);
 *  - the declaration's output schema gains an optional `tookMs` on every
 *    top-level object branch, because the registry validates against a closed
 *    schema and the original object is cloned rather than mutated (several tools
 *    share schema constants);
 *  - a value that already carries `tookMs` is left alone.
 */
import type { CoordinationToolDefinition, CoordinationToolRegistry, ToolExecution } from './tools.js'

/** One optional property added to a closed object schema branch. */
const TOOK_MS_PROPERTY = Object.freeze({ type: 'number' })

/** Clone a schema and declare optional `tookMs` on each top-level object branch. */
export function schemaWithTookMs(schema: unknown): Record<string, unknown> {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return schema as Record<string, unknown>
  }
  let clone: Record<string, unknown>
  try {
    clone = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>
  } catch {
    return schema as Record<string, unknown>
  }
  addTookMs(clone)
  return clone
}

function addTookMs(node: Record<string, unknown>): void {
  for (const key of ['oneOf', 'anyOf'] as const) {
    const branches = node[key]
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        if (typeof branch === 'object' && branch !== null && !Array.isArray(branch)) {
          addTookMs(branch as Record<string, unknown>)
        }
      }
      return
    }
  }
  if (node.type !== 'object' && node.properties === undefined) return
  const properties = typeof node.properties === 'object' && node.properties !== null
    ? (node.properties as Record<string, unknown>)
    : {}
  node.properties = { ...properties, tookMs: { ...TOOK_MS_PROPERTY } }
}

/** Wrap one registry so every successful or failed object result carries `tookMs`. */
export function withToolTiming(registry: CoordinationToolRegistry): CoordinationToolRegistry {
  return {
    register(definition: CoordinationToolDefinition): () => void {
      const timed: CoordinationToolDefinition = {
        ...definition,
        output: {
          ...definition.output,
          schema: schemaWithTookMs(definition.output.schema),
        },
        async execute(args: Record<string, unknown>, exec?: ToolExecution): Promise<unknown> {
          const started = Date.now()
          const value = await definition.execute(args, exec)
          const tookMs = Math.max(0, Date.now() - started)
          if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
          if (Object.hasOwn(value, 'tookMs')) return value
          return { ...(value as Record<string, unknown>), tookMs }
        },
      }
      return registry.register(timed)
    },
  }
}

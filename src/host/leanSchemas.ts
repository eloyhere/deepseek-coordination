/**
 * Lean wire schemas: strip per-property `description` text from tool parameters.
 *
 * Measured with `/context/metrics`, per-property descriptions were 4,198 of the
 * 18,866 catalog characters (~22%). They are documentation only: the plugin's
 * tools validate against their own schema objects, so removing the text from the
 * *declaration* changes what the model reads, never what `execute` accepts.
 *
 * Top-level tool descriptions stay (they are the discovery surface), as do
 * types, enums, `required`, `minimum`/`maximum`, patterns and defaults. Set
 * `COORDINATION_SCHEMA_DETAIL=full` to ship the documented declarations again.
 */
import type { CoordinationToolDefinition, CoordinationToolRegistry } from './tools.js'

/** Clone a JSON value; returns the input when it is not JSON-serialisable. */
function clone<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    return value
  }
}

/** Strip `description` from every node reachable through `properties`/`items`/`oneOf`. */
export function leanParameters(schema: unknown): unknown {
  const cloned = clone(schema)
  const visit = (node: unknown, stripSelf: boolean): void => {
    if (typeof node !== 'object' || node === null) return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, true)
      return
    }
    const record = node as Record<string, unknown>
    if (stripSelf) delete record.description
    const properties = record.properties
    if (typeof properties === 'object' && properties !== null && !Array.isArray(properties)) {
      for (const value of Object.values(properties as Record<string, unknown>)) visit(value, true)
    }
    for (const key of ['items', 'oneOf', 'anyOf', 'allOf'] as const) {
      if (record[key] !== undefined) visit(record[key], true)
    }
  }
  visit(cloned, false)
  return cloned
}

/** Wrap one registry, optionally replacing each declaration's parameters with the lean copy. */
export function withLeanSchemas(
  registry: CoordinationToolRegistry,
  detail: 'lean' | 'full' = 'lean',
): CoordinationToolRegistry {
  if (detail === 'full') return registry
  return {
    register(definition: CoordinationToolDefinition): () => void {
      return registry.register({
        ...definition,
        parameters: leanParameters(definition.parameters) as Record<string, unknown>,
      })
    },
  }
}

/** The configured declaration detail; `full` restores documented properties. */
export function schemaDetailFromEnv(env: NodeJS.ProcessEnv = process.env): 'lean' | 'full' {
  return env.COORDINATION_SCHEMA_DETAIL === 'full' ? 'full' : 'lean'
}

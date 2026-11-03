/**
 * Static context accounting for the model-facing catalog.
 *
 * The audit measured ~22.6k characters of tool definitions (≈5.6k tokens) sent
 * on every request, plus the skill catalog and the per-turn AMP block. This
 * module turns that into a number the operator (and the model) can query:
 *
 *  - one metric per registered tool (description + JSON parameter schema);
 *  - a deterministic sha256 over the whole catalog, so a locale switch or a
 *    description edit is visible as a changed hash (this is the cache-prefix
 *    signal: the catalog text is part of the cached prefix);
 *  - the skill catalog size for the active language and the AMP block's cap.
 *
 * It measures what the plugin itself sends; DSH's own tool block and system
 * prompt are outside this plugin's authority and are reported as unknown.
 */
import { createHash } from 'node:crypto'
import { AMP_CONTEXT_MAX_CHARS } from './ampExtensions.js'
import { AMP_PLANNING_SKILLS } from './ampSkills.js'
import type { CoordinationToolDefinition, CoordinationToolRegistry } from './tools.js'
import { normaliseLocale, type Locale } from '../shared/i18n.js'

export interface ToolCatalogEntryMetric {
  readonly name: string
  /** `name + description + JSON parameters` in characters. */
  readonly chars: number
  /** Approximate tokens at 4 characters per token. */
  readonly tokens: number
  readonly descriptionChars: number
  /** Characters spent on per-property `description` strings inside parameters. */
  readonly parameterDescriptionChars: number
}

export interface ToolCatalogMetrics {
  readonly tools: {
    readonly count: number
    readonly chars: number
    readonly tokens: number
    /** sha256 over the deterministic catalog text; changes on locale/content edits. */
    readonly hash: string
    readonly entries: readonly ToolCatalogEntryMetric[]
  }
  /** Section hashes for the cache-prefix signal; a changed hash means a prefix miss. */
  readonly sections: {
    readonly tools: string
    readonly skills: string
  }
  readonly skills: {
    readonly count: number
    readonly chars: number
    readonly tokens: number
    readonly locale: Locale
  }
  readonly ampContext: {
    readonly maxChars: number
  }
}

/** Total characters and count of `description` strings inside a schema. */
export function parameterDescriptionStats(schema: unknown): { chars: number; count: number } {
  let chars = 0
  let count = 0
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    const record = node as Record<string, unknown>
    if (typeof record.description === 'string') {
      chars += record.description.length
      count += 1
    }
    // `properties` is a name→schema map, so each value is a schema node.
    const properties = record.properties
    if (typeof properties === 'object' && properties !== null && !Array.isArray(properties)) {
      for (const value of Object.values(properties as Record<string, unknown>)) visit(value)
    }
    for (const key of ['items', 'oneOf', 'anyOf', 'allOf'] as const) {
      if (record[key] !== undefined) visit(record[key])
    }
  }
  visit(schema)
  return { chars, count }
}

/** Character count of one definition as the model receives it. */
function definitionChars(definition: CoordinationToolDefinition): { chars: number; descriptionChars: number } {
  const descriptionChars = definition.description.length
  const parameters = (() => {
    try {
      return JSON.stringify(definition.parameters)
    } catch {
      return ''
    }
  })()
  return { chars: definition.name.length + descriptionChars + parameters.length, descriptionChars }
}

function tokensOf(chars: number): number {
  return Math.ceil(chars / 4)
}

/** Deterministic catalog text: one line per tool, sorted by name. */
function catalogText(definitions: readonly CoordinationToolDefinition[]): string {
  return [...definitions]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((definition) => {
      let parameters = ''
      try {
        parameters = JSON.stringify(definition.parameters)
      } catch {
        parameters = ''
      }
      return `${definition.name}\u0000${definition.description}\u0000${parameters}`
    })
    .join('\u0001')
}

/** Collect the definitions actually registered, keyed by name. */
export class ToolCatalog {
  private readonly definitions = new Map<string, CoordinationToolDefinition>()

  add(definition: CoordinationToolDefinition): () => void {
    this.definitions.set(definition.name, definition)
    return () => {
      if (this.definitions.get(definition.name) === definition) {
        this.definitions.delete(definition.name)
      }
    }
  }

  get size(): number {
    return this.definitions.size
  }

  metrics(locale: Locale = 'en-US'): ToolCatalogMetrics {
    const definitions = [...this.definitions.values()]
    const entries = definitions
      .map((definition) => {
        const { chars, descriptionChars } = definitionChars(definition)
        return {
          name: definition.name,
          chars,
          tokens: tokensOf(chars),
          descriptionChars,
          parameterDescriptionChars: parameterDescriptionStats(definition.parameters).chars,
        }
      })
      .sort((left, right) => right.chars - left.chars || left.name.localeCompare(right.name))
    const chars = entries.reduce((total, entry) => total + entry.chars, 0)
    const current = normaliseLocale(locale)
    const skillText = [...AMP_PLANNING_SKILLS]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((skill) => `${skill.name}\u0000${current === 'zh-CN' ? skill.description.zh : skill.description.en}`)
      .join('\u0001')
    const skillChars = AMP_PLANNING_SKILLS.reduce(
      (total, skill) => total + skill.name.length + (current === 'zh-CN' ? skill.description.zh : skill.description.en).length,
      0,
    )
    const toolsHash = `sha256:${createHash('sha256').update(catalogText(definitions)).digest('hex')}`
    return {
      tools: {
        count: entries.length,
        chars,
        tokens: tokensOf(chars),
        hash: toolsHash,
        entries,
      },
      sections: {
        tools: toolsHash,
        skills: `sha256:${createHash('sha256').update(skillText).digest('hex')}`,
      },
      skills: {
        count: AMP_PLANNING_SKILLS.length,
        chars: skillChars,
        tokens: tokensOf(skillChars),
        locale: current,
      },
      ampContext: { maxChars: AMP_CONTEXT_MAX_CHARS },
    }
  }
}

/** Record every definition registered through one registry. */
export function withToolCatalog(registry: CoordinationToolRegistry, catalog: ToolCatalog): CoordinationToolRegistry {
  return {
    register(definition: CoordinationToolDefinition): () => void {
      const dispose = registry.register(definition)
      const remove = catalog.add(definition)
      return () => {
        remove()
        dispose()
      }
    },
  }
}

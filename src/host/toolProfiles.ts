/**
 * Tool profiles: the catalog can be narrowed without losing per-tool guidance.
 *
 * The full surface is 23 tools and ~3.1k catalog tokens after the diet. Some of
 * that surface is administration and GUI-facing (`coordination_control`,
 * `coordination_environment`, `coordination_knowledge`, `coordination_notification`,
 * `coordination_approve`, `coordination_workspace`, `coordination_workspace_adjust`);
 * a session that only reads and plans does not need them.
 *
 * `COORDINATION_TOOL_PROFILE=core` registers the high-frequency set only, which
 * measures at ~1.5k tokens from the same `/context/metrics` numbers. The default
 * stays `full`: dropping notification/approval from the default surface would
 * remove features that were explicitly asked for.
 */
import type { CoordinationToolDefinition, CoordinationToolRegistry } from './tools.js'

export type ToolProfile = 'full' | 'core'

/**
 * High-frequency tools: file layer, graph reads, selection, planning, index.
 *
 * Everything not listed here (control/environment/knowledge, notification,
 * approval, the workspace mutation tools) is administration or GUI-facing.
 */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'coordination_parse',
  'coordination_describe',
  'coordination_chain',
  'coordination_read',
  'coordination_file',
  'coordination_outline',
  'coordination_importation',
  'coordination_exportation',
  'coordination_index',
  'coordination_selection',
  'coordination_profession',
  'coordination_profession_lock',
  'coordination_mission',
  'coordination_goal',
  'coordination_plan',
  'coordination_collaboration',
])

/** The configured profile; anything other than `core` means `full`. */
export function profileFromEnv(env: NodeJS.ProcessEnv = process.env): ToolProfile {
  return env.COORDINATION_TOOL_PROFILE === 'core' ? 'core' : 'full'
}

/** Wrap one registry, dropping definitions outside the profile. */
export function withToolProfile(registry: CoordinationToolRegistry, profile: ToolProfile): CoordinationToolRegistry {
  if (profile === 'full') return registry
  return {
    register(definition: CoordinationToolDefinition): () => void {
      if (!CORE_TOOL_NAMES.has(definition.name)) return () => {}
      return registry.register(definition)
    },
  }
}

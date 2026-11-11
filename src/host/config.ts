/** Plugin configuration. Every value a deployment may want to change is a field. */
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  /** Tenant identity written into every AMP aggregate. */
  tenantId: string
  /** Root identity written into every AMP aggregate. */
  rootId: string
  /** Where AMP keeps its data: the workspace root (`workspace`) or `$DSH_HOME` (`user`). */
  storage: 'workspace' | 'user'
  /** Directory, relative to the workspace root, that holds the kernel store and host state. */
  storeDirectory: string
  /** One explicit AMP SQLite file shared by every workspace; overrides `storage`. */
  storePath?: string
  /** Agent-facing AMP modules to register; omit for every agent-tier module. */
  modules?: string[]
  /** Register the notification tool and its `/notify/pending` route. */
  notifications: boolean
  /** Add the AMP operating contract to the system prompt. */
  prompt: boolean
  /** Register the AMP skill catalog through `ctx.skills`. */
  skills: boolean
  /** Register the `/amp` human command. */
  commands: boolean
  /** Read-only HTTP routes under `/deepseek-coordination/amp`. */
  routes: boolean
  /** Gateway journal entries kept in memory. */
  maxJournal: number
  /** Ceiling for one workspace read. */
  maxReadChars: number
  /** Ceiling for one workspace write. */
  maxWriteChars: number
  /** Compile an AMP attention package into the model context each turn. */
  contextOptimization: boolean
  /** Token budget for one compiled AMP attention package. */
  contextBudgetTokens: number
  /** Compiled AMP payloads retained in the per-store AMP `ContextCache`. */
  contextCacheEntries: number
  /** Compiled payload tokens retained in the per-store AMP `ContextCache`. */
  contextCacheTokens: number
  /** Milliseconds since last access after which a compiled payload is discarded. */
  contextCacheTtlMs: number
  /** Most recent attention entries AMP's prune planner always keeps. */
  contextPruneKeepRecent: number
  /** Attention entries a session may keep before AMP prunes the coldest. */
  contextPruneMaxEntries: number
  /** Attention tokens a session may keep before AMP prunes the coldest. */
  contextPruneMaxTokens: number
  /** Candidates scoring below this are pruned; omit to disable score pruning. */
  contextPruneMinScore?: number
}

export const Config: Schema<Config> = Schema.object({
  tenantId: Schema.string().default('dsh-desktop'),
  rootId: Schema.string().default('desktop'),
  storage: Schema.union([Schema.const('workspace'), Schema.const('user')]).default('workspace'),
  storeDirectory: Schema.string().default('.deepseek-coordination'),
  storePath: Schema.string(),
  modules: Schema.array(Schema.string()),
  notifications: Schema.boolean().default(true),
  prompt: Schema.boolean().default(true),
  skills: Schema.boolean().default(true),
  commands: Schema.boolean().default(true),
  routes: Schema.boolean().default(true),
  maxJournal: Schema.number().default(500),
  maxReadChars: Schema.number().default(200_000),
  maxWriteChars: Schema.number().default(1_000_000),
  contextOptimization: Schema.boolean().default(true),
  contextBudgetTokens: Schema.number().default(1200),
  contextCacheEntries: Schema.number().default(128),
  contextCacheTokens: Schema.number().default(64_000),
  contextCacheTtlMs: Schema.number().default(300_000),
  contextPruneKeepRecent: Schema.number().default(24),
  contextPruneMaxEntries: Schema.number().default(200),
  contextPruneMaxTokens: Schema.number().default(20_000),
  contextPruneMinScore: Schema.number(),
})

/**
 * Plugin-owned bundled skills. The caller supplies the installed package's skills root.
 *
 * Descriptions are localized, never bilingual: each bundled skill carries one
 * English and one Chinese sentence, and the provider returns the one that
 * matches the host's current language at lookup time. The same rule governs the
 * `SKILL.md` frontmatter, which keeps the English sentence only — the provider
 * is the surface DSH renders, so it must be the surface that localizes.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normaliseLocale, type Locale } from '../shared/i18n.js'

/** One localized sentence pair for a bundled skill. */
export interface AmpSkillDescription {
  readonly en: string
  readonly zh: string
}

/** One bundled skill: name plus its two descriptions. */
export interface AmpBundledSkill {
  readonly name: string
  readonly description: AmpSkillDescription
}

interface AmpSkillSummary {
  readonly name: string
  readonly description: string
  readonly source: 'bundled'
  readonly provider: 'deepseek-coordination'
  readonly invocation: { readonly modelInvocable: true; readonly userInvocable: true }
  readonly path: string
  readonly resourceBase: { readonly kind: 'directory'; readonly path: string }
}
export interface AmpSkillDefinition extends AmpSkillSummary { readonly content: string }
export interface AmpSkillCandidate extends AmpSkillSummary {
  readonly rank: 600
  readonly locator: unknown
}
export interface AmpSkillLookupOptions {
  readonly signal?: AbortSignal | undefined
  readonly cwd?: string | undefined
  /** DSH passes the live agent (or a preset scope key) for the calling session. */
  readonly scope?: { readonly id?: string | undefined } | string | undefined
}
export interface AmpSkillProviderControl { readonly signal: AbortSignal; readonly invalidate: () => void }
/** Structural subset of DSH's provider contract, independent of its optional runtime package. */
export interface AmpSkillProvider {
  readonly name: string
  readonly list: (options: AmpSkillLookupOptions) => Promise<readonly AmpSkillCandidate[]>
  readonly get: (candidate: { readonly locator: unknown }, options: AmpSkillLookupOptions) => Promise<AmpSkillDefinition | undefined>
}
export interface AmpSkillRegistry {
  registerProvider(create: (control: AmpSkillProviderControl) => AmpSkillProvider): () => void
}

/**
 * One writable skill contributed by the control registry.
 *
 * This is the write-through half of the skill surface: an enabled registry
 * record carrying `content` is projected as a provider candidate, so DSH's
 * `sessionSkillCatalog` and the model-facing `skill` tool see it. The control
 * registry stays the authority; this type is only the projection.
 */
export interface AmpDynamicSkill {
  readonly name: string
  readonly description: string
  readonly content: string
  readonly whenToUse?: string
  readonly path?: string
  readonly modelInvocable?: boolean
  readonly userInvocable?: boolean
}

/** Produce the currently enabled control-registry skills for one lookup. */
export type AmpDynamicSkillSource = (options: AmpSkillLookupOptions) => readonly AmpDynamicSkill[]

/** Provider control exposed to the composition root so a write can refresh the catalog. */
export interface AmpSkillCatalogControl { readonly invalidate: () => void }

/** DSH's public kebab-case skill-name grammar. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** Writable registry skills sit above runtime (250) and below bundled (600). */
const REGISTRY_SKILL_RANK = 500

export const AMP_PLANNING_SKILLS: readonly AmpBundledSkill[] = Object.freeze([
  Object.freeze({
    name: 'amp-planning',
    description: Object.freeze({
      en: 'Coordinate observable AMP missions, goals and plans with the coordination tools.',
      zh: '使用协调工具管理可观察的 AMP 使命、目标与计划。',
    }),
  }),
  Object.freeze({
    name: 'amp-missions',
    description: Object.freeze({
      en: 'Queue, activate and settle session missions backed by AMP goals.',
      zh: '排队、激活并结算基于 AMP 目标的会话使命。',
    }),
  }),
  Object.freeze({
    name: 'amp-goals',
    description: Object.freeze({
      en: 'Create observable AMP goals and move their lifecycle using evidence.',
      zh: '创建可观察的 AMP 目标，并依据证据推进其生命周期。',
    }),
  }),
  Object.freeze({
    name: 'amp-plans',
    description: Object.freeze({
      en: 'Build bounded AMP task plans and track dependencies, execution and results.',
      zh: '编制有边界的 AMP 任务计划，并跟踪依赖、执行与结果。',
    }),
  }),
  Object.freeze({
    name: 'amp-collaboration',
    description: Object.freeze({
      en: 'Coordinate agents with explicit duties, accountable assignments and verified results.',
      zh: '用明确职责、可追责的指派与已验证的结果协调多个智能体。',
    }),
  }),
  Object.freeze({
    name: 'amp-duties',
    description: Object.freeze({
      en: 'Define scoped duties, assignees and observable acceptance criteria.',
      zh: '定义有边界的职责、受派会话与可观察的验收条件。',
    }),
  }),
  Object.freeze({
    name: 'amp-delegation',
    description: Object.freeze({
      en: 'Delegate execution through native agents and track the corresponding AMP assignment.',
      zh: '通过原生智能体委派执行，并跟踪对应的 AMP 指派记录。',
    }),
  }),
  Object.freeze({
    name: 'amp-handoffs',
    description: Object.freeze({
      en: 'Submit traceable results and verify or reject collaboration handoffs.',
      zh: '提交可追溯的结果，并验证或驳回协作交接。',
    }),
  }),
])

/** Pick the host-language sentence; an unknown tag falls back to English. */
function descriptionFor(skill: AmpBundledSkill, locale: Locale): string {
  return normaliseLocale(locale) === 'zh-CN' ? skill.description.zh : skill.description.en
}

/** Resolve the localizable locale once, with a safe default for tests. */
function localeOf(get: (() => Locale) | undefined): Locale {
  if (get === undefined) return 'en-US'
  try {
    return normaliseLocale(get())
  } catch {
    return 'en-US'
  }
}

/**
 * Register in the supplied plugin context's layer at standard bundled fallback
 * rank 600, plus the enabled control-registry skills supplied by `dynamic`.
 * The registry owns registration aborts, cache invalidation and the returned
 * exact Cordis disposer. Read bodies on demand; catalog data is immutable.
 *
 * `locale` is read on every `list`/`get`, so a host language change only needs
 * `control.invalidate()` to publish the other descriptions — the provider does
 * not bake a language at registration time. `dynamic` is read the same way, so
 * the composition root can point it at the writable control registry without
 * re-registering the provider.
 */
export function registerAmpPlanningSkills(
  registry: AmpSkillRegistry | undefined,
  skillRoot: string,
  dynamic?: AmpDynamicSkillSource,
  onActivate?: (control: AmpSkillCatalogControl) => void,
  locale?: () => Locale,
): () => void {
  if (registry === undefined) return () => {}
  return registry.registerProvider(control => {
    /** Stable locator identity per bundled skill (never accepted from a caller). */
    const bundledLocators = Object.freeze(
      AMP_PLANNING_SKILLS.map(skill => Object.freeze({ path: join(skillRoot, skill.name, 'SKILL.md') })),
    )
    /** Bundled candidates for the language in effect when the caller asks. */
    const bundledCandidates = (): readonly AmpSkillCandidate[] => {
      const current = localeOf(locale)
      return Object.freeze(AMP_PLANNING_SKILLS.map((skill, index) => {
        const directory = join(skillRoot, skill.name)
        const path = join(directory, 'SKILL.md')
        return Object.freeze({
          name: skill.name,
          description: descriptionFor(skill, current),
          path,
          rank: 600 as const,
          locator: bundledLocators[index]!,
          source: 'bundled' as const,
          provider: 'deepseek-coordination' as const,
          invocation: Object.freeze({ modelInvocable: true as const, userInvocable: true as const }),
          resourceBase: Object.freeze({ kind: 'directory' as const, path: directory }),
        })
      }))
    }
    /**
     * Locators are stable object identities, one per bundled skill. A caller
     * that hands back a fresh `{ path }` object is not selecting a bundled file.
     */
    const bundledByLocator = new Map<unknown, AmpBundledSkill>(
      bundledLocators.map((locator, index) => [locator, AMP_PLANNING_SKILLS[index]!]),
    )
    const check = (options: AmpSkillLookupOptions): void => {
      control.signal.throwIfAborted()
      options.signal?.throwIfAborted()
    }
    /**
     * Registry records are structurally provider candidates but are not bundled
     * files: `source` is the registry and `path` may be absent. DSH validates the
     * runtime object against its own candidate grammar, so this projection is
     * narrowed back to the bundled-shaped public type after construction.
     */
    const dynamicCandidate = (skill: AmpDynamicSkill): AmpSkillCandidate => ({
      name: skill.name,
      description: skill.description,
      source: 'control registry' as unknown as 'bundled',
      provider: 'deepseek-coordination',
      invocation: {
        modelInvocable: skill.modelInvocable !== false,
        userInvocable: skill.userInvocable !== false,
      } as unknown as { readonly modelInvocable: true; readonly userInvocable: true },
      ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
      ...(skill.path === undefined ? {} : { path: skill.path }),
      rank: REGISTRY_SKILL_RANK,
      locator: Object.freeze({ kind: 'control-skill' as const, ...skill }),
    } as unknown as AmpSkillCandidate)
    const dynamicCandidates = (
      options: AmpSkillLookupOptions,
      bundledNames: ReadonlySet<string>,
    ): readonly AmpSkillCandidate[] => {
      if (dynamic === undefined) return []
      let skills: readonly AmpDynamicSkill[]
      try {
        skills = dynamic(options)
      } catch {
        return []
      }
      const seen = new Set(bundledNames)
      const result: AmpSkillCandidate[] = []
      for (const skill of skills) {
        if (!SKILL_NAME.test(skill.name) || skill.description.length === 0 || skill.content.length === 0) continue
        if (seen.has(skill.name)) continue
        seen.add(skill.name)
        result.push(dynamicCandidate(skill))
      }
      return result
    }
    /** A locator carries the full definition, so `get` needs no second registry read. */
    const dynamicDefinition = (locator: unknown): AmpSkillDefinition | undefined => {
      if (typeof locator !== 'object' || locator === null || Array.isArray(locator)) return undefined
      const record = locator as Record<string, unknown>
      if (record.kind !== 'control-skill') return undefined
      const { name, description, content } = record
      if (typeof name !== 'string' || !SKILL_NAME.test(name)) return undefined
      if (typeof description !== 'string' || description.length === 0) return undefined
      if (typeof content !== 'string' || content.length === 0) return undefined
      return {
        name,
        description,
        content,
        source: 'control registry',
        provider: 'deepseek-coordination',
        invocation: {
          modelInvocable: record.modelInvocable !== false,
          userInvocable: record.userInvocable !== false,
        },
        ...(typeof record.whenToUse === 'string' ? { whenToUse: record.whenToUse } : {}),
        ...(typeof record.path === 'string' && record.path.length > 0 ? { path: record.path } : {}),
      } as unknown as AmpSkillDefinition
    }
    onActivate?.({ invalidate: () => { control.invalidate() } })
    return {
      name: 'deepseek-coordination',
      async list(options) {
        check(options)
        const candidates = bundledCandidates()
        const extra = dynamicCandidates(options, new Set(candidates.map((candidate) => candidate.name)))
        // Keep the frozen bundled array when no writable skill is present; the
        // catalog contract marks the immutable provider result as frozen.
        return extra.length === 0 ? candidates : [...candidates, ...extra]
      },
      async get(candidate, options) {
        check(options)
        const own = bundledByLocator.get(candidate.locator)
        if (own !== undefined) {
          const path = join(skillRoot, own.name, 'SKILL.md')
          const signal = options.signal === undefined ? control.signal : AbortSignal.any([control.signal, options.signal])
          const raw = (await readFile(path, { encoding: 'utf8', signal })).replace(/^\uFEFF/, '')
          check(options)
          const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(raw)
          const content = (frontmatter === null ? raw : raw.slice(frontmatter[0].length)).trim()
          if (content.length === 0) throw new Error(`Bundled skill ${own.name} has no instruction body`)
          return {
            name: own.name,
            description: descriptionFor(own, localeOf(locale)),
            source: 'bundled',
            provider: 'deepseek-coordination',
            invocation: { modelInvocable: true, userInvocable: true },
            path,
            resourceBase: { kind: 'directory', path: join(skillRoot, own.name) },
            content,
          }
        }
        return dynamicDefinition(candidate.locator)
      },
    }
  })
}

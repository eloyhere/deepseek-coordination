/**
 * Settings-catalog audit (v24 §19).
 *
 * The page renders whatever `SETTINGS_CONTROLS` says, so these tests guard the
 * catalog itself instead of the DOM:
 *
 *  - every leaf of the real resolved config has exactly one control, and no
 *    control id or config key appears twice;
 *  - the catalog's type/range/step metadata agrees with the Schemastery schema
 *    that `resolveConfig()` enforces, so the UI can never offer a value the
 *    host would refuse (or hide one it would accept);
 *  - all six scenes are covered, with one shared row per field whose six
 *    defaults are identical (`allowWeb`, `scoreThreshold`);
 *  - forced / structural / alias / planned rows are not writable;
 *  - `applyConfigPatch` rejects unknown keys, `databasePath`, wrong types and
 *    out-of-range values, and applies a valid patch live with every resolver
 *    invariant (weight normalisation, alias mirroring, compaction clamping);
 *  - both locales carry copy for every row and group.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, resolveConfig } from '../src/host/config.js'
import type { CoordinationConfig } from '../src/host/config.js'
import { applyConfigPatch, buildConfigView, defaultConfigValues } from '../src/host/selection.js'
import {
  EDITABLE_CONFIG_KEYS,
  PLAN_DIMENSIONS,
  SETTINGS_CATALOG_GROUPS,
  SETTINGS_CATALOG_FIELD_IDS,
  SETTINGS_CONTROL_CHIPS,
  SETTINGS_CONTROLS,
  SETTINGS_CONTROLS_BY_KEY,
  isEditableControl,
  readConfigPath,
  settingsControlsOf,
  settingsSceneControls,
  settingsSharedSceneControls,
} from '../src/shared/selection.js'
import type { ConfigScalar, SettingsControl } from '../src/shared/selection.js'
import { formatConfigNumber, stepDecimals } from '../src/shared/selection.js'
import { COPY_BY_LOCALE, LOCALES, settingsControlCopy } from '../src/shared/i18n.js'
import { SceneValues } from '../src/shared/enum.js'
import { InvalidArgumentError } from '../src/shared/error.js'
import { testConfig } from './helpers.js'

/* ------------------------------------------------------------------------- *
 * Helpers
 * ------------------------------------------------------------------------- */

/** Every dotted leaf path of a plain config value tree. */
function leafPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return prefix === '' ? [] : [prefix]
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
    leafPaths(entry, prefix === '' ? key : `${prefix}.${key}`),
  )
}

/** The `database` / `databasePath` leaves are the deliberate non-exposure. */
const REDACTED_LEAVES = new Set(['database', 'databasePath'])

/**
 * Config leaves the page deliberately does not expose.
 *
 * The host's main page owns the model's reasoning controls (thinking switch and
 * effort level), so duplicating them here would be two sources of truth. The
 * keys stay in the schema — the turn pipeline still reads the scene defaults —
 * they simply have no row.
 */
const UNEXPOSED_LEAVES = new Set(
  SceneValues.flatMap((scene) => [`scenes.${scene}.thinking`, `scenes.${scene}.reasoningEffort`]),
)

/** The schema's own metadata for one leaf, read from the real `Config`. */
interface SchemaLeaf {
  type: string
  min?: number
  max?: number
  step?: number
  defaultValue?: unknown
  options?: readonly unknown[]
}

interface RawSchema {
  type: string
  meta?: Record<string, unknown>
  dict?: Record<string, RawSchema>
  list?: readonly unknown[]
}

function schemaLeaves(node: RawSchema, prefix = '', out = new Map<string, SchemaLeaf>()): Map<string, SchemaLeaf> {
  if (node.dict !== undefined) {
    for (const [key, entry] of Object.entries(node.dict)) {
      schemaLeaves(entry, prefix === '' ? key : `${prefix}.${key}`, out)
    }
    return out
  }
  const meta = node.meta ?? {}
  // A `Schema.union` list holds `Schema.const` members, whose `.value` is the
  // allowed literal; anything else is already a plain value.
  const options = Array.isArray(node.list)
    ? node.list.map((entry) => {
      // Union members are `Schema.const` callables; the literal is `.value`.
      if ((typeof entry === 'object' || typeof entry === 'function') && entry !== null && 'value' in entry) {
        return (entry as { value: unknown }).value
      }
      return entry
    })
    : undefined
  out.set(prefix, {
    type: node.type,
    ...(typeof meta.min === 'number' ? { min: meta.min } : {}),
    ...(typeof meta.max === 'number' ? { max: meta.max } : {}),
    ...(typeof meta.step === 'number' ? { step: meta.step } : {}),
    ...('default' in meta ? { defaultValue: meta.default } : {}),
    ...(options === undefined ? {} : { options }),
  })
  return out
}

const schema = Config as unknown as RawSchema
const SCHEMA_LEAVES = schemaLeaves(schema)

/** A mutable copy of the schema defaults, as the route would build one. */
function freshConfig(overrides: Partial<CoordinationConfig> = {}): CoordinationConfig {
  const base = resolveConfig(undefined)
  return resolveConfig({ ...base, ...overrides })
}

function keysOf(control: SettingsControl): string[] {
  return [...control.keys]
}

/** Round every number so resolver float noise cannot fail a deepEqual. */
function roundNumbers(value: unknown): unknown {
  if (typeof value === 'number') return Number(value.toFixed(9))
  if (Array.isArray(value)) return value.map(roundNumbers)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, roundNumbers(entry)]))
  }
  return value
}

/* ------------------------------------------------------------------------- *
 * Catalog coverage
 * ------------------------------------------------------------------------- */

test('every config leaf has exactly one control and no key or id repeats', () => {
  const leaves = leafPaths(resolveConfig(undefined)).filter((path) => !REDACTED_LEAVES.has(path))
  // 155 leaves: 150 scalar keys plus 5 `defaults` entries... counted explicitly
  // below so a new config group cannot slip in without a row.
  assert.ok(leaves.length >= 150, `expected the full config surface, got ${leaves.length} leaves`)

  const seenKeys = new Map<string, string>()
  const seenIds = new Set<string>()
  for (const control of SETTINGS_CONTROLS) {
    assert.match(control.id, /^setting:/, `control id ${control.id} must be namespaced`)
    assert.equal(seenIds.has(control.id), false, `duplicate control id: ${control.id}`)
    seenIds.add(control.id)
    for (const key of keysOf(control)) {
      assert.equal(seenKeys.has(key), false, `duplicate config key ${key} (${seenKeys.get(key)} / ${control.id})`)
      seenKeys.set(key, control.id)
    }
  }

  const missing = leaves.filter((leaf) => !seenKeys.has(leaf) && !UNEXPOSED_LEAVES.has(leaf))
  assert.deepEqual(missing, [], 'every config leaf needs a control or an explicit exemption')
  const extra = [...seenKeys.keys()].filter((key) => !leaves.includes(key))
  assert.deepEqual(extra, [], 'the catalog must not invent a config key')
  for (const exempt of UNEXPOSED_LEAVES) {
    assert.ok(leaves.includes(exempt), `${exempt} must still exist in the config schema`)
    assert.equal(seenKeys.has(exempt), false, `${exempt} must stay unexposed`)
  }
  assert.equal(seenKeys.size, leaves.length - UNEXPOSED_LEAVES.size)
})

test('the shared test fixture mirrors the real schema defaults', () => {
  // `test/helpers.ts` writes the resolved defaults out as a literal so no test
  // has to load Schemastery; keep that literal honest against the real schema.
  assert.deepEqual(roundNumbers(testConfig()), roundNumbers(resolveConfig(undefined)))
})

test('the catalog excludes only the deployment secret leaves', () => {
  const leaves = leafPaths(resolveConfig(undefined))
  for (const redacted of REDACTED_LEAVES) {
    assert.ok(leaves.includes(redacted), `${redacted} is expected in the config`)
    assert.equal(SETTINGS_CONTROLS_BY_KEY.has(redacted), false, `${redacted} must not have a control`)
  }
})

test('all six scenes are covered, with shared rows only where defaults agree', () => {
  const seen = new Set<string>()
  for (const scene of SceneValues) {
    const rows = settingsSceneControls(scene)
    assert.equal(rows.length, 9, `${scene} must expose the nine differing fields`)
    for (const row of rows) {
      assert.equal(row.scene, scene)
      assert.equal(row.keys.length, 1)
      assert.match(row.keys[0] as string, new RegExp(`^scenes\\.${scene}\\.`))
      assert.equal(seen.has(row.keys[0] as string), false, `duplicate scene key ${row.keys[0]}`)
      seen.add(row.keys[0] as string)
    }
    const fields = rows.map((row) => (row.keys[0] as string).split('.').pop())
    assert.deepEqual(
      [...fields].sort(),
      [
        'allowBash',
        'maxIteration',
        'requireCitation',
        'requireOutline',
        'requirePlan',
        'requirePredict',
        'requireRevision',
        'requireScore',
        'sandboxOnly',
      ].sort(),
      `${scene}: field coverage`,
    )
  }

  const shared = settingsSharedSceneControls()
  assert.deepEqual(shared.map((row) => row.id).sort(), [
    'setting:scene.all.allowWeb',
    'setting:scene.all.scoreThreshold',
  ])
  for (const row of shared) {
    assert.equal(row.keys.length, 6, `${row.id} must write all six scenes`)
    const defaults = row.keys.map((key) => readConfigPath(resolveConfig(undefined), key))
    assert.deepEqual(new Set(defaults).size, 1, `${row.id} is only shared when the six defaults agree`)
  }
  assert.equal(seen.size + 12, 66, 'six scenes x nine fields plus two shared rows')
})

test('numeric rows declare min/max/step; the schema agrees', () => {
  for (const control of SETTINGS_CONTROLS) {
    if (control.kind !== 'number') continue
    assert.equal(typeof control.min, 'number', `${control.id} needs min`)
    assert.equal(typeof control.max, 'number', `${control.id} needs max`)
    assert.equal(typeof control.step, 'number', `${control.id} needs step`)
    assert.ok((control.min as number) < (control.max as number), `${control.id}: min < max`)
    assert.ok((control.step as number) > 0, `${control.id}: step > 0`)
  }

  // Every single-key numeric row mirrors the real schema bounds.
  for (const control of SETTINGS_CONTROLS) {
    if (control.keys.length !== 1 || control.kind !== 'number') continue
    const leaf = SCHEMA_LEAVES.get(control.keys[0] as string)
    assert.ok(leaf !== undefined, `${control.id}: schema leaf ${control.keys[0]}`)
    assert.equal(leaf.type, 'number', `${control.id}: schema type`)
    if (leaf.min !== undefined) assert.equal(control.min, leaf.min, `${control.id}: min`)
    if (leaf.max !== undefined) assert.equal(control.max, leaf.max, `${control.id}: max`)
    if (leaf.step !== undefined) assert.equal(control.step, leaf.step, `${control.id}: step`)
  }
})

test('boolean/enum/text rows match the schema shape', () => {
  for (const control of SETTINGS_CONTROLS) {
    if (control.keys.length !== 1) continue
    const leaf = SCHEMA_LEAVES.get(control.keys[0] as string)
    assert.ok(leaf !== undefined, `${control.id}: schema leaf ${control.keys[0]}`)
    if (control.kind === 'boolean') assert.equal(leaf.type, 'boolean', `${control.id}: schema type`)
    if (control.kind === 'text') assert.equal(leaf.type, 'string', `${control.id}: schema type`)
    if (control.kind === 'enum') {
      assert.ok(leaf.type === 'union' || leaf.type === 'string', `${control.id}: schema type ${leaf.type}`)
      if (leaf.options !== undefined) {
        assert.deepEqual([...(control.options ?? [])].sort(), [...leaf.options].sort(), `${control.id}: options`)
      }
    }
  }
})

test('forced, structural, alias and planned rows are never writable', () => {
  const forced = [
    'profession.lock',
    'profession.enabled',
    'profession.rebuildCanReselect',
    'profession.abandonCanReselect',
  ]
  for (const key of forced) {
    const control = SETTINGS_CONTROLS_BY_KEY.get(key)
    assert.ok(control !== undefined, `${key} needs a row`)
    assert.equal(control.chip, 'forced', `${key}: chip`)
    assert.equal(control.keys.length, 1)
    assert.equal(isEditableControl(control), false, `${key} must be read-only`)
    assert.equal(EDITABLE_CONFIG_KEYS.has(key), false, `${key} must not be in the patch whitelist`)
  }

  for (const key of [
    'profession.default',
    'compaction.reserve',
    'compaction.recentTurns',
    'compaction.cooldown',
    'compaction.maxPerSession',
    'ui.locale',
    'ui.toolbar',
  ]) {
    const control = SETTINGS_CONTROLS_BY_KEY.get(key)
    assert.ok(control !== undefined, `${key} needs a row`)
    assert.equal(isEditableControl(control), false, `${key} must be read-only`)
  }

  // The file-tool runtime reads these twelve keys; they are writable host rows.
  for (const key of [
    'parser.enabled',
    'parser.maxFileBytes',
    'parser.maxTokens',
    'parser.timeoutMs',
    'parser.cacheCapacity',
    'parser.maxAstDepth',
    'parser.dependencyGraphMaxVertices',
    'parser.dependencyGraphMaxEdges',
    'chain.depth',
    'chain.links',
    'chain.tokenBudget',
    'tools.maxResultBytes',
  ]) {
    const control = SETTINGS_CONTROLS_BY_KEY.get(key)
    assert.ok(control !== undefined, `${key} needs a row`)
    assert.equal(control.chip, 'host', `${key}: wired host row`)
    assert.equal(control.wired, true, `${key}: wired`)
    assert.equal(isEditableControl(control), true, `${key}: editable`)
    assert.equal(EDITABLE_CONFIG_KEYS.has(key), true, `${key}: whitelist`)
  }

  // Every editable row is a host row with at least one key, and vice versa.
  for (const control of SETTINGS_CONTROLS) {
    const editable = control.chip === 'host' && control.keys.length > 0
    assert.equal(isEditableControl(control), editable, `${control.id}: editable flag`)
    if (editable) {
      for (const key of control.keys) assert.ok(EDITABLE_CONFIG_KEYS.has(key), `${key}: whitelist`)
    }
  }
})

/* ------------------------------------------------------------------------- *
 * Patch contract
 * ------------------------------------------------------------------------- */

function patchOf(patch: Record<string, ConfigScalar>): void {
  applyConfigPatch(freshConfig(), patch)
}

test('the patch rejects unknown keys and the deployment secret', () => {
  assert.throws(() => patchOf({ 'nope.key': 1 }), (error: unknown) =>
    error instanceof InvalidArgumentError && /unknown config key/.test(error.message))
  assert.throws(() => patchOf({ databasePath: 'C:\\secret.db' }), (error: unknown) =>
    error instanceof InvalidArgumentError && /not writable/.test(error.message))
  assert.throws(() => patchOf({ database: 'other' }), (error: unknown) =>
    error instanceof InvalidArgumentError && /not writable/.test(error.message))
})

test('the patch rejects wrong types and out-of-range values', () => {
  const bad: Array<[string, unknown]> = [
    ['plan.threshold', 2],
    ['plan.threshold', -0.1],
    ['plan.threshold', '0.5'],
    ['plan.threshold', Number.NaN],
    ['plan.maxRebuild', -1],
    ['plan.weights.alignment', 1.5],
    ['bayesian.prior', 1.2],
    ['scenes.writing.requirePlan', 'maybe'],
    ['defaults.profession', 'wizard'],
    ['cache.ttl', -1],
  ]
  for (const [key, value] of bad) {
    assert.throws(
      () => patchOf({ [key]: value as ConfigScalar }),
      (error: unknown) => error instanceof InvalidArgumentError,
      `${key}=${String(value)} must be refused`,
    )
  }
})

test('a valid patch applies live and the projection round-trips', () => {
  const config = freshConfig()
  const before = buildConfigView(config)
  assert.deepEqual(roundNumbers(before.values), roundNumbers(defaultConfigValues()))

  const outcome = applyConfigPatch(config, {
    'plan.threshold': 0.7,
    'plan.weights.alignment': 0.9,
    'defaults.profession': 'decision',
    'scenes.research.maxIteration': 5,
    'orchestration.maxReject': 4,
    'compaction.soft': 0.8,
    'parser.maxTokens': 1000,
    'chain.depth': 4,
  })

  assert.deepEqual([...outcome.applied].sort(), [
    'chain.depth',
    'compaction.soft',
    'defaults.profession',
    'orchestration.maxReject',
    'parser.maxTokens',
    'plan.threshold',
    'plan.weights.alignment',
    'scenes.research.maxIteration',
  ])
  assert.deepEqual(outcome.ignored, [])
  assert.deepEqual(outcome.normalised, ['plan.weights.alignment'])
  assert.notEqual(outcome.compaction, null)

  const after = buildConfigView(config)
  assert.equal(after.values.plan.threshold, 0.7)
  assert.equal(after.values.orchestration.maxReject, 4)
  assert.equal(after.values.parser.maxTokens, 1000)
  assert.equal(after.values.chain.depth, 4)
  assert.equal(after.values.scenes.research.maxIteration, 5)
  assert.equal(after.values.scenes.dialogue.maxIteration, 1, 'other scenes keep their value')
  // Weights are normalised to exactly 1 by the resolver, and the view shows it.
  const weights = Object.values(after.values.plan.weights)
  assert.ok(Math.abs(weights.reduce((sum, weight) => sum + weight, 0) - 1) < 1e-9)
  assert.ok(after.values.plan.weights.alignment > 0.2)
  // `defaults.profession` is authoritative; the alias mirrors it.
  assert.equal(after.values.defaults.profession, 'decision')
  assert.equal(after.values.profession.default, 'decision')
  // Compaction is clamped and mirrored in the live config.
  assert.equal(after.values.compaction.soft, 0.8)
  assert.ok(after.values.compaction.hard >= 0.81)
  assert.deepEqual(config.compaction, after.values.compaction)
  // The projection never leaks the database or a credential-shaped field.
  const wire = JSON.stringify(after)
  assert.equal(wire.includes('databasePath'), false)
  assert.equal(wire.includes('coordination.db'), false)
})

test('known but non-editable rows are reported as ignored, never written', () => {
  const config = freshConfig()
  const outcome = applyConfigPatch(config, {
    'profession.lock': false,
    'profession.default': 'decision',
    'compaction.reserve': 4096,
    'ui.toolbar': false,
  })
  assert.deepEqual(outcome.applied, [])
  assert.deepEqual([...outcome.ignored].sort(), [
    'compaction.reserve',
    'profession.default',
    'profession.lock',
    'ui.toolbar',
  ])
  assert.equal(config.profession.lock, true, 'the forced lock stays on')
  assert.equal(config.compaction.reserve, 2048)
})

test('forced flags survive every patch and the resolver keeps the alias mirrored', () => {
  const config = freshConfig()
  applyConfigPatch(config, { 'defaults.profession': 'outcome' })
  applyConfigPatch(config, { 'defaults.profession': 'resource' })
  assert.equal(config.profession.lock, true)
  assert.equal(config.profession.enabled, true)
  assert.equal(config.profession.rebuildCanReselect, true)
  assert.equal(config.profession.abandonCanReselect, true)
  assert.equal(config.profession.default, 'resource')
  assert.equal(buildConfigView(config).values.profession.default, 'resource')
})

test('the editable whitelist is exactly the keys of host rows', () => {
  const expected = new Set(
    SETTINGS_CONTROLS.filter((control) => isEditableControl(control)).flatMap((control) => [...control.keys]),
  )
  assert.deepEqual([...EDITABLE_CONFIG_KEYS].sort(), [...expected].sort())
  assert.equal(EDITABLE_CONFIG_KEYS.has('databasePath'), false)
  assert.ok(EDITABLE_CONFIG_KEYS.size > 100)
})

/* ------------------------------------------------------------------------- *
 * Copy coverage
 * ------------------------------------------------------------------------- */

test('every row and group has balanced zh/en copy', () => {
  assert.deepEqual([...SETTINGS_CATALOG_GROUPS], [
    'session',
    'profession',
    'scenes',
    'plan',
    'orchestration',
    'cache',
    'bayesian',
    'comprehension',
    'compaction',
    'ui',
    'parser',
    'chain',
    'tools',
  ])
  for (const locale of LOCALES) {
    const settings = COPY_BY_LOCALE[locale].settings
    assert.deepEqual(Object.keys(settings.catalog.groups), [...SETTINGS_CATALOG_GROUPS], `${locale}: groups`)
    assert.deepEqual(
      Object.keys(settings.catalog.fields).sort(),
      [...SETTINGS_CATALOG_FIELD_IDS].sort(),
      `${locale}: catalog field ids`,
    )
    for (const control of SETTINGS_CONTROLS) {
      const copy = settingsControlCopy(settings, control.copy)
      assert.ok(copy !== undefined, `${locale}:${control.id} has no copy for "${control.copy}"`)
      assert.ok((copy?.label ?? '').trim().length > 0, `${locale}:${control.id} label`)
      assert.ok((copy?.hint ?? '').trim().length > 0, `${locale}:${control.id} hint`)
    }
    for (const chip of SETTINGS_CONTROL_CHIPS) {
      assert.ok(settings.catalog.values.chips[chip].trim().length > 0, `${locale}: chip ${chip}`)
    }
  }
  // The catalog copy ids and the catalog rows must not drift apart.
  const used = new Set(
    SETTINGS_CONTROLS
      .map((control) => control.copy)
      .filter((copy) => (SETTINGS_CATALOG_FIELD_IDS as readonly string[]).includes(copy)),
  )
  for (const id of SETTINGS_CATALOG_FIELD_IDS) {
    assert.ok(used.has(id), `catalog copy id "${id}" is not used by any row`)
  }
})

test('Plan carries all eight weights and dimensions exactly once', () => {
  const planRows = settingsControlsOf('plan')
  const weighted = planRows.filter((row) => row.keys[0]?.startsWith('plan.weights.'))
  const dimensioned = planRows.filter((row) => row.keys[0]?.startsWith('plan.dimensions.'))
  assert.deepEqual(weighted.length, PLAN_DIMENSIONS.length)
  assert.deepEqual(dimensioned.length, PLAN_DIMENSIONS.length)
  for (const dimension of PLAN_DIMENSIONS) {
    assert.ok(weighted.some((row) => row.keys[0] === `plan.weights.${dimension}`), dimension)
    assert.ok(dimensioned.some((row) => row.keys[0] === `plan.dimensions.${dimension}`), dimension)
  }
})

/* ------------------------------------------------------------------------- *
 * Display rounding
 * ------------------------------------------------------------------------- */

test('a step implies its decimal places, and only those', () => {
  assert.equal(stepDecimals(0.01), 2)
  assert.equal(stepDecimals(0.001), 3)
  assert.equal(stepDecimals(0.1), 1)
  assert.equal(stepDecimals(1), 0)
  assert.equal(stepDecimals(512), 0)
  assert.equal(stepDecimals(0.05), 2)
  assert.equal(stepDecimals(undefined), 0)
  assert.equal(stepDecimals(0), 0)
  assert.equal(stepDecimals(Number.NaN), 0)
})

test('renormalised weights display without float noise', () => {
  // Exactly the values the resolver produces for the shipped defaults.
  assert.equal(formatConfigNumber(0.15000000000000002, 0.01), '0.15')
  assert.equal(formatConfigNumber(0.09999999999999999, 0.01), '0.1')
  assert.equal(formatConfigNumber(0.19999999999999998, 0.01), '0.2')
  // A whole value keeps no trailing zeros.
  assert.equal(formatConfigNumber(0.5, 0.01), '0.5')
  assert.equal(formatConfigNumber(0.7, 0.01), '0.7')
  // Integer rows are untouched.
  assert.equal(formatConfigNumber(32, 1), '32')
  assert.equal(formatConfigNumber(2048, 512), '2048')
  assert.equal(formatConfigNumber(60000, 1000), '60000')
  // Non-finite values pass through instead of inventing a number.
  assert.equal(formatConfigNumber(Number.NaN, 0.01), 'NaN')
  assert.equal(formatConfigNumber(Number.POSITIVE_INFINITY, 1), 'Infinity')
})

test('every numeric row rounds to at most its declared precision', () => {
  for (const control of SETTINGS_CONTROLS) {
    if (control.kind !== 'number') continue
    const printed = formatConfigNumber(1 / 3, control.step)
    const decimals = printed.includes('.') ? printed.split('.')[1]?.length ?? 0 : 0
    assert.ok(decimals <= stepDecimals(control.step), `${control.id} printed ${printed}`)
    assert.equal(Number(printed), Number((1 / 3).toFixed(stepDecimals(control.step))))
  }
})

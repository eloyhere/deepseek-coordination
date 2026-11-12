/** Pure pricing primitives that do not load the static model registry. */

export interface ModelSelection {
  readonly provider: string
  readonly model: string
}

export type PricingMethod = 'deepseek-peak' | 'registry' | 'none'
export type PricingWindow = 'peak' | 'off-peak' | 'flat'

export interface PricingTier {
  readonly above: number
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export interface ModelPricing {
  readonly priced: boolean
  readonly provider: string
  readonly model: string
  readonly name: string
  readonly method: PricingMethod
  readonly currency: 'CNY' | 'USD'
  readonly window: PricingWindow
  readonly inputMissPerMillion: number
  readonly inputHitPerMillion: number
  readonly outputPerMillion: number
  readonly cacheDiscount: boolean
  readonly tiers: readonly PricingTier[]
  readonly source: string
}

interface Tariff {
  readonly inputMiss: number
  readonly inputHit: number
  readonly output: number
}

interface DeepSeekTariff {
  readonly peak: Tariff
  readonly offPeak: Tariff
}

export const DEEPSEEK_SOURCE = 'DeepSeek API 价格页（2026-11，百万 tokens）'

const DEEPSEEK_TARIFFS: Readonly<Record<string, DeepSeekTariff>> = {
  'deepseek-flash': {
    peak: { inputMiss: 2, inputHit: 0.04, output: 8 },
    offPeak: { inputMiss: 1, inputHit: 0.02, output: 4 },
  },
  'deepseek-v4-flash': {
    peak: { inputMiss: 2, inputHit: 0.04, output: 8 },
    offPeak: { inputMiss: 1, inputHit: 0.02, output: 4 },
  },
  'deepseek-v4-pro': {
    peak: { inputMiss: 9, inputHit: 0.3, output: 27 },
    offPeak: { inputMiss: 4.5, inputHit: 0.15, output: 13.5 },
  },
}

/** Coerce an unknown provider/model pair into a selection. */
export function parseSelection(value: unknown): ModelSelection | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { provider?: unknown; model?: unknown }
  if (typeof record.provider !== 'string' || record.provider.length === 0) return undefined
  if (typeof record.model !== 'string' || record.model.length === 0) return undefined
  return { provider: record.provider, model: record.model }
}

/** Beijing weekday and hour, without a holiday calendar. */
function beijingClock(now: Date): { weekday: string; hour: number } {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      weekday: 'short',
      hour: '2-digit',
      hourCycle: 'h23',
    })
    const parts = formatter.formatToParts(now)
    const weekday = parts.find((part) => part.type === 'weekday')?.value ?? ''
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0')
    return { weekday, hour: Number.isFinite(hour) ? hour : 0 }
  } catch {
    return { weekday: '', hour: 0 }
  }
}

/** Published DeepSeek peak window: Mon-Fri, 09-12 and 14-18 Beijing time. */
export function isDeepSeekPeak(now: Date): boolean {
  const { weekday, hour } = beijingClock(now)
  const weekdayIndex = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday)
  return weekdayIndex && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))
}

/** DeepSeek official CNY tariff, or undefined for any other route/model. */
export function deepSeekPricing(selection: ModelSelection | undefined, now: Date = new Date()): ModelPricing | undefined {
  const provider = selection?.provider ?? ''
  const model = selection?.model ?? ''
  const normalizedProvider = provider.toLowerCase()
  const normalizedModel = model.toLowerCase()
  const isOfficialDeepSeek = normalizedProvider === 'deepseek-official' || normalizedProvider === 'deepseek'
  const tariff = DEEPSEEK_TARIFFS[normalizedModel]
  if (!isOfficialDeepSeek || tariff === undefined) return undefined
  const peak = isDeepSeekPeak(now)
  const rates = peak ? tariff.peak : tariff.offPeak
  return {
    priced: true,
    provider,
    model,
    name: model,
    method: 'deepseek-peak',
    currency: 'CNY',
    window: peak ? 'peak' : 'off-peak',
    inputMissPerMillion: rates.inputMiss,
    inputHitPerMillion: rates.inputHit,
    outputPerMillion: rates.output,
    cacheDiscount: true,
    tiers: [],
    source: DEEPSEEK_SOURCE,
  }
}

/** Explicit unpriced result; the UI must never borrow another model's rate. */
export function unpricedPricing(selection: ModelSelection | undefined, source: string): ModelPricing {
  return {
    priced: false,
    provider: selection?.provider ?? '',
    model: selection?.model ?? '',
    name: selection?.model ?? '',
    method: 'none',
    currency: 'USD',
    window: 'flat',
    inputMissPerMillion: 0,
    inputHitPerMillion: 0,
    outputPerMillion: 0,
    cacheDiscount: false,
    tiers: [],
    source,
  }
}

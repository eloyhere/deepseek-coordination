/**
 * Resolve a host-selected provider/model against the static price registry.
 *
 * The DeepSeek official route keeps its published CNY peak/off-peak page
 * price. Every other route is looked up in the generated registry (pi-ai 1.3.0
 * plus OpenRouter's 2026-11-12 catalog). A missing or subscription-only entry
 * is explicitly unpriced; the estimate never borrows another model's rate.
 */

import { lookupRegistryModel } from './registry.js'
import {
  deepSeekPricing,
  isDeepSeekPeak,
  parseSelection,
  unpricedPricing,
  type ModelPricing,
  type ModelSelection,
  type PricingMethod,
  type PricingTier,
  type PricingWindow,
} from './pricingCore.js'

export { isDeepSeekPeak, parseSelection }
export type { ModelPricing, ModelSelection, PricingMethod, PricingTier, PricingWindow }

/**
 * Resolve the active model selection against the static registry.
 *
 * @param selection - provider/model reported by DSH, or undefined before the
 * first request.
 * @param now - clock used for the DeepSeek peak window; injectable for tests.
 * @returns a tariff, or an explicit unpriced result.
 */
export function resolvePricing(selection: ModelSelection | undefined, now: Date = new Date()): ModelPricing {
  const official = deepSeekPricing(selection, now)
  if (official !== undefined) return official

  const provider = selection?.provider ?? ''
  const model = selection?.model ?? ''
  const entry = lookupRegistryModel(provider, model)
  if (entry === undefined) {
    return unpricedPricing(selection, `未在注册中心找到 ${provider || '?'} / ${model || '?'}`)
  }

  if (entry.input <= 0 && entry.output <= 0) {
    return unpricedPricing(selection, `${entry.name} · 订阅/额度计划，无按量 token 价格`)
  }

  return {
    priced: true,
    provider,
    model,
    name: entry.name,
    method: 'registry',
    currency: 'USD',
    window: 'flat',
    inputMissPerMillion: entry.input,
    inputHitPerMillion: entry.cacheRead,
    outputPerMillion: entry.output,
    cacheDiscount: entry.cacheRead > 0,
    tiers: entry.tiers,
    source: entry.source,
  }
}

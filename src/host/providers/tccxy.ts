/** This relay's Codex compatibility requirement, isolated from other API addresses. */
import type { ProviderOptimizationRegistry } from './registry.js'
export const TCCXY_API_BASE = 'https://api.tccxy.top/v1'

/** Common OpenAI model ids, including namespaced relay aliases. */
export function isOpenAIModel(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const id = value.toLowerCase().replace(/^openai[/:]/, '')
  return /^(?:gpt(?:-|\d)|chatgpt(?:-|\d)|o\d+(?:-|$)|codex(?:-|$)|(?:text|code)-(?:davinci|curie|babbage|ada)(?:-|$)|(?:davinci|babbage)-\d)/.test(id)
}

export function registerTccxyOptimization(registry: ProviderOptimizationRegistry, apiBase = TCCXY_API_BASE): () => void {
  return registry.register({
    id: 'tccxy-openai-reasoning-context',
    apiBase,
    endpoints: ['chat/completions', 'responses'],
    optimize(body) {
      if (!isOpenAIModel(body.model)) return undefined
      const reasoning = body.reasoning
      if (reasoning !== undefined && (reasoning === null || typeof reasoning !== 'object' || Array.isArray(reasoning))) return undefined
      const options = reasoning as Record<string, unknown> | undefined
      if (options?.context === 'all_turns') return undefined
      // Relay policy overrides a generic last_turn default for every OpenAI model.
      return { ...body, reasoning: { ...options, context: 'all_turns' } }
    },
  })
}

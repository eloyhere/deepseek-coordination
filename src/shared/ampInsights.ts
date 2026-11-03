/** Read-only, session-oriented data for the panel's cognition and knowledge views. */
export interface InsightItem {
  id: string
  title: string
  summary?: string
  status?: string
  source: string
  scope: 'session' | 'workspace' | 'installation'
  updatedAt?: string
  details?: Record<string, unknown>
}

export interface InsightSource {
  available: boolean
  description: string
}

export interface AmpInsightsView {
  session: string
  workspace: { id: string; title: string; path: string } | null
  cognition: InsightItem[]
  capabilities: InsightItem[]
  skills: InsightItem[]
  knowledge: InsightItem[]
  sources: {
    cognition: InsightSource
    capabilities: InsightSource
    skills: InsightSource
    knowledge: InsightSource
  }
  truncated: { cognition: boolean; capabilities: boolean; skills: boolean; knowledge: boolean }
  limit: number
}

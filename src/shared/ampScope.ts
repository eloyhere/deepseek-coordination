import type { ChainEntry, Frame, Receipt } from '../protocol/index.js'
import type { AmpStory } from '../host/amp.js'

export type AmpScope = 'global' | 'default' | 'workspace'
export interface AmpScopeView {
  scope: AmpScope
  workspace: { id: string; title: string; path: string } | null
  sessions: Array<{ id: string; frame: Frame | null; story: AmpStory }>
  /** View entries retain their original sequence/hash; this is not a snapshot. */
  entries: ChainEntry[]
  receipts: Receipt[]
  totalSessions: number
  totalEntries: number
  totalReceipts: number
  /** Global count of entries without unique session attribution; zero in filtered scopes. */
  unassignedEntries: number
  truncated: { sessions: boolean; entries: boolean; receipts: boolean }
  limits: { sessions: number; entries: number; receipts: number }
  verificationScope: 'global'
}

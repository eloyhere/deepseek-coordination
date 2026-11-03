/** Read-only projection of DSH's native, durable subagent roster. */
export interface NativeSubagentsPort {
  listChildren(parentSessionId: string, signal?: AbortSignal): Promise<readonly unknown[]>
  listDescendants?(rootSessionId: string, signal?: AbortSignal): Promise<readonly unknown[]>
}

export interface NativeSubagent {
  id: string
  mode: 'one-shot' | 'continuable'
  activity: 'running' | 'inactive'
  hasChildren: boolean
  label?: string
  parentId?: string
  depth?: number
}

export interface NativeSubagentDiagnostic {
  id: string
  reason: 'corrupt' | 'unsupported' | 'unavailable'
  parentId?: string
  depth?: number
}

export interface NativeSubagentsView {
  available: boolean
  agents: NativeSubagent[]
  diagnostics: NativeSubagentDiagnostic[]
}

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/**
 * DSH owns the lineage. No child id is decoded, and diagnostic rows never
 * masquerade as live agents. A missing service/method is capability absence;
 * real service failures and cancellation propagate to the caller.
 */
export async function listNativeSubagents(
  port: NativeSubagentsPort | undefined,
  actor: string,
  descendants = false,
  signal?: AbortSignal,
): Promise<NativeSubagentsView> {
  if (!nonempty(actor)) throw new TypeError('calling session id is required')
  signal?.throwIfAborted()
  if (port === undefined || typeof port.listChildren !== 'function' || (descendants && typeof port.listDescendants !== 'function')) {
    return { available: false, agents: [], diagnostics: [] }
  }
  // Newer DSH versions return catalog-only direct children. Prefer the classified
  // descendant view and select depth one for a direct roster; never guess activity.
  const useDescendants = typeof port.listDescendants === 'function'
  const rows = await (useDescendants ? port.listDescendants!(actor, signal) : port.listChildren(actor, signal))
  signal?.throwIfAborted()
  if (!Array.isArray(rows)) throw new TypeError('DSH subagent roster must return an array')
  const agents: NativeSubagent[] = []
  const diagnostics: NativeSubagentDiagnostic[] = []
  for (const raw of rows) {
    const row = recordOf(raw)
    if (row === undefined || !nonempty(row.id)) continue
    const lineage = useDescendants && nonempty(row.parentId) && Number.isSafeInteger(row.depth) && (row.depth as number) > 0
      ? { parentId: row.parentId, depth: row.depth as number }
      : {}
    // On a descendant view, a row without a valid parent edge is untrusted.
    if (useDescendants && !('parentId' in lineage)) continue
    if (useDescendants && !descendants && (row.depth !== 1 || row.parentId !== actor)) continue
    if (row.kind === 'diagnostic') {
      if (row.reason === 'corrupt' || row.reason === 'unsupported' || row.reason === 'unavailable') {
        diagnostics.push({ id: row.id, reason: row.reason, ...lineage })
      }
      continue
    }
    if (row.kind !== 'child' || (row.mode !== 'one-shot' && row.mode !== 'continuable') ||
      (row.activity !== 'running' && row.activity !== 'inactive') || typeof row.hasChildren !== 'boolean') continue
    agents.push({
      id: row.id, mode: row.mode, activity: row.activity, hasChildren: row.hasChildren,
      ...(nonempty(row.label) ? { label: row.label } : {}), ...lineage,
    })
  }
  return { available: true, agents, diagnostics }
}

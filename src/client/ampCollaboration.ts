/** Read-only session collaboration projection for the docked panel. */
export interface CollaborationDuty {
  id: string
  ownerSession: string
  assigneeSession: string
  role: string
  responsibilities: string[]
  acceptance: string[]
  status: string
  goal?: string
  plan?: string
  task?: string
  summary?: string
  evidence: string[]
  review?: string
  created: number | null
  updated: number | null
}
export interface CollaborationView { duties: CollaborationDuty[] }

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const list = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string') : []
const stamp = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
const optional = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined

/** Ignore malformed entries and fields instead of rendering unchecked host data. */
export function parseCollaboration(value: unknown): CollaborationView | null {
  const root = record(value)
  if (root === null || !Array.isArray(root.duties)) return null
  return { duties: root.duties.flatMap((value): CollaborationDuty[] => {
    const duty = record(value)
    if (duty === null || !text(duty.id)) return []
    return [{
      id: text(duty.id), ownerSession: text(duty.ownerSession), assigneeSession: text(duty.assigneeSession),
      role: text(duty.role), responsibilities: list(duty.responsibilities), acceptance: list(duty.acceptance),
      status: text(duty.status), evidence: list(duty.evidence), created: stamp(duty.created), updated: stamp(duty.updated),
      ...(optional(duty.goal) ? { goal: optional(duty.goal) } : {}),
      ...(optional(duty.plan) ? { plan: optional(duty.plan) } : {}),
      ...(optional(duty.task) ? { task: optional(duty.task) } : {}),
      ...(optional(duty.summary) ? { summary: optional(duty.summary) } : {}),
      ...(optional(duty.review) ? { review: optional(duty.review) } : {}),
    }]
  }) }
}

export const COLLABORATION_COPY = {
  'zh-CN': {
    title: '协作职责', loading: '正在加载协作职责…', error: '协作数据暂不可用。', empty: '当前会话没有协作职责。', noSession: '请选择会话以查看协作职责。', clearSelection: '查看全部职责',
    owner: '负责人会话', assignee: '受派会话', role: '角色', responsibilities: '职责', acceptance: '验收标准',
    goal: '目标', plan: '计划', task: '任务', summary: '结果摘要', evidence: '证据', review: '审核',
    created: '创建时间', updated: '更新时间',
    statuses: { assigned: '已指派', accepted: '已接受', working: '进行中', submitted: '已提交', verified: '已验证', rejected: '已驳回', cancelled: '已取消' },
  },
  'en-US': {
    title: 'Collaboration duties', loading: 'Loading collaboration duties…', error: 'Collaboration data is unavailable.', empty: 'No collaboration duties for this session.', noSession: 'Select a session to view collaboration duties.', clearSelection: 'Show all duties',
    owner: 'Owner session', assignee: 'Assignee session', role: 'Role', responsibilities: 'Responsibilities', acceptance: 'Acceptance criteria',
    goal: 'Goal', plan: 'Plan', task: 'Task', summary: 'Result summary', evidence: 'Evidence', review: 'Review',
    created: 'Created', updated: 'Updated',
    statuses: { assigned: 'Assigned', accepted: 'Accepted', working: 'Working', submitted: 'Submitted', verified: 'Verified', rejected: 'Rejected', cancelled: 'Cancelled' },
  },
} as const
export type CollaborationCopy = typeof COLLABORATION_COPY['zh-CN'] | typeof COLLABORATION_COPY['en-US']
